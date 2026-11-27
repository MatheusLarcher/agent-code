import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * `app_rodar_como_admin`: roda um script PowerShell elevado (UMA confirmação do
 * UAC) e devolve a saída ao agente, em vez de pedir ao usuário que rode e cole.
 * Um PowerShell comum (o lançador) chama `Start-Process -Verb RunAs -Wait` num
 * wrapper que redireciona tudo (*>&1) para um arquivo; o lançador nunca vê a
 * saída do elevado, por isso o arquivo.
 */

export const ADMIN_RUN_TOOL = 'app_rodar_como_admin'
export const ADMIN_SCRIPT_MAX = 20_000
export const ADMIN_OUTPUT_MAX = 30_000
export const ADMIN_TIMEOUT_DEFAULT_S = 120
export const ADMIN_TIMEOUT_MAX_S = 600
/** ERROR_CANCELLED: o usuário clicou "Não" no UAC. */
export const UAC_CANCELLED_EXIT = 1223

export const ADMIN_RUN_DESCRIPTION =
  'Roda um script PowerShell como administrador neste Windows e devolve a saída para você. ' +
  'Use esta ferramenta NO LUGAR de pedir ao usuário que abra o PowerShell como administrador, rode um comando e cole o resultado. ' +
  'Cada chamada mostra UMA confirmação do Windows (UAC) ao usuário: junte tudo o que precisa num único script ' +
  '(ex.: SMART, serviços e disco de uma vez) em vez de várias chamadas. ' +
  'Se o usuário recusar a confirmação, não tente de novo sem ele pedir. Só Windows.'

export const adminRunSchema = {
  script: z.string().trim().min(1).max(ADMIN_SCRIPT_MAX).describe('Script PowerShell completo. Tudo o que ele escrever (saída, erros, avisos) volta para você.'),
  motivo: z.string().trim().min(1).max(500).describe('Por que precisa de administrador, em uma frase simples para o usuário.'),
  timeout_s: z.number().int().min(5).max(ADMIN_TIMEOUT_MAX_S).optional().describe(`Tempo máximo em segundos (padrão ${ADMIN_TIMEOUT_DEFAULT_S}).`)
}

export interface AdminRunInput {
  script: string
  motivo: string
  timeout_s?: number
}

export interface AdminRunReply {
  ok: boolean
  text: string
}

export interface ExecResult {
  code: number | null
  stderr: string
  timedOut: boolean
}

export interface AdminRunDeps {
  platform: NodeJS.Platform
  /** Roda o lançador (powershell.exe + args) e espera; nunca lança. */
  exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>
  /** Onde criar a pasta temporária de cada chamada. */
  tmpRoot: string
}

/** Literal PowerShell entre aspas simples (aspas simples dobradas). */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** O wrapper que roda elevado: executa o script e grava tudo, em UTF-8, no arquivo de saída. */
export function buildWrapper(scriptPath: string, outPath: string): string {
  const out = psQuote(outPath)
  return [
    '$ErrorActionPreference = \'Continue\'',
    `try { & ${psQuote(scriptPath)} *>&1 | Out-String -Stream -Width 4096 | Out-File -LiteralPath ${out} -Encoding utf8 }`,
    `catch { $_ | Out-String -Width 4096 | Out-File -LiteralPath ${out} -Encoding utf8 -Append }`
  ].join('\r\n')
}

/** O lançador (não elevado): pede o UAC, espera o wrapper e traduz a recusa em exit 1223. */
export function buildLauncher(wrapperPath: string): string {
  // Start-Process junta o ArgumentList com espaços, sem aspas: o caminho vai entre aspas duplas.
  const file = psQuote(`"${wrapperPath}"`)
  return [
    '$ErrorActionPreference = \'Stop\'',
    'try {',
    `  Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${file}`,
    '  exit 0',
    '} catch {',
    '  $m = $_.Exception.Message',
    // A mensagem vem no idioma do Windows ("canceled"/"cancelada"); o código 1223 quando existir.
    `  if ($_.Exception.InnerException.NativeErrorCode -eq ${UAC_CANCELLED_EXIT} -or $m -match 'cancel') { exit ${UAC_CANCELLED_EXIT} }`,
    '  [Console]::Error.Write($m)',
    '  exit 1',
    '}'
  ].join('\r\n')
}

/** Args do powershell.exe do lançador: -EncodedCommand (UTF-16LE em base64) evita qualquer problema de aspas. */
export function launcherArgs(wrapperPath: string): string[] {
  const encoded = Buffer.from(buildLauncher(wrapperPath), 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/** Os últimos `max` caracteres, avisando quando cortou. */
export function capOutput(raw: string, max = ADMIN_OUTPUT_MAX): string {
  const s = raw.replace(/^﻿/, '').replace(/\s+$/, '')
  if (!s) return '(o script não escreveu nada)'
  if (s.length <= max) return s
  return `[saída cortada: mostrando os últimos ${max} de ${s.length} caracteres]\n${s.slice(-max)}`
}

const defaultExec: AdminRunDeps['exec'] = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
        timedOut: Boolean(e?.killed)
      })
    })
  })

const DEFAULT_DEPS: AdminRunDeps = { platform: process.platform, exec: defaultExec, tmpRoot: tmpdir() }

export async function runAsAdmin(input: AdminRunInput, deps: AdminRunDeps = DEFAULT_DEPS): Promise<AdminRunReply> {
  if (deps.platform !== 'win32') {
    return { ok: false, text: 'app_rodar_como_admin só funciona no Windows; este computador usa outro sistema.' }
  }
  const timeoutS = Math.min(input.timeout_s ?? ADMIN_TIMEOUT_DEFAULT_S, ADMIN_TIMEOUT_MAX_S)
  const dir = await mkdtemp(join(deps.tmpRoot, 'agent-code-admin-'))
  const scriptPath = join(dir, 'script.ps1')
  const wrapperPath = join(dir, 'wrapper.ps1')
  const outPath = join(dir, 'saida.txt')
  try {
    // BOM: o PowerShell 5.1 lê .ps1 sem BOM como ANSI e estraga os acentos.
    await writeFile(scriptPath, `﻿${input.script}`, 'utf8')
    await writeFile(wrapperPath, `﻿${buildWrapper(scriptPath, outPath)}`, 'utf8')
    const r = await deps.exec('powershell.exe', launcherArgs(wrapperPath), timeoutS * 1000)
    const output = await readFile(outPath, 'utf8').catch(() => '')
    if (r.timedOut) {
      // O processo elevado não pode ser encerrado daqui (sem permissão): pode seguir rodando.
      return { ok: false, text: `Tempo esgotado (${timeoutS} s). O script pode continuar rodando como administrador. Saída até agora:\n${capOutput(output)}` }
    }
    if (r.code === UAC_CANCELLED_EXIT) {
      return { ok: false, text: 'O usuário recusou a confirmação de administrador do Windows. Não tente de novo sem ele pedir; pergunte como prefere seguir.' }
    }
    if (r.code !== 0) {
      return { ok: false, text: `Não foi possível rodar como administrador: ${r.stderr.trim() || `código ${r.code}`}` }
    }
    return { ok: true, text: capOutput(output) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
