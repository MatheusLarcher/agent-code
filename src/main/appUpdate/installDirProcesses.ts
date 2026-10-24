// Processos vivos cujo executável está DENTRO da pasta de instalação do app.
//
// É a conferência que impede o instalador NSIS de encontrar arquivo em uso: no
// modo `--updated` ele espera ~2,6 s, mata só o "Agent Code.exe" e, com
// qualquer outro arquivo preso (postgres.exe, o chrome.exe do Playwright, o
// helper do controle do Windows, claude.exe), aborta a troca da pasta, restaura
// a versão antiga e não reabre o app. Só Windows — o app é Windows.
import { spawn } from 'node:child_process'

export interface InstallDirProcess {
  pid: number
  path: string
}

/** Uma linha por processo, com o caminho do executável (null nos de sistema). */
export const LIST_PROCESSES_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress'

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>

/** Roda um executável e devolve o stdout; código diferente de 0 ou prazo estourado viram erro. */
export function runCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} não respondeu em ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (err += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${file} saiu com código ${code}: ${(err || out).trim().slice(0, 300)}`))
    })
  })
}

/** `powershell.exe -Command`: a política de execução vale para scripts, não para -Command. */
export function runPowerShell(command: string, timeoutMs = 20_000): Promise<string> {
  return runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    timeoutMs
  )
}

function normalizeDir(dir: string): string {
  const text = dir.replace(/\//g, '\\').toLowerCase()
  return text.endsWith('\\') ? text : `${text}\\`
}

/** O arquivo está dentro da pasta (sem diferenciar maiúsculas nem barras)? */
export function isInsideDir(file: string, dir: string): boolean {
  return file.replace(/\//g, '\\').toLowerCase().startsWith(normalizeDir(dir))
}

/** A saída do PowerShell: JSON (lista ou um objeto só), às vezes com BOM; vazia = nenhum. */
export function parseProcessRows(output: string): unknown {
  const text = output.replace(/^﻿/, '').trim()
  return text ? JSON.parse(text) : []
}

const sameFile = (a: string, b: string): boolean => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/**
 * O filtro puro: linhas do PowerShell → processos da pasta de instalação.
 * Fora: o próprio app e todo processo do MESMO executável (os auxiliares do
 * Electron — renderer, GPU, utility — e um MCP rodando com ELECTRON_RUN_AS_NODE):
 * saem junto com o app, e o que sobrar o instalador encerra pelo nome da imagem
 * (`taskkill /IM "Agent Code.exe"`). O que importa aqui é o resto: postgres.exe,
 * chrome.exe, o helper do controle do Windows, claude.exe.
 */
export function filterInstallDirProcesses(
  rows: unknown,
  installRoot: string,
  selfPid: number,
  selfExecutable: string | null = null
): InstallDirProcess[] {
  const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? [rows] : []
  const found: InstallDirProcess[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const { ProcessId, ExecutablePath } = row as { ProcessId?: unknown; ExecutablePath?: unknown }
    if (typeof ProcessId !== 'number' || !Number.isInteger(ProcessId) || ProcessId === selfPid) continue
    if (typeof ExecutablePath !== 'string' || !ExecutablePath) continue
    if (!isInsideDir(ExecutablePath, installRoot)) continue
    if (selfExecutable && sameFile(ExecutablePath, selfExecutable)) continue
    found.push({ pid: ProcessId, path: ExecutablePath })
  }
  return found
}

export async function listInstallDirProcesses(
  installRoot: string,
  selfPid: number,
  selfExecutable: string | null = null,
  run: (command: string) => Promise<string> = runPowerShell,
  platform: NodeJS.Platform = process.platform
): Promise<InstallDirProcess[]> {
  if (platform !== 'win32') throw new Error('A conferência de processos só existe no Windows.')
  const output = await run(LIST_PROCESSES_COMMAND)
  let rows: unknown
  try {
    rows = parseProcessRows(output)
  } catch (error) {
    throw new Error(`Saída do PowerShell ilegível: ${error instanceof Error ? error.message : String(error)}`)
  }
  return filterInstallDirProcesses(rows, installRoot, selfPid, selfExecutable)
}

/** `taskkill /PID <pid> /T /F`: o processo e a árvore dele. */
export async function killProcessTree(pid: number, run: CommandRunner = runCommand): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`PID inválido: ${pid}`)
  await run('taskkill', ['/PID', String(pid), '/T', '/F'], 10_000)
}
