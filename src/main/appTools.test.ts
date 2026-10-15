import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_CALL_HINT, createAppMcpServer, type AppCall } from './appTools'
import { CallIds } from './officeCallRuntime'
import type { GhidraDetect, GhidraPreparer, GhidraStatus } from './ghidra/ghidraEnv'

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
type Registered = Record<string, { handler?: Handler; callback?: Handler; inputSchema?: { safeParse(v: unknown): { success: boolean } } }>
const toolsOf = (s: unknown): Registered => (s as { instance: { _registeredTools: Registered } }).instance._registeredTools
const run = (t: Registered[string], args: Record<string, unknown>) => (t.handler ?? t.callback)!(args, {})

let root: string
let cwd: string
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'app-call-'))
  cwd = path.join(root, 'proj')
  mkdirSync(path.join(cwd, 'mockups'), { recursive: true })
  writeFileSync(path.join(cwd, 'mockups', 'tela.html'), '<title>Tela</title>')
  writeFileSync(path.join(root, 'fora.html'), '<p>')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('servidor MCP app: app_chamar_usuario', () => {
  it('existe em toda sessão; o app_restart só com o coordenador', () => {
    expect(Object.keys(toolsOf(createAppMcpServer({ cwd })))).toEqual(['app_chamar_usuario'])
    expect(Object.keys(toolsOf(createAppMcpServer({ cwd, restart: () => ({ ok: true }) as never })))).toEqual(['app_restart', 'app_chamar_usuario'])
    expect(APP_CALL_HINT).toContain('app_chamar_usuario')
    expect(APP_CALL_HINT).toMatch(/does not wait/i)
  })

  it('o schema: arquivo .html/.htm obrigatório; mensagem curta e opcional', () => {
    const schema = toolsOf(createAppMcpServer({ cwd })).app_chamar_usuario.inputSchema!
    expect(schema.safeParse({ arquivo: 'a.html' }).success).toBe(true)
    expect(schema.safeParse({ arquivo: 'a.htm', mensagem: 'veja' }).success).toBe(true)
    expect(schema.safeParse({ arquivo: 'a.css' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ arquivo: 'a.html', mensagem: 'x'.repeat(281) }).success).toBe(false)
  })

  it('devolve "ok" na hora e avisa com o id anotado; recusa fora do cwd e arquivo que não existe (e gasta o id)', async () => {
    const calls: AppCall[] = []
    const ids = new CallIds()
    const t = toolsOf(createAppMcpServer({ cwd, callId: (a) => ids.take(a), onCall: (c) => calls.push(c) })).app_chamar_usuario
    ids.note({ arquivo: 'mockups/tela.html' }, 'toolu_1')
    const ok = await run(t, { arquivo: 'mockups/tela.html', mensagem: 'dá uma olhada' })
    expect(ok).toMatchObject({ isError: false, content: [{ text: 'ok' }] })
    expect(calls).toEqual([{ id: 'toolu_1', path: path.join(cwd, 'mockups', 'tela.html'), mensagem: 'dá uma olhada' }])
    ids.note({ arquivo: path.join(root, 'fora.html') }, 'toolu_2')
    for (const arquivo of [path.join(root, 'fora.html'), 'sumiu.html']) {
      const r = await run(t, { arquivo })
      expect(r.isError, arquivo).toBe(true)
      expect(r.content[0].text).toMatch(/^Recusado/)
    }
    expect(calls).toHaveLength(1)
    expect(ids.take(path.join(root, 'fora.html'))).toBeNull()
  })

  it('o aviso que falha não derruba a ferramenta', async () => {
    const t = toolsOf(createAppMcpServer({ cwd, onCall: vi.fn(() => { throw new Error('sem ponte') }) })).app_chamar_usuario
    expect((await run(t, { arquivo: path.join(cwd, 'mockups', 'tela.html') })).isError).toBe(false)
  })
})

