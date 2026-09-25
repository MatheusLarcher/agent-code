// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, StartAgentOptions } from '../../shared/ipc'
import type { AccountUsageReading } from '../../shared/claudeAccounts'
import { FAILOVER_CONTINUATION, ProviderFailoverSession } from '../providerFailover'
import { createSessionSwitchDeps } from './sessionSwitch'
import type { AccountCandidate } from './selection'

const quota: ChatEvent = { kind: 'result', id: 'quota', isError: true, usageExhausted: true, text: 'limit', durationMs: 1 }
const done: ChatEvent = { kind: 'result', id: 'done', isError: false, text: 'ok', durationMs: 1 }
const FUTURE = Date.now() + 3_600_000

const reading = (pct: number, resetsAt = FUTURE): AccountUsageReading => ({
  at: Date.now(),
  windows: { five_hour: { utilization: pct, resetsAt } }
})

function stub(background = { busy: false }) {
  return {
    start: vi.fn(async () => true),
    send: vi.fn(async (..._args: unknown[]) => {}),
    dispose: vi.fn(),
    interrupt: vi.fn(async () => ({ stillQueued: [] })),
    setBypass: vi.fn(),
    resolvePermission: vi.fn(),
    holdQuestion: vi.fn(() => null),
    refreshUsage: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    resumeAfterQuota: vi.fn(async () => 'durable-session'),
    continuationState: vi.fn(() => ({ approvedTools: [], loopActive: false, loopCycles: 0, loopLimit: 100, loopScheduledThisIteration: false })),
    restoreContinuation: vi.fn(),
    hasBackgroundWork: vi.fn(() => background.busy)
  }
}

/** Contas A, B, C (nessa ordem) com consumo simulado; `fail` simula a consulta caindo. */
function harness(opts: {
  pct: Record<string, number | null>
  status?: Record<string, AccountCandidate['status']>
  auto?: boolean
  multiple?: boolean
  gpt?: boolean
  fail?: boolean
}) {
  const stored = new Map<string, AccountUsageReading | null>(
    Object.entries(opts.pct).map(([id, pct]) => [id, pct == null ? null : reading(pct)])
  )
  const readUsage = vi.fn(async (ids: readonly string[], _force: boolean) =>
    ids.map((id) => ({ accountId: id, reading: stored.get(id) ?? null, fresh: !opts.fail }))
  )
  const changed = vi.fn()
  const acquire = vi.fn(async () => {})
  const deps = createSessionSwitchDeps({
    candidates: async () =>
      Object.keys(opts.pct).map((id) => ({ id, status: opts.status?.[id] ?? 'connected', usage: stored.get(id) ?? null })),
    readUsage,
    multiple: () => opts.multiple ?? true,
    autoEnabled: () => opts.auto ?? true,
    label: (id) => `conta ${id}`,
    changed,
    acquire
  })
  const background = { busy: false }
  const records: Array<{ options: StartAgentOptions; event: (e: ChatEvent) => void; finish: () => void; session: ReturnType<typeof stub> }> = []
  const emit = vi.fn()
  const complete = vi.fn()
  const available = vi.fn(async (provider: string) => provider === 'gpt' ? opts.gpt ?? true : true)
  const factory = vi.fn((options: StartAgentOptions, event: (e: ChatEvent) => void, finish: () => void) => {
    const session = stub(background)
    records.push({ options, event, finish, session })
    return session
  })
  const session = new ProviderFailoverSession(
    { convId: 'c', cwd: '/p', model: 'claude-opus-5-5', claudeAccountId: 'A' },
    factory, emit, available, complete, deps
  )
  return { session, records, emit, complete, changed, readUsage, acquire, background, stored }
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}
const switches = (emit: ReturnType<typeof vi.fn>) =>
  emit.mock.calls.map(([e]) => e as ChatEvent).filter((e): e is Extract<ChatEvent, { kind: 'account-switch' }> => e.kind === 'account-switch')

