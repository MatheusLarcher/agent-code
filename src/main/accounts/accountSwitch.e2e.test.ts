// @vitest-environment node
// Ponta a ponta no main, com 2 contas FALSAS (nenhuma conta ou dado real):
// mensagem crua do SDK → tradução do AgentSession real → ProviderFailoverSession
// real → dependências de troca reais (sessionSwitch + switchPolicy + usageReader
// + exhaustedReading, como em accounts/index.ts). Só o processo do CLI é falso:
// a sessão de cada conta é um stub e a consulta de consumo devolve números fixos.
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AccountUsageReading, UsageWindow } from '../../shared/claudeAccounts'
import type { ChatEvent, StartAgentOptions } from '../../shared/ipc'
import { AgentSession } from '../agentSession'
import type { BrowserController } from '../browserController'
import { FAILOVER_CONTINUATION, failoverContinuation, ProviderFailoverSession } from '../providerFailover'
import { createSessionSwitchDeps } from './sessionSwitch'
import { exhaustedReading } from './usageMath'
import { createUsageReader } from './usageReader'

const WEEKLY = "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)"
const SESSION = "You've hit your session limit · resets 2:10am (America/Sao_Paulo)"
const FUTURE = Date.now() + 3_600_000

/** O par que o CLI grava/emite no estouro (transcript real de 26/09/2026). */
function limitHit(text: string): unknown[] {
  return [
    {
      type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, parent_tool_use_id: null,
      message: { role: 'assistant', model: '<synthetic>', type: 'message', content: [{ type: 'text', text }] }
    },
    { type: 'result', subtype: 'success', is_error: true, result: text, duration_ms: 5 }
  ]
}

/** Resposta normal do modelo, fechando o turno com sucesso. */
function reply(text: string): unknown[] {
  return [
    {
      type: 'assistant', parent_tool_use_id: null,
      message: { id: `msg-${text}`, role: 'assistant', model: 'claude-opus-5-5', type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 10 } }
    },
    { type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 5 }
  ]
}

type Proc = { account: string; options: StartAgentOptions; send: Mock<(...args: unknown[]) => Promise<void>>; sdk: (messages: unknown[]) => void }

function world(opts: { pct: Record<string, number>; gpt?: boolean }) {
  const pct = { ...opts.pct }
  // O "banco" das últimas leituras (claudeAccounts.loadUsage/saveUsage).
  const store = new Map<string, AccountUsageReading>()
  const fetchWindows = vi.fn(async (id: string): Promise<Record<string, UsageWindow>> => ({
    five_hour: { utilization: pct[id], resetsAt: FUTURE }
  }))
  const reader = createUsageReader({ fetchWindows, load: (id) => store.get(id) ?? null, save: (id, reading) => store.set(id, reading) })
  const deps = createSessionSwitchDeps({
    candidates: async () => Object.keys(pct).map((id) => ({ id, status: 'connected' as const, usage: store.get(id) ?? null })),
    readUsage: (ids, force) => reader.readMany(ids, { force }),
    multiple: () => true,
    autoEnabled: () => true,
    label: (id) => `conta ${id}`,
    changed: vi.fn(),
    acquire: async () => {},
    // O mesmo que accounts/index.ts liga.
    markExhausted: (id, text) => store.set(id, exhaustedReading(store.get(id) ?? null, text, Date.now()))
  })

  const procs: Proc[] = []
  const ui = vi.fn()
  const complete = vi.fn()
  const factory = (options: StartAgentOptions, emit: (event: ChatEvent) => void) => {
    // A tradução SDK → ChatEvent é a do AgentSession de verdade.
    const translator = new AgentSession({ convId: options.convId, cwd: options.cwd, model: options.model }, {} as BrowserController, emit, vi.fn(), vi.fn())
    const handle = (translator as unknown as { handleMessage(m: unknown): void }).handleMessage.bind(translator)
    const proc: Proc = {
      account: options.claudeAccountId ?? 'default',
      options,
      send: vi.fn(async (..._args: unknown[]) => {}),
      sdk: (messages) => messages.forEach(handle)
    }
    procs.push(proc)
    return {
      start: async () => true,
      send: proc.send,
      dispose: vi.fn(),
      interrupt: async () => ({ stillQueued: [] }),
      setBypass: vi.fn(),
      resolvePermission: vi.fn(),
      holdQuestion: () => null,
      refreshUsage: async () => {},
      waitForIdle: async () => {},
      resumeAfterQuota: async () => `sessao-da-conta-${proc.account}`,
      continuationState: () => ({ approvedTools: [], loopActive: false, loopCycles: 0, loopLimit: 100, loopScheduledThisIteration: false }),
      restoreContinuation: vi.fn(),
      // O do AgentSession real: vem do `background_tasks_changed` do SDK.
      hasBackgroundWork: () => translator.hasBackgroundWork()
    }
  }
  const session = new ProviderFailoverSession(
    { convId: 'conv-e2e', cwd: '/proj', model: 'claude-opus-5-5', claudeAccountId: 'A' },
    factory, ui, async (provider) => (provider === 'gpt' ? opts.gpt ?? false : true), complete, deps
  )
  const events = (): ChatEvent[] => ui.mock.calls.map(([event]) => event as ChatEvent)
  return { session, procs, ui, events, complete, store, fetchWindows, pct }
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}
const kinds = (events: ChatEvent[]): string[] => events.map((event) => event.kind)

