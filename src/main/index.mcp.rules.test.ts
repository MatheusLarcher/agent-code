import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// Mocks do Electron e das dependências do index.ts, compartilhados com index.test.ts.
import { callIpc as call, sessionsOf, spy } from './testing/electronMocks'

const { Channels } = await import('../shared/ipc')
const { MCP_TASK_GONE_MARK } = await import('../shared/mcpInbound')
const { registerIpc, mcpInbound } = await import('./index')
const { saveAttachments } = await import('./attachments')

const send = (conv: string, text: string, taskId?: string, files: unknown[] = [], kind?: string): Promise<unknown> =>
  call(Channels.agentSend, conv, text, [], files, [], undefined, kind, taskId)
const injectNow = (conv: string, text: string, taskId?: string): Promise<unknown> =>
  call(Channels.agentInjectNow, conv, text, [], [], [], undefined, taskId)

describe('registerIpc — regras do MCP de entrada (recusa, sem retomada)', () => {
  const cwd = tmpdir()
  const file = { name: 'a.txt', mimeType: 'text/plain', data: 'eA==' }
  const config = (conv: string): void => mcpInbound.registry.setConfig(conv, { cliente: 'Forgia', mcpServers: {} })

  beforeAll(() => registerIpc())

  it('limite de uso no turno da tarefa gpt: tarefa em erro; a retomada é recusada e nada sobe em outro modelo', async () => {
    const conv = 'regra2-limite'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5' })
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    await send(conv, 'T', t.id)
    const task = sessionsOf(conv).at(-1)!
    expect(task.opts.model).toBe('gpt-6-sol')
    task.emit({ kind: 'error', id: 'e', text: 'Claude usage limit reached', usageExhausted: true, retryable: false })
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: 'Claude usage limit reached' })
    const before = spy.sessions.length
    await expect(send(conv, 'Continue', undefined, [], 'recovery')).rejects.toThrow(MCP_TASK_GONE_MARK)
    expect(spy.sessions.length).toBe(before)
    expect(sessionsOf(conv).filter((s) => s.opts.model !== 'gpt-6-sol' && s.send.mock.calls.length > 0)).toEqual([])
  })

  it('fila restaurada depois de reiniciar (id desconhecido): agent:send recusa antes de gravar, anunciar ou subir sessão', async () => {
    const conv = 'regra1-reiniciado'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5' })
    const [live] = sessionsOf(conv)
    vi.mocked(saveAttachments).mockClear()
    for (const fn of Object.values(spy.note)) fn.mockClear()
    const before = spy.sessions.length
    await expect(send(conv, 'faça a peça', 't-de-antes-de-reiniciar', [file])).rejects.toThrow(MCP_TASK_GONE_MARK)
    expect(spy.sessions.length).toBe(before)
    expect(saveAttachments).not.toHaveBeenCalled()
    for (const fn of Object.values(spy.note)) expect(fn).not.toHaveBeenCalled()
    expect(live.send).not.toHaveBeenCalled()
    // A mensagem do usuário (sem id) segue normal.
    await send(conv, 'faça a peça')
    expect(live.send).toHaveBeenCalledTimes(1)
  })

  it('"agora" com id morto (tarefa terminada ou desconhecida): gone, nada entra no turno', async () => {
    const conv = 'regra1-agora'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5' })
    config(conv)
    const [live] = sessionsOf(conv)
    const t = mcpInbound.registry.create(conv, 'ajuste', 'claude-opus-5-5')
    mcpInbound.registry.cancel(t.id)
    expect(await injectNow(conv, 'ajuste', t.id)).toMatchObject({ ok: false, gone: true, reason: expect.stringContaining(MCP_TASK_GONE_MARK) })
    expect(await injectNow(conv, 'ajuste', 't-desconhecido')).toMatchObject({ ok: false, gone: true })
    expect(live.injectNow).not.toHaveBeenCalled()
    // Sem id (mensagem do usuário): o "agora" de sempre.
    expect(await injectNow(conv, 'ajuste')).toEqual({ ok: true })
  })
})