describe('servidor MCP app: ler_pdf', () => {
  it('só existe com readPdf (sessão DeepSeek); arquivo inexistente vira isError', async () => {
    expect(Object.keys(toolsOf(createAppMcpServer({ cwd })))).not.toContain('ler_pdf')
    const t = toolsOf(createAppMcpServer({ cwd, readPdf: true })).ler_pdf
    expect(t.inputSchema!.safeParse({ arquivo: 'a.pdf', pages: '1-5' }).success).toBe(true)
    expect(t.inputSchema!.safeParse({}).success).toBe(false)
    const r = await run(t, { arquivo: 'sumiu.pdf' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/não encontrado/)
  })
})

describe('servidor MCP app: app_postgres_nuvem', () => {
  it('só existe com o handler (fora do Agent Manager); a resposta de recusa vira isError', async () => {
    expect(Object.keys(toolsOf(createAppMcpServer({ cwd })))).not.toContain('app_postgres_nuvem')
    const handler = vi.fn(async () => ({ ok: false, text: "'manter' é obrigatório" }))
    const t = toolsOf(createAppMcpServer({ cwd, postgresCloud: handler })).app_postgres_nuvem
    expect(t.inputSchema!.safeParse({ acao: 'ligar', manter: 'nuvem' }).success).toBe(true)
    expect(t.inputSchema!.safeParse({ acao: 'apagar' }).success).toBe(false)
    expect(t.inputSchema!.safeParse({ acao: 'ligar', manter: 'os-dois' }).success).toBe(false)
    const reply = await run(t, { acao: 'ligar' })
    expect(handler).toHaveBeenCalledWith({ acao: 'ligar' })
    expect(reply).toMatchObject({ isError: true, content: [{ text: "'manter' é obrigatório" }] })
  })
})

describe('servidor MCP app: app_preparar_ghidra', () => {
  const pronto: GhidraDetect = { installDir: 'C:\\local\\ghidra', ghidraReady: true, version: '12.1.4', javaReady: true, javaHome: 'C:\\jdk', javaMajor: 21, envGhidraDir: null }
  const faltando: GhidraDetect = { ...pronto, ghidraReady: false, version: null }
  const fake = (status: GhidraStatus, detect: GhidraDetect = faltando) =>
    ({ status: () => status, detect: async () => detect, start: vi.fn<() => void>() }) satisfies GhidraPreparer
  const idle: GhidraStatus = { state: 'idle', progress: null, error: null, result: null }
  const tool = (ghidra: GhidraPreparer, reconnectRea?: () => Promise<void>) =>
    toolsOf(createAppMcpServer({ cwd, ghidra, reconnectRea })).app_preparar_ghidra

  it('só existe com o preparador (onde o rea roda); a descrição diz quando chamar e o tamanho', () => {
    expect(Object.keys(toolsOf(createAppMcpServer({ cwd })))).not.toContain('app_preparar_ghidra')
    const t = toolsOf(createAppMcpServer({ cwd, ghidra: fake(idle) })) as unknown as Record<string, { description?: string }>
    expect(t.app_preparar_ghidra.description).toMatch(/missing_analysis_engine/)
    expect(t.app_preparar_ghidra.description).toMatch(/800 MB/)
    expect(t.app_preparar_ghidra.description).toMatch(/returns immediately/i)
  })

  it('ocioso e faltando → dispara em segundo plano e responde na hora', async () => {
    const g = fake(idle)
    const r = await run(tool(g), {})
    expect(g.start).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ isError: false })
    expect(r.content[0].text).toMatch(/^Started/)
  })

  it('já instalado → pronto sem baixar; avisa que vale na próxima conversa sem o reconnect', async () => {
    const g = fake(idle, pronto)
    const r = await run(tool(g), {})
    expect(g.start).not.toHaveBeenCalled()
    expect(r.content[0].text).toMatch(/^Ready: Ghidra 12\.1\.4 at C:\\local\\ghidra/)
    expect(r.content[0].text).toMatch(/new conversation/)
  })

  it('em andamento → progresso; pronto → reconecta o rea quando há o gancho', async () => {
    const rodando = fake({ state: 'running', progress: 'Ghidra 12.1.4: 40% (230/570 MB)', error: null, result: null })
    expect((await run(tool(rodando), {})).content[0].text).toContain('40% (230/570 MB)')
    expect(rodando.start).not.toHaveBeenCalled()
    const reconnect = vi.fn(async () => undefined)
    const r = await run(tool(fake({ state: 'ready', progress: null, error: null, result: pronto }), reconnect), {})
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(r.content[0].text).toMatch(/rea MCP was restarted/)
    const falhou = vi.fn(async () => { throw new Error('x') })
    expect((await run(tool(fake({ state: 'ready', progress: null, error: null, result: pronto }), falhou), {})).content[0].text).toMatch(/new conversation/)
  })

  it('erro → isError; só tenta de novo com retry=true', async () => {
    const g = fake({ state: 'error', progress: null, error: 'SHA-256 do Ghidra não confere', result: null })
    const r = await run(tool(g), {})
    expect(r).toMatchObject({ isError: true })
    expect(r.content[0].text).toContain('SHA-256 do Ghidra não confere')
    expect(g.start).not.toHaveBeenCalled()
    await run(tool(g), { retry: true })
    expect(g.start).toHaveBeenCalledTimes(1)
  })
})

describe('CallIds', () => {
  it('ids por arquivo, na ordem; anotação velha expira', () => {
    let now = 0
    const ids = new CallIds(() => now)
    ids.note({ arquivo: ' a.html ' }, 'x1')
    ids.note({ arquivo: 'a.html' }, 'x2')
    expect(ids.take('a.html')).toBe('x1')
    now = 61_000
    expect(ids.take('a.html')).toBeNull()
    ids.note({ nada: 1 }, 'x3')
    expect(ids.take('')).toBeNull()
  })
})
