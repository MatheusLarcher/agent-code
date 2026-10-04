import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_CALL_HINT, createAppMcpServer, type AppCall } from './appTools'
import { CallIds } from './officeCallRuntime'

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