describe('troca de conta no fim do turno', () => {
  it('A 96%, B 40%, C 70% → B, silenciosa (sem FAILOVER_CONTINUATION); a próxima mensagem sai por B com o histórico', async () => {
    const h = harness({ pct: { A: 96, B: 40, C: 70 } })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.records[1].options).toMatchObject({ claudeAccountId: 'B', resume: 'durable-session', model: 'claude-opus-5-5' })
    expect(h.records[1].session.send).not.toHaveBeenCalled()
    expect(h.records[1].session.restoreContinuation).toHaveBeenCalledWith(expect.anything(), false)
    expect(h.changed).toHaveBeenCalledWith('B')
    expect(h.acquire).toHaveBeenCalled()
    expect(switches(h.emit)).toEqual([expect.objectContaining({ reason: 'turn-end', toAccountId: 'B', text: expect.stringContaining('96%') })])
    await h.session.send('próxima')
    expect(h.records[1].session.send).toHaveBeenCalledWith('próxima')
    expect(h.records[1].session.send).not.toHaveBeenCalledWith(FAILOVER_CONTINUATION, expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('A 96%, B 97%, C 98% → não troca', async () => {
    const h = harness({ pct: { A: 96, B: 97, C: 98 } })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(switches(h.emit)).toEqual([])
  })

  it('abaixo de 95% nem consulta as outras contas', async () => {
    const h = harness({ pct: { A: 50, B: 0 } })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.readUsage).toHaveBeenCalledTimes(1)
    expect(h.readUsage).toHaveBeenCalledWith(['A'], false)
  })

  it('com tarefa em background não troca; troca quando a tarefa termina', async () => {
    const h = harness({ pct: { A: 99, B: 10 } })
    h.background.busy = true
    await h.session.send('roda em background')
    h.records[0].event(done)
    await settled()
    expect(h.records).toHaveLength(1)
    h.background.busy = false
    h.records[0].event({ kind: 'background-tasks', tasks: [] })
    await settled()
    expect(h.records).toHaveLength(2)
    expect(h.records[1].options.claudeAccountId).toBe('B')
  })

  it('consulta falhando usa a última leitura, sem travar', async () => {
    const h = harness({ pct: { A: 99, B: 20 }, fail: true })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records[1]?.options.claudeAccountId).toBe('B')
  })

  it('login expirado nunca é escolhido', async () => {
    const h = harness({ pct: { A: 99, B: 0, C: 60 }, status: { B: 'expired' } })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('C')
  })

  it('uma conta só: fim de turno não faz nada', async () => {
    const h = harness({ pct: { A: 99 }, multiple: false })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.readUsage).not.toHaveBeenCalled()
  })
})

describe('troca de conta no estouro', () => {
  it('A, B e C estourando em sequência: cada conta uma vez, continuando a tarefa, e depois o GPT', async () => {
    const h = harness({ pct: { A: 90, B: 97, C: 98 } })
    await h.session.send('tarefa longa')
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    expect(h.records[1].session.send).toHaveBeenCalledWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    h.stored.set('B', reading(100))
    h.records[1].event(quota)
    await settled()
    expect(h.records[2].options.claudeAccountId).toBe('C')
    h.stored.set('C', reading(100))
    h.records[2].event(quota)
    await settled()
    expect(h.records[3].options.model).toBe('gpt-6-astra')
    expect(h.emit.mock.calls.map(([e]) => (e as ChatEvent).kind)).toEqual(['account-switch', 'account-switch', 'provider-switch'])
    expect(switches(h.emit).map((e) => e.text)).toEqual([
      'A conta conta A atingiu o limite. Continuei na conta conta B.',
      'A conta conta B atingiu o limite. Continuei na conta conta C.'
    ])
  })

  it('todas estouradas e sem GPT: tarefa preservada', async () => {
    const h = harness({ pct: { A: 100, B: 100 }, gpt: false })
    await h.session.send('tarefa')
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', text: expect.stringContaining('tarefa foi preservada') }))
  })

  it('interruptor desligado: nada troca; o estouro mostra o erro e sugere a conta de menor consumo', async () => {
    const h = harness({ pct: { A: 99, B: 30, C: 10 }, auto: false })
    await h.session.send('oi')
    h.records[0].event(done)
    await settled()
    expect(h.records).toHaveLength(1)
    await h.session.send('mais')
    h.records[0].event(quota)
    await settled()
    expect(h.records).toHaveLength(1)
    const kinds = h.emit.mock.calls.map(([e]) => (e as ChatEvent).kind)
    expect(kinds.slice(-2)).toEqual(['error', 'account-switch'])
    expect(switches(h.emit)[0]).toMatchObject({ reason: 'suggest', toAccountId: 'C' })
    // O botão "Continuar na conta C" é a troca manual com a tarefa retomada.
    expect(h.session.useAccount('C', true)).toEqual({ ok: true, scheduled: false })
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('C')
    expect(h.records[1].session.send).toHaveBeenCalledWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
  })

  it('uma conta só: o estouro segue como hoje (Claude → GPT)', async () => {
    const h = harness({ pct: { A: 100 }, multiple: false })
    await h.session.send('oi')
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('gpt-6-astra')
  })
})

describe('troca manual', () => {
  it('com o turno aberto fica agendada e acontece ao terminar', async () => {
    const h = harness({ pct: { A: 10, B: 10 } })
    await h.session.send('oi')
    expect(h.session.useAccount('B', false)).toEqual({ ok: true, scheduled: true })
    expect(h.records).toHaveLength(1)
    h.records[0].event(done)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    expect(switches(h.emit).map((e) => e.reason)).toEqual(['scheduled', 'manual'])
  })
})
