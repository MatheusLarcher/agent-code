// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, StartAgentOptions } from '../../shared/ipc'
import type { AccountUsageReading } from '../../shared/claudeAccounts'
import { AgentSession } from '../agentSession'
import type { BrowserController } from '../browserController'
import { FAILOVER_CONTINUATION, failoverContinuation, OPAQUE_CALL_TASK, ProviderFailoverSession } from '../providerFailover'
import { createSessionSwitchDeps } from './sessionSwitch'
import type { AccountCandidate } from './selection'

const quota: ChatEvent = { kind: 'result', id: 'quota', isError: true, usageExhausted: true, text: 'limit', durationMs: 1 }
const done: ChatEvent = { kind: 'result', id: 'done', isError: false, text: 'ok', durationMs: 1 }
/** O `result` que o AgentSession emite no estouro real (texto do CLI, 26/09/2026). */
const WEEKLY_TEXT = "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)"
const weekly: ChatEvent = { kind: 'result', id: 'weekly', isError: true, usageExhausted: true, durationMs: 1, text: WEEKLY_TEXT }
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
  /** "Continuar na conta X" recusado? (turno de tarefa MCP que terminou em erro) */
  refuse?: () => string | null
}) {
  const stored = new Map<string, AccountUsageReading | null>(
    Object.entries(opts.pct).map(([id, pct]) => [id, pct == null ? null : reading(pct)])
  )
  const readUsage = vi.fn(async (ids: readonly string[], _force: boolean) =>
    ids.map((id) => ({ accountId: id, reading: stored.get(id) ?? null, fresh: !opts.fail }))
  )
  const changed = vi.fn()
  const acquire = vi.fn(async () => {})
  // O main grava a janela estourada como 100% na última leitura da conta.
  const markExhausted = vi.fn((id: string, _text: string): void => {
    stored.set(id, reading(100))
  })
  const base = createSessionSwitchDeps({
    candidates: async () =>
      Object.keys(opts.pct).map((id) => ({ id, status: opts.status?.[id] ?? 'connected', usage: stored.get(id) ?? null })),
    readUsage,
    multiple: () => opts.multiple ?? true,
    autoEnabled: () => opts.auto ?? true,
    label: (id) => `conta ${id}`,
    changed,
    acquire,
    markExhausted
  })
  const deps = opts.refuse ? { ...base, continueRefused: opts.refuse } : base
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
  return { session, records, emit, complete, changed, readUsage, acquire, background, stored, markExhausted, available }
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
    expect(h.records[3].options.model).toBe('gpt-6.1-sol')
    expect(h.emit.mock.calls.map(([e]) => (e as ChatEvent).kind)).toEqual(['account-switch', 'account-switch', 'provider-switch'])
    expect(switches(h.emit).map((e) => e.text)).toEqual([
      'A conta conta A atingiu o limite. Continuei na conta conta B.',
      'A conta conta B atingiu o limite. Continuei na conta conta C.'
    ])
  })

  it('todas estouradas e sem GPT: tarefa preservada, com o aviso de sempre (texto do limite, retry no reset)', async () => {
    const h = harness({ pct: { A: 100, B: 100 }, gpt: false })
    await h.session.send('tarefa')
    h.records[0].event(weekly)
    await settled()
    expect(h.records).toHaveLength(1)
    // Mesmo `result` com erro que o renderer já tratava: o texto do CLI (com o
    // horário do reset) continua lá, mais a explicação.
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'result',
      isError: true,
      text: expect.stringMatching(/weekly limit · resets 11pm[\s\S]*tarefa foi preservada/)
    }))
    expect(h.complete).toHaveBeenCalledTimes(1)
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

  it('"Continuar na conta X" no turno de uma tarefa MCP que terminou em erro: recusado com o motivo, nada troca nem continua', async () => {
    const h = harness({ pct: { A: 99, B: 30, C: 10 }, auto: false, refuse: () => 'tarefa do Forgia encerrada' })
    await h.session.send('tarefa')
    h.records[0].event(quota)
    await settled()
    expect(h.session.useAccount('C', true)).toEqual({ ok: false, scheduled: false, reason: 'tarefa do Forgia encerrada' })
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.records[0].session.send).not.toHaveBeenCalledWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    // Só trocar de conta (sem continuar) segue permitido.
    expect(h.session.useAccount('C', false)).toEqual({ ok: true, scheduled: false })
  })

  it('"Continuar na conta X" agendado e o turno vira de tarefa encerrada antes da troca: troca a conta, NÃO continua, avisa', async () => {
    let refused: string | null = null
    const h = harness({ pct: { A: 99, B: 30, C: 10 }, auto: false, refuse: () => refused })
    await h.session.send('oi')
    expect(h.session.useAccount('C', true)).toEqual({ ok: true, scheduled: true })
    refused = 'tarefa do Forgia encerrada'
    h.records[0].event(done)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('C')
    expect(h.records[1].session.send).not.toHaveBeenCalled()
    expect(h.records[1].session.restoreContinuation).toHaveBeenCalledWith(expect.anything(), false)
    expect(switches(h.emit).at(-1)).toMatchObject({ reason: 'manual', toAccountId: 'C', text: expect.stringContaining('tarefa do Forgia encerrada') })
  })

  it('uma conta só: o estouro segue como hoje (Claude → GPT)', async () => {
    const h = harness({ pct: { A: 100 }, multiple: false })
    await h.session.send('oi')
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('gpt-6.1-sol')
  })
})

