// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ProviderFailoverSession, FAILOVER_CONTINUATION } from './providerFailover'
import { isUsageExhausted, sdkUsageExhausted } from './providerQuota'
import type { ChatEvent, StartAgentOptions } from '../shared/ipc'

const quota: ChatEvent = { kind: 'result', id: 'quota', isError: true, usageExhausted: true, text: 'limit', durationMs: 1 }
const done: ChatEvent = { kind: 'result', id: 'done', isError: false, text: 'done', durationMs: 1 }

function harness(model = 'claude-opus-5-5') {
  const records: Array<{ options: StartAgentOptions; event: (event: ChatEvent) => void; finish: () => void; session: ReturnType<typeof stub> }> = []
  const emit = vi.fn()
  const complete = vi.fn()
  const available = vi.fn(async () => true)
  const factory = vi.fn((options: StartAgentOptions, event: (event: ChatEvent) => void, finish: () => void) => {
    const session = stub()
    records.push({ options, event, finish, session })
    return session
  })
  const session = new ProviderFailoverSession({ convId: 'chat', cwd: '/project', model, effort: 'max', economyMode: true }, factory, emit, available, complete)
  return { session, records, emit, complete, available }
}
function stub() {
  return {
    start: vi.fn(async () => true), send: vi.fn(async (..._args: unknown[]) => {}),
    dispose: vi.fn(), interrupt: vi.fn(async () => ({ stillQueued: [] })),
    setBypass: vi.fn(), resolvePermission: vi.fn(), holdQuestion: vi.fn(() => null), refreshUsage: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}), resumeAfterQuota: vi.fn(async () => 'durable-session'),
    continuationState: vi.fn(() => ({ approvedTools: ['Write'], loopActive: true, loopCycles: 7, loopLimit: 100, loopScheduledThisIteration: false })),
    restoreContinuation: vi.fn()
  }
}
const settled = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }

describe('provider failover', () => {
  it.each([['claude-opus-5-5', 'gpt-6.1-sol'], ['gpt-6-astra', 'claude-opus-5-5']])('continues %s on %s exactly once with the same transcript', async (from, to) => {
    const h = harness(from)
    await h.session.start()
    await h.session.send('Crie um arquivo', [{ data: 'image', mediaType: 'image/png' }], 'user-id')
    h.records[0].event({ kind: 'assistant-text', id: 'partial', text: 'Arquivo criado.', final: false })
    h.records[0].event(quota)
    h.records[0].finish()
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.records[1].options).toMatchObject({ model: to, resume: 'durable-session', cwd: '/project', economyMode: true, effort: 'max' })
    expect(h.records[1].session.send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    expect(h.records[1].session.restoreContinuation).toHaveBeenCalledWith(expect.objectContaining({ approvedTools: ['Write'], loopCycles: 7, loopLimit: 100 }), true)
    expect(h.emit.mock.calls.map(([e]) => e.kind)).toEqual(['assistant-text', 'provider-switch'])
    expect(h.complete).not.toHaveBeenCalled()
    h.records[1].event(done)
    h.records[1].finish()
    expect(h.complete).toHaveBeenCalledTimes(1)
    h.session.dispose()
  })

  it('stops after both quotas and ignores duplicate/stale terminals', async () => {
    const h = harness()
    h.records[0].event(quota)
    h.records[0].event(quota)
    await settled()
    h.records[1].event(quota)
    h.records[1].finish()
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', retryable: false, text: expect.stringContaining('Claude e GPT') }))
    expect(h.complete).toHaveBeenCalledTimes(1)
  })

  it('handles a quota arriving before the replacement send has returned', async () => {
    const h = harness()
    h.records[0].event(quota)
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    h.records[1].event(quota)
    await settled()
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', retryable: false }))
  })

  it('leaves unrelated errors alone', async () => {
    const h = harness()
    const error: ChatEvent = { kind: 'error', id: 'network', text: 'network failed' }
    h.records[0].event(error)
    await settled()
    expect(h.available).not.toHaveBeenCalled()
    expect(h.emit).toHaveBeenCalledWith(error)
    expect(h.records).toHaveLength(1)
  })

  it.each(['missing-auth', 'mirror-failure'])('preserves the task when %s blocks handoff', async (failure) => {
    const h = harness()
    if (failure === 'missing-auth') h.available.mockResolvedValue(false)
    else h.records[0].session.resumeAfterQuota.mockRejectedValue(new Error('transcript mirror failed'))
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.records[0].session.dispose).not.toHaveBeenCalled()
    // Sem destino: o terminal de limite original segue (o renderer agenda o
    // retry para o reset), com a explicação. Falha técnica: erro fatal.
    expect(h.emit).toHaveBeenLastCalledWith(failure === 'missing-auth'
      ? expect.objectContaining({ kind: 'result', isError: true, text: expect.stringContaining('não está conectado') })
      : expect.objectContaining({ kind: 'error', retryable: false }))
  })

  it.each(['interrupt', 'dispose'] as const)('%s cancels a pending switch', async (action) => {
    const h = harness()
    let resolve!: (value: boolean) => void
    h.available.mockImplementation(() => new Promise((r) => { resolve = r }))
    h.records[0].event(quota)
    await settled()
    await h.session[action]()
    resolve(true)
    await settled()
    expect(h.records).toHaveLength(1)
    if (action === 'interrupt') expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', isError: false }))
    else expect(h.emit).not.toHaveBeenCalled()
  })

  it('keeps updated permissions and serializes new user messages behind the handoff', async () => {
    const h = harness()
    h.session.setBypass(true)
    h.records[0].event(quota)
    await h.session.send('Agora liste o resultado')
    expect(h.records[1].options.skipPermissions).toBe(true)
    expect(h.records[1].session.send.mock.calls[0][0]).toBe(FAILOVER_CONTINUATION)
    expect(h.records[1].session.send.mock.calls[1][0]).toBe('Agora liste o resultado')
  })
})