describe('ponta a ponta: estouro no meio do turno', () => {
  it('A esgota (weekly limit) → o turno segue em B e B responde; mensagem nem perdida nem duplicada', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('refatora o módulo X', undefined, 'u-1')
    expect(w.procs[0].send).toHaveBeenCalledExactlyOnceWith('refatora o módulo X', undefined, 'u-1')

    w.procs[0].sdk(limitHit(WEEKLY))
    await settled()

    // Troca: B sobe retomando o MESMO histórico (a mensagem do usuário está nele).
    expect(w.procs).toHaveLength(2)
    expect(w.procs[1].options).toMatchObject({ claudeAccountId: 'B', resume: 'sessao-da-conta-A' })
    // B só recebe a continuação — a mensagem do usuário não é reenviada em texto.
    expect(w.procs[1].send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    // A consulta foi de verdade (force) e A ficou marcada como esgotada até o reset.
    expect(w.fetchWindows).toHaveBeenCalledWith('B', expect.anything())
    expect(w.store.get('A')?.windows.seven_day?.utilization).toBe(100)

    w.procs[1].sdk(reply('Módulo X refatorado.'))
    await settled()

    const events = w.events()
    // O estouro de A não chega à tela; chega a nota da troca, a resposta de B e o fim do turno.
    expect(events.some((event) => (event.kind === 'result' || event.kind === 'error') && event.usageExhausted)).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'account-switch', reason: 'exhausted', fromAccountId: 'A', toAccountId: 'B',
      text: 'A conta conta A atingiu o limite. Continuei na conta conta B.' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'assistant-text', text: 'Módulo X refatorado.' }))
    expect(events.at(-1)).toMatchObject({ kind: 'result', isError: false })
    expect(kinds(events).filter((kind) => kind === 'result')).toHaveLength(1)
    expect(w.complete).not.toHaveBeenCalled()
  })

  it('conta Max com uso extra esgotado ("You\'re out of extra usage", lista VBr do CLI) troca e fica fora até o reset do texto', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('continua a migração', undefined, 'u-9')
    const before = Date.now()
    w.procs[0].sdk(limitHit("You're out of extra usage · resets 11pm (America/Sao_Paulo)"))
    await settled()
    expect(w.procs).toHaveLength(2)
    expect(w.procs[1].options).toMatchObject({ claudeAccountId: 'B', resume: 'sessao-da-conta-A' })
    expect(w.procs[1].send).toHaveBeenCalledExactlyOnceWith(FAILOVER_CONTINUATION, undefined, expect.any(String), 'pc', 'recovery')
    expect(w.procs[0].send).toHaveBeenCalledTimes(1)
    // Aviso sem janela nomeada: marca a conta toda, mas com o reset tirado do texto (nunca sem prazo).
    const mark = w.store.get('A')?.windows.exhausted
    expect(mark?.utilization).toBe(100)
    expect(mark?.resetsAt).toBeGreaterThan(before)
    expect(mark?.resetsAt).toBeLessThanOrEqual(before + 24 * 3_600_000)
    expect(w.events()).toContainEqual(expect.objectContaining({ kind: 'account-switch', reason: 'exhausted', toAccountId: 'B' }))
  })

  it('tarefa em background (vista pelo AgentSession real) é avisada na troca e contada à conta nova', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('sobe o servidor e testa')
    w.procs[0].sdk([{ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }] }])
    w.procs[0].sdk(limitHit(WEEKLY))
    await settled()
    expect(w.procs[1].options.claudeAccountId).toBe('B')
    expect(w.events()).toContainEqual(expect.objectContaining({ kind: 'account-switch', reason: 'exhausted',
      text: expect.stringContaining('(npm run dev) foi interrompido pela troca') }))
    expect(w.procs[1].send).toHaveBeenCalledExactlyOnceWith(failoverContinuation(['npm run dev']), undefined, expect.any(String), 'pc', 'recovery')
  })

  it('session limit também troca', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('oi')
    w.procs[0].sdk(limitHit(SESSION))
    await settled()
    expect(w.procs[1]?.options.claudeAccountId).toBe('B')
    expect(w.store.get('A')?.windows.five_hour?.utilization).toBe(100)
  })

  it('nenhuma conta com limite: aviso claro com o reset, sem troca e sem laço nos turnos seguintes', async () => {
    const w = world({ pct: { A: 70, B: 100 } })
    await w.session.send('tarefa')
    w.procs[0].sdk(limitHit(WEEKLY))
    await settled()
    expect(w.procs).toHaveLength(1)
    const last = w.events().at(-1)
    expect(last).toMatchObject({ kind: 'result', isError: true, usageExhausted: true })
    const text = (last as { text: string }).text
    expect(text).toContain(WEEKLY)
    expect(text).toContain('Nenhuma outra conta Claude tem limite disponível.')
    expect(text).toContain('A tarefa foi preservada')
    expect(w.complete).toHaveBeenCalledTimes(1)

    // O renderer tenta de novo no reset; A continua esgotada: mesmo aviso, sem trocar.
    await w.session.send('tarefa')
    w.procs[0].sdk(limitHit(WEEKLY))
    await settled()
    expect(w.procs).toHaveLength(1)
    expect(w.events().filter((event) => event.kind === 'account-switch')).toHaveLength(0)
    expect(w.complete).toHaveBeenCalledTimes(2)
  })

  it('429 transitório do servidor não troca de conta nem marca a conta', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('oi')
    w.procs[0].sdk(limitHit('Server is temporarily limiting requests (not your usage limit) · Rate limited'))
    await settled()
    expect(w.procs).toHaveLength(1)
    expect(w.store.get('A')).toBeUndefined()
    expect(w.events().at(-1)).toMatchObject({ kind: 'result', isError: true, usageExhausted: false })
  })
})

