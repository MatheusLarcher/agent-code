import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// Os mocks do Electron e das dependências pesadas do index.ts (compartilhados
// com index.mcp.test.ts): tem de vir antes do `import('./index')` abaixo.
import { callIpc as call, handlers, listLlmCalls, listLlmUsageTotals, spy, type CreatedSession } from './testing/electronMocks'

const { AUTO_MODEL, Channels } = await import('../shared/ipc')
const { registerIpc } = await import('./index')
const { resolveAutoStart } = await import('./typesafe')

describe('registerIpc — agent:token-usage:history', () => {
  it('devolve as chamadas e os totais do repositório ativo para o convId pedido', async () => {
    const calls = [{ id: 'c1', convId: 'conv-1' }]
    const totals = [{ convId: 'conv-1', day: '2026-09-19' }]
    listLlmCalls.mockResolvedValueOnce(calls)
    listLlmUsageTotals.mockResolvedValueOnce(totals)

    registerIpc()
    const handler = handlers.get(Channels.tokenUsageHistory)
    expect(handler).toBeTypeOf('function')

    const result = await handler!(null, 'conv-1')

    expect(listLlmCalls).toHaveBeenCalledWith('conv-1')
    expect(listLlmUsageTotals).toHaveBeenCalledWith('conv-1')
    expect(result).toEqual({ calls, totals })
  })
})

describe('registerIpc — conversation:suggestTitle', () => {
  it('registra o canal; payload inválido volta { ok: false } sem chamar o modelo', async () => {
    registerIpc()
    const handler = handlers.get(Channels.conversationSuggestTitle)
    expect(handler).toBeTypeOf('function')
    for (const bad of [undefined, { text: 1 }, { text: '   ' }, { text: 'x', extra: 1 }]) {
      await expect(Promise.resolve(handler!(null, bad))).resolves.toEqual({ ok: false })
    }
  })
})

describe('registerIpc — conversa do Agent Manager (opts.planning)', () => {
  const cwd = tmpdir()
  const event = { kind: 'result', id: 'r1', isError: false, text: 'ok', durationMs: 1 }
  const sessionOf = (convId: string): CreatedSession => spy.sessions.filter((s) => s.opts.convId === convId).at(-1)!
  const observers = (): ReturnType<typeof vi.fn>[] => [...Object.values(spy.observe), ...Object.values(spy.note)]

  beforeAll(() => registerIpc())

  it('agent:start resolve modelo/esforço pelo planejamento e NÃO passa pelo Automático da conversa', async () => {
    vi.mocked(resolveAutoStart).mockClear()
    spy.planningConfig = { model: 'claude-opus-5-5', effort: 'high' }
    const result = await call(Channels.agentStart, { convId: 'plan-1', cwd, model: AUTO_MODEL, planning: { slug: 'checkout' } })
    expect(result).toEqual({ ok: true, claudeAccountId: 'default' })
    expect(resolveAutoStart).not.toHaveBeenCalled()
    expect(sessionOf('plan-1').opts).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', planning: { slug: 'checkout' } })
  })

  it('a conversa do Manager não alimenta vigia, quadro, PO nem memorista', async () => {
    for (const fn of observers()) fn.mockClear()
    await call(Channels.agentStart, { convId: 'plan-2', cwd, model: 'claude-sonnet-5-5', planning: { slug: 'checkout' } })
    const session = sessionOf('plan-2')
    session.emit(event)
    await call(Channels.agentSend, 'plan-2', 'separa as etapas')
    for (const fn of observers()) expect(fn).not.toHaveBeenCalled()
    // A mensagem segue para a sessão normalmente.
    expect(session.send).toHaveBeenCalled()
  })

  it('regressão: conversa comum alimenta os quatro no tee e os três no agent:send', async () => {
    for (const fn of observers()) fn.mockClear()
    await call(Channels.agentStart, { convId: 'comum', cwd, model: 'claude-sonnet-5-5' })
    sessionOf('comum').emit(event)
    await call(Channels.agentSend, 'comum', 'corrige o bug')
    expect(spy.observe.vigia).toHaveBeenCalledWith('comum', event)
    expect(spy.observe.board).toHaveBeenCalledWith('comum', cwd, event)
    expect(spy.observe.po).toHaveBeenCalledWith('comum', event)
    expect(spy.observe.memorista).toHaveBeenCalledWith('comum', event)
    expect(spy.note.vigia).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
    expect(spy.note.po).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
    expect(spy.note.memorista).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
    // A promoção determinística do quadro nasce no mesmo marco.
    expect(spy.note.board).toHaveBeenCalledWith('comum', cwd)
  })

  it('agent:dispose limpa a conversa do registro de planejamento', async () => {
    await call(Channels.agentStart, { convId: 'plan-3', cwd, model: 'claude-sonnet-5-5', planning: { slug: 'checkout' } })
    await call(Channels.agentDispose, 'plan-3')
    for (const fn of observers()) fn.mockClear()
    // Sem sessão viva o envio é recusado com erro claro (nunca "enviado" a ninguém).
    await expect(call(Channels.agentSend, 'plan-3', 'oi')).rejects.toThrow(/sem-sessao-viva/)
    expect(spy.note.vigia).not.toHaveBeenCalled()
    // Mesmo id reaproveitado depois do descarte, reconectado: já não é mais do Manager.
    await call(Channels.agentStart, { convId: 'plan-3', cwd, model: 'claude-sonnet-5-5' })
    await call(Channels.agentSend, 'plan-3', 'oi')
    expect(spy.note.vigia).toHaveBeenCalledWith('plan-3', cwd, 'oi')
  })

  it('slug inválido é recusado na fronteira, sem criar sessão', async () => {
    const before = spy.sessions.length
    await expect(
      call(Channels.agentStart, { convId: 'plan-x', cwd, model: 'claude-sonnet-5-5', planning: { slug: '../fora' } })
    ).rejects.toThrow(/slug do planejamento inválido/)
    expect(spy.sessions.length).toBe(before)
  })
})
