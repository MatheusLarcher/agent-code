import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_OUTPUT_MAX, UAC_CANCELLED_EXIT, buildLauncher, buildWrapper, capOutput, launcherArgs, psQuote, runAsAdmin,
  type AdminRunDeps, type ExecResult
} from './adminRun'

let tmpRoot: string
beforeEach(() => { tmpRoot = mkdtempSync(path.join(tmpdir(), 'admin-run-test-')) })
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** Decodifica o -EncodedCommand e devolve o caminho do wrapper que o lançador vai elevar. */
function wrapperFromArgs(args: string[]): string {
  const launcher = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  return /'-File','"(.+?)"'/.exec(launcher)![1].replace(/''/g, "'")
}
/** O arquivo de saída que o wrapper grava (o primeiro -LiteralPath). */
const outFromWrapper = (wrapper: string): string => /-LiteralPath '(.+?)' -Encoding/.exec(readFileSync(wrapper, 'utf8'))![1].replace(/''/g, "'")

/** Um exec falso: simula o elevado gravando `output` no arquivo de saída, sem UAC de verdade. */
function fakeExec(result: Partial<ExecResult>, output?: string): AdminRunDeps['exec'] & { calls: Array<{ file: string; args: string[]; timeoutMs: number; script: string }> } {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number; script: string }> = []
  const exec = async (file: string, args: string[], timeoutMs: number): Promise<ExecResult> => {
    const wrapper = wrapperFromArgs(args)
    calls.push({ file, args, timeoutMs, script: readFileSync(path.join(path.dirname(wrapper), 'script.ps1'), 'utf8') })
    if (output !== undefined) writeFileSync(outFromWrapper(wrapper), output, 'utf8')
    return { code: 0, stderr: '', timedOut: false, ...result }
  }
  return Object.assign(exec, { calls })
}
const deps = (exec: AdminRunDeps['exec'], platform: NodeJS.Platform = 'win32'): AdminRunDeps => ({ platform, exec, tmpRoot })

describe('montagem do comando', () => {
  it('psQuote dobra aspas simples', () => {
    expect(psQuote("C:\\Users\\O'Neil\\a b.ps1")).toBe("'C:\\Users\\O''Neil\\a b.ps1'")
  })

  it('lançador: RunAs, espera, janela oculta, -File com o caminho entre aspas duplas; recusa vira 1223', () => {
    const l = buildLauncher("C:\\Temp\\d'x\\wrapper.ps1")
    expect(l).toContain("Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden")
    expect(l).toContain("-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"C:\\Temp\\d''x\\wrapper.ps1\"'")
    expect(l).toMatch(/-match 'cancel'\) \{ exit 1223 \}/)
    expect(l).toContain('NativeErrorCode -eq 1223')
  })

  it('args: powershell não interativo com -EncodedCommand em UTF-16LE (sem problema de aspas)', () => {
    const args = launcherArgs('C:\\a b\\w.ps1')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toBe(buildLauncher('C:\\a b\\w.ps1'))
  })

  it('wrapper: roda o script com *>&1 e grava UTF-8 no arquivo de saída, inclusive o erro que interrompe', () => {
    const w = buildWrapper('C:\\t\\script.ps1', 'C:\\t\\saida.txt')
    expect(w).toContain("& 'C:\\t\\script.ps1' *>&1 | Out-String -Stream -Width 4096 | Out-File -LiteralPath 'C:\\t\\saida.txt' -Encoding utf8")
    expect(w).toMatch(/catch \{ \$_ .*-Append/)
  })
})

describe('capOutput', () => {
  it('tira BOM e espaço final; vazio avisa; longo fica com o fim e diz que cortou', () => {
    expect(capOutput('\uFEFFolá\r\n\r\n')).toBe('olá')
    expect(capOutput('  \r\n')).toBe('(o script não escreveu nada)')
    const long = 'Q'.repeat(10) + 'b'.repeat(ADMIN_OUTPUT_MAX)
    const c = capOutput(long)
    expect(c).toMatch(/^\[saída cortada: mostrando os últimos 30000 de 30010 caracteres\]\n/)
    expect(c.endsWith('b'.repeat(ADMIN_OUTPUT_MAX))).toBe(true)
    expect(c).not.toContain('Q')
  })
})

describe('runAsAdmin', () => {
  it('fora do Windows: erro claro, sem rodar nada', async () => {
    const exec = fakeExec({})
    const r = await runAsAdmin({ script: 'x', motivo: 'm' }, deps(exec, 'linux'))
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/só funciona no Windows/)
    expect(exec.calls).toHaveLength(0)
  })

  it('sucesso: grava o script com BOM, roda o lançador com o timeout padrão, devolve a saída e apaga a pasta', async () => {
    const exec = fakeExec({}, '\uFEFFDisco OK\r\nSMART: saudável\r\n')
    const r = await runAsAdmin({ script: "Get-PhysicalDisk # ação", motivo: 'diagnóstico' }, deps(exec))
    expect(r).toEqual({ ok: true, text: 'Disco OK\r\nSMART: saudável' })
    expect(exec.calls[0].file).toBe('powershell.exe')
    expect(exec.calls[0].timeoutMs).toBe(120_000)
    expect(exec.calls[0].script).toBe('\uFEFFGet-PhysicalDisk # ação')
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('timeout_s vira o timeout do processo', async () => {
    const exec = fakeExec({}, 'ok')
    await runAsAdmin({ script: 'x', motivo: 'm', timeout_s: 30 }, deps(exec))
    expect(exec.calls[0].timeoutMs).toBe(30_000)
  })

  it('UAC recusado (exit 1223): diz que o usuário recusou e para não insistir', async () => {
    const r = await runAsAdmin({ script: 'x', motivo: 'm' }, deps(fakeExec({ code: UAC_CANCELLED_EXIT })))
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/recusou/)
    expect(r.text).toMatch(/Não tente de novo/)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('tempo esgotado: devolve a saída parcial e avisa que pode seguir rodando', async () => {
    const r = await runAsAdmin({ script: 'x', motivo: 'm', timeout_s: 5 }, deps(fakeExec({ code: null, timedOut: true }, 'parte 1')))
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/^Tempo esgotado \(5 s\)/)
    expect(r.text).toContain('parte 1')
  })

  it('outra falha do lançador: devolve a mensagem do erro', async () => {
    const r = await runAsAdmin({ script: 'x', motivo: 'm' }, deps(fakeExec({ code: 1, stderr: 'O sistema não encontrou o arquivo' })))
    expect(r).toEqual({ ok: false, text: 'Não foi possível rodar como administrador: O sistema não encontrou o arquivo' })
  })

  it('saída grande é cortada no fim; sem arquivo de saída avisa que nada foi escrito', async () => {
    const big = await runAsAdmin({ script: 'x', motivo: 'm' }, deps(fakeExec({}, 'z'.repeat(ADMIN_OUTPUT_MAX + 5))))
    expect(big.ok).toBe(true)
    expect(big.text).toMatch(/^\[saída cortada/)
    const none = await runAsAdmin({ script: 'x', motivo: 'm' }, deps(fakeExec({})))
    expect(none).toEqual({ ok: true, text: '(o script não escreveu nada)' })
  })

  it('a pasta temporária é apagada mesmo quando o exec lança', async () => {
    const exec = async (): Promise<ExecResult> => { throw new Error('spawn falhou') }
    await expect(runAsAdmin({ script: 'x', motivo: 'm' }, deps(exec))).rejects.toThrow('spawn falhou')
    expect(existsSync(tmpRoot) && readdirSync(tmpRoot)).toEqual([])
  })
})