describe('estouro definitivo: consulta, troca e não volta para a conta esgotada', () => {
  it('A esgota → consulta as outras de verdade e continua em B, sem perder a mensagem', async () => {
    const h = harness({ pct: { A: 60, B: 99, C: 20 } })
    await h.session.send('tarefa')
    h.records[0].event(weekly)
    await settled()
    expect(h.markExhausted).toHaveBeenCalledWith('A', WEEKLY_TEXT)
    expect(h.readUsage).toHaveBeenCalledWith(['B', 'C'], true)
    expect(h.records[1].options).toMatchObject({ claudeAccountId: 'C', resume: 'durable-session' })
    // A mensagem do usuário está no transcript retomado; a sessão nova só continua.
    expect(h.records[1].session.send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    expect(h.changed).toHaveBeenCalledWith('C')
    expect(switches(h.emit)).toEqual([expect.objectContaining({ reason: 'exhausted', fromAccountId: 'A', toAccountId: 'C' })])
    // O erro de limite da conta A não chega ao renderer (não vira "aguarde o reset").
    expect(h.emit).not.toHaveBeenCalledWith(weekly)
  })

  it('conta esgotada não volta a ser escolhida no turno seguinte, mesmo com a consulta falhando', async () => {
    // Consulta caindo: vale a última leitura. Sem a marca de esgotada, A (60%
    // na leitura velha) seria escolhida de novo e estouraria na hora.
    const h = harness({ pct: { A: 60, B: 10 }, fail: true, gpt: false })
    await h.session.send('tarefa')
    h.records[0].event(weekly)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    h.records[1].event(done)
    await settled()
    await h.session.send('próxima')
    h.records[1].event(weekly)
    await settled()
    expect(h.records).toHaveLength(2)
    expect(switches(h.emit)).toHaveLength(1)
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'result', isError: true, text: expect.stringContaining('resets 11pm') }))
  })

  it('sem laço: A → B no mesmo turno, B esgota → não volta para A; aviso mantido', async () => {
    const h = harness({ pct: { A: 10, B: 10 }, fail: true, gpt: false })
    h.markExhausted.mockImplementation(() => undefined) // nem a marca ajuda: só o `triedAccounts`
    await h.session.send('tarefa')
    h.records[0].event(weekly)
    await settled()
    h.records[1].event(weekly)
    await settled()
    h.records[1].event(weekly) // terminal duplicado
    await settled()
    expect(h.records).toHaveLength(2)
    expect(switches(h.emit).map((e) => e.toAccountId)).toEqual(['B'])
    expect(h.complete).toHaveBeenCalledTimes(1)
  })

  it('erro transitório (429 sem estouro, overload) não troca nem consulta', async () => {
    const h = harness({ pct: { A: 99, B: 0 } })
    await h.session.send('tarefa')
    const transient: ChatEvent = { kind: 'result', id: 't', isError: true, durationMs: 1, text: 'Server is temporarily limiting requests (not your usage limit)' }
    h.records[0].event(transient)
    await settled()
    expect(h.records).toHaveLength(1)
    expect(h.markExhausted).not.toHaveBeenCalled()
    expect(h.readUsage).not.toHaveBeenCalledWith(expect.anything(), true)
    expect(h.emit).toHaveBeenCalledWith(transient)
  })
})