describe('ponta a ponta: regra dos 95% no fim do turno (convive com a do estouro)', () => {
  it('A em 96% no fim do turno → a conversa passa para B (40%) e a próxima mensagem sai por B', async () => {
    const w = world({ pct: { A: 96, B: 40 } })
    await w.session.send('oi')
    w.procs[0].sdk(reply('olá'))
    await settled()

    expect(w.procs).toHaveLength(2)
    expect(w.procs[1].options).toMatchObject({ claudeAccountId: 'B', resume: 'sessao-da-conta-A' })
    // Troca silenciosa: nada é reenviado.
    expect(w.procs[1].send).not.toHaveBeenCalled()
    expect(w.events()).toContainEqual(expect.objectContaining({ kind: 'account-switch', reason: 'turn-end', toAccountId: 'B',
      text: 'Troquei para a conta conta B (40% usado) — a conta conta A estava em 96%.' }))

    await w.session.send('próxima')
    expect(w.procs[1].send).toHaveBeenCalledWith('próxima')
    expect(w.procs[0].send).toHaveBeenCalledTimes(1)
  })

  it('A em 94% não troca', async () => {
    const w = world({ pct: { A: 94, B: 0 } })
    await w.session.send('oi')
    w.procs[0].sdk(reply('olá'))
    await settled()
    expect(w.procs).toHaveLength(1)
  })

  it('as duas regras no mesmo dia: B assume por estouro de A e, em 96% no fim do turno, não volta para A esgotada', async () => {
    const w = world({ pct: { A: 70, B: 30 } })
    await w.session.send('tarefa')
    w.procs[0].sdk(limitHit(WEEKLY))
    await settled()
    expect(w.procs[1].options.claudeAccountId).toBe('B')
    // A consulta de A agora mostra o estouro; B chega a 96% durante o turno (o
    // rate_limit_event da sessão grava a leitura, como recordSessionRateLimit).
    w.pct.A = 100
    w.store.set('B', { at: Date.now(), windows: { five_hour: { utilization: 96, resetsAt: FUTURE } } })
    const fetchesBefore = w.fetchWindows.mock.calls.length
    w.procs[1].sdk(reply('feito'))
    await settled()
    // A regra dos 95% consultou A de verdade e, com A em 100%, ficou em B.
    expect(w.fetchWindows.mock.calls.slice(fetchesBefore).map(([id]) => id)).toEqual(['A'])
    expect(w.procs).toHaveLength(2)
    expect(w.events().filter((event) => event.kind === 'account-switch')).toHaveLength(1)
  })
})