describe('tarefa MCP com modelo pedido (pinModel)', () => {
  function withAccounts(target: { to: string; toPct: number; fromPct: number } | null) {
    const records: Array<{ options: StartAgentOptions; event: (event: ChatEvent) => void; session: ReturnType<typeof stub> }> = []
    const emit = vi.fn()
    const available = vi.fn(async () => true)
    const accounts = {
      multiple: () => true, autoEnabled: () => true, turnEndTarget: vi.fn(async () => null),
      exhaustedTarget: vi.fn(async () => target), label: (id: string) => id, changed: vi.fn(), markExhausted: vi.fn()
    }
    const session = new ProviderFailoverSession({ convId: 'chat', cwd: '/p', model: 'claude-sonnet-5-5', claudeAccountId: 'a1' },
      (options, event) => { const s = stub(); records.push({ options, event, session: s }); return s }, emit, available, vi.fn(), accounts)
    return { session, records, emit, available }
  }

  it('troca para outra CONTA Claude com o mesmo modelo continua permitida', async () => {
    const h = withAccounts({ to: 'a2', toPct: 10, fromPct: 100 })
    h.session.pinModel(true)
    await h.session.send('peça')
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.records[1].options).toMatchObject({ model: 'claude-sonnet-5-5', claudeAccountId: 'a2' })
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account-switch', toAccountId: 'a2' }))
  })

  it.each(['claude-sonnet-5-5', 'gpt-6-astra'])('%s: sem conta com folga, NÃO troca de modelo nem de provedor — erro claro', async (model) => {
    const h = model.startsWith('gpt') ? harness(model) : withAccounts(null)
    h.session.pinModel(true)
    await h.session.send('peça')
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.available).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider-switch' }))
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'error', retryable: false, text: expect.stringContaining(`A cota do modelo ${model} acabou`)
    }))
  })

  it('sem modelo pedido (pinModel(false)): a troca de provedor de sempre', async () => {
    const h = harness()
    h.session.pinModel(true)
    h.session.pinModel(false)
    await h.session.send('peça')
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('gpt-6.1-sol')
  })

  it.each([
    ['resultado', (h: ReturnType<typeof harness>) => h.records[0].event(done)],
    ['erro', (h: ReturnType<typeof harness>) => h.records[0].event({ kind: 'error', id: 'e', text: 'falhou', retryable: true })],
    ['cancelamento', (h: ReturnType<typeof harness>) => void h.session.interrupt()]
  ])('o fixado vale só para o turno da tarefa: depois do %s, o turno seguinte (sem refixar) troca como sempre', async (_n, end) => {
    const h = harness()
    h.session.pinModel(true)
    await h.session.send('peça')
    end(h)
    await settled()
    // Turno seguinte que ninguém fixou (ex.: envio sem tarefa): troca de provedor de sempre.
    await h.session.send('próxima')
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.records[1].options.model).toBe('gpt-6.1-sol')
  })

  it('turno autônomo (loop, sem agent:send) depois da tarefa não herda o fixado', async () => {
    const h = harness()
    h.session.pinModel(true)
    await h.session.send('peça')
    h.records[0].event(done)
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('gpt-6.1-sol')
  })

  it('depois do erro "A cota do modelo X acabou", o turno seguinte nasce livre', async () => {
    const h = harness('gpt-6-astra')
    h.session.pinModel(true)
    await h.session.send('peça')
    h.records[0].event(quota)
    await settled()
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('A cota do modelo') }))
    await h.session.send('mensagem do usuário')
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('claude-opus-5-5')
  })

  it('liveOptions: o modelo em que a sessão está agora (depois da troca)', async () => {
    const h = harness()
    expect(h.session.liveOptions().model).toBe('claude-opus-5-5')
    h.records[0].event(quota)
    await settled()
    expect(h.session.liveOptions().model).toBe('gpt-6.1-sol')
  })
})

describe('quota classification', () => {
  it.each(["You've hit your limit · resets 8pm", 'usage_limit_reached', 'insufficient_quota', 'Credit balance is too low', 'O limite de uso do seu plano ChatGPT foi atingido.'])('recognizes %s only as a provider error', (text) => {
    expect(isUsageExhausted(text)).toBe(true)
    expect(sdkUsageExhausted({ type: 'assistant', message: { content: [{ type: 'text', text }] } })).toBe(false)
    expect(sdkUsageExhausted({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text }] } })).toBe(true)
  })
  it.each(['HTTP 429', 'Too many requests', 'network failed', 'overloaded', 'authentication failed'])('does not confuse %s with exhausted credits', (text) => {
    expect(isUsageExhausted(text)).toBe(false)
  })

  it('botão "agora" passa para a sessão atual, e não durante uma troca', async () => {
    const h = harness()
    const inject = vi.fn(() => true)
    Object.assign(h.records[0].session, { injectNow: inject })
    expect(h.session.injectNow('ajuste', undefined, 'u')).toBe(true)
    expect(inject).toHaveBeenCalledWith('ajuste', undefined, 'u')
    h.records[0].event(quota)
    expect(h.session.injectNow('ajuste')).toBe(false)
    await settled()
  })
})