describe('estouro com trabalho em background: troca já, avisa o usuário e a conta nova', () => {
  const devServer = { id: 't1', type: 'local_bash', description: 'npm run dev' }

  it('não adia (a tarefa do usuário está parada), mas a nota e a continuação dizem o que foi interrompido', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    h.background.busy = true
    h.records[0].event({ kind: 'background-tasks', tasks: [devServer] })
    h.records[0].event(weekly)
    await settled()
    expect(h.records[0].session.hasBackgroundWork).toHaveBeenCalled()
    expect(h.records[0].session.dispose).toHaveBeenCalled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    const note = switches(h.emit)[0]
    expect(note).toMatchObject({ reason: 'exhausted', toAccountId: 'B' })
    expect(note.text).toContain('Continuei na conta conta B.')
    expect(note.text).toContain('o trabalho em background que ainda rodava (npm run dev) foi interrompido pela troca')
    const [continuation] = h.records[1].session.send.mock.calls[0] as [string]
    expect(continuation).toBe(failoverContinuation(['npm run dev']))
    expect(continuation).not.toBe(FAILOVER_CONTINUATION)
    expect(continuation).toContain('interrompeu o trabalho em background que ainda rodava:\n- npm run dev')
    expect(continuation).toMatch(/^\[PROVIDER_CONTINUATION\][\s\S]*\[\/PROVIDER_CONTINUATION\]$/)
    expect(h.records[1].session.send).toHaveBeenCalledTimes(1)
  })

  it('background sem descrição (chamada autônoma em aberto) também é avisado', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    h.background.busy = true
    h.records[0].event(weekly)
    await settled()
    expect(switches(h.emit)[0].text).toContain('o trabalho em background que ainda rodava foi interrompido pela troca')
    expect(h.records[1].session.send.mock.calls[0][0]).toContain('- (sem descrição disponível)')
  })

  it('só um loop agendado não é interrompido (passa pelo continuationState): continuação normal', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    h.background.busy = true
    h.records[0].session.continuationState.mockReturnValue({ approvedTools: [], loopActive: true, loopCycles: 1, loopLimit: 100, loopScheduledThisIteration: false })
    h.records[0].event(weekly)
    await settled()
    expect(switches(h.emit)[0].text).toBe('A conta conta A atingiu o limite. Continuei na conta conta B.')
    expect(h.records[1].session.send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
  })

  it('loop ativo + chamada autônoma em aberto (AgentSession real): a chamada interrompida é avisada', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    // O estado vem do AgentSession de verdade: loop agendado e uma ferramenta sem
    // PostToolUse ainda (restartOpaqueCalls), sem nenhuma background-task listada.
    const real = new AgentSession({ convId: 'c', cwd: '/p', model: 'claude-opus-5-5' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
    const inner = real as unknown as { loopActive: boolean; restartOpaqueCalls: Set<string>; restartBackground: number | null }
    inner.loopActive = true
    inner.restartBackground = 0
    inner.restartOpaqueCalls.add('toolu_mcp_1')
    const old = Object.assign(h.records[0].session, { restartActivity: () => real.restartActivity() })
    old.hasBackgroundWork.mockImplementation(() => real.hasBackgroundWork())
    old.continuationState.mockImplementation(() => ({ ...real.continuationState(), approvedTools: [] }))
    h.records[0].event(weekly)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    expect(switches(h.emit)[0].text).toContain(`o trabalho em background que ainda rodava (${OPAQUE_CALL_TASK}) foi interrompido pela troca`)
    const [continuation] = h.records[1].session.send.mock.calls[0] as [string]
    expect(continuation).toBe(failoverContinuation([OPAQUE_CALL_TASK]))
    expect(continuation).toContain(`- ${OPAQUE_CALL_TASK}`)
    // O loop continua indo para a sessão nova, como antes.
    expect(h.records[1].session.restoreContinuation).toHaveBeenCalledWith(expect.objectContaining({ loopActive: true }), true)

    // O sinal é o campo estruturado, não o texto do `unsafe`.
    expect(real.restartActivity().autonomousCallOpen).toBe(true)
    // Sem a chamada em aberto, o mesmo loop sozinho segue sem aviso (comportamento aprovado).
    inner.restartOpaqueCalls.clear()
    expect(real.restartActivity()).toMatchObject({ unsafe: 'Loop/agendamento ativo.', autonomousCallOpen: false })
  })

  it('loop ativo + comando destacado já concluído (restartUncertain, AgentSession real): SEM aviso', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    // restartUncertain é pegajoso e dá o MESMO texto de `unsafe` da chamada em
    // aberto — a comparação por texto avisava aqui. Nenhuma chamada está aberta.
    const real = new AgentSession({ convId: 'c', cwd: '/p', model: 'claude-opus-5-5' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
    const inner = real as unknown as { loopActive: boolean; restartUncertain: boolean; restartBackground: number | null }
    inner.loopActive = true
    inner.restartBackground = 0
    inner.restartUncertain = true
    expect(real.restartActivity()).toMatchObject({ unsafe: 'Trabalho autônomo sem prova de término.', autonomousCallOpen: false })
    const old = Object.assign(h.records[0].session, { restartActivity: () => real.restartActivity() })
    old.hasBackgroundWork.mockImplementation(() => real.hasBackgroundWork())
    old.continuationState.mockImplementation(() => ({ ...real.continuationState(), approvedTools: [] }))
    h.records[0].event(weekly)
    await settled()
    expect(h.records[1].options.claudeAccountId).toBe('B')
    expect(switches(h.emit)[0].text).toBe('A conta conta A atingiu o limite. Continuei na conta conta B.')
    expect(h.records[1].session.send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
  })

  it('background listado + chamada autônoma em aberto: as duas aparecem', async () => {
    const h = harness({ pct: { A: 60, B: 10 } })
    await h.session.send('tarefa')
    h.background.busy = true
    Object.assign(h.records[0].session, { restartActivity: () => ({ busy: false, unsafe: 'Trabalho autônomo sem prova de término.', autonomousCallOpen: true }) })
    h.records[0].event({ kind: 'background-tasks', tasks: [devServer] })
    h.records[0].event(weekly)
    await settled()
    expect(h.records[1].session.send.mock.calls[0][0]).toBe(failoverContinuation(['npm run dev', OPAQUE_CALL_TASK]))
  })

  it('todas as contas esgotadas → GPT: o mesmo aviso na troca de provedor', async () => {
    const h = harness({ pct: { A: 60 }, multiple: false })
    await h.session.send('tarefa')
    h.background.busy = true
    h.records[0].event({ kind: 'background-tasks', tasks: [devServer] })
    h.records[0].event(quota)
    await settled()
    expect(h.records[1].options.model).toBe('gpt-6.1-sol')
    const note = h.emit.mock.calls.map(([e]) => e as ChatEvent).find((e) => e.kind === 'provider-switch') as { text: string }
    expect(note.text).toContain('(npm run dev) foi interrompido pela troca')
    expect(h.records[1].session.send.mock.calls[0][0]).toBe(failoverContinuation(['npm run dev']))
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
