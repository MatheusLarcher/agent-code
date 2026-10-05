// @vitest-environment node
// O turno nunca fica "trabalhando" para sempre: (a) o stream do SDK que acaba no
// meio do turno — lançando ou não — sai como UM `error` incomplete; (b) o
// travamento definitivo (segundo limiar de stallWatch.ts) encerra o turno.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
import type { ChatEvent } from '../shared/ipc'
import { STALL_ABORT_MS, STALL_ABORT_TOOL_MS, STALL_POLL_MS } from './stallWatch'

vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, chromeControlEnabled: false, ollama: { enabled: false, apiKey: '' } }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => false }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./store', () => ({
  getCacheInfo: () => ({ dir: 'C:\\test\\ac', memoriesDir: 'C:\\test\\ac\\memories', skillsDir: 'C:\\test\\ac\\skills', localDir: 'C:\\test\\ac-local' })
}))
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) }
}))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./typesafe', () => ({ typeSafeMemorySelectionActive: async () => false, selectMemoriesWithTypeSafe: async () => null }))
vi.mock('./typesafe/client', () => ({
  typeSafeEnabled: () => false,
  typeSafeApiKey: async () => null,
  typeSafeMinConfidence: () => 0.6,
  askTypeSafe: async () => null
}))
vi.mock('./sessionLog', () => ({ logSession: vi.fn() }))

import { AgentSession } from './agentSession'
import { logSession } from './sessionLog'

const S = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(logSession).mockClear()
})

type Internals = {
  handleMessage(m: unknown): void
  consumeMessages(q: AsyncGenerator<unknown>): Promise<void>
  q: unknown
  turnActive: boolean
  toolsInFlight: Set<string>
  pendingPermissions: Map<string, unknown>
}

function session() {
  const events: ChatEvent[] = []
  const s = new AgentSession({ convId: 'c-end', cwd: '/p' }, {} as BrowserController, (e) => events.push(e), vi.fn(), vi.fn())
  const internals = s as unknown as Internals
  return {
    s,
    events,
    internals,
    feed: (m: unknown): void => internals.handleMessage(m),
    /** O stream do SDK acaba SEM lançar (o CLI saiu). */
    end: (): Promise<void> => internals.consumeMessages((async function* () {})()),
    /** O stream do SDK lança. */
    die: (): Promise<void> =>
      internals.consumeMessages(
        (async function* () {
          throw new Error('Claude Code process aborted')
        })()
      )
  }
}

const echo = (...ids: string[]) => ({ user_message_uuid: ids[ids.length - 1], user_message_uuids: ids })
const start = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null, uuid: 'u', session_id: 's', ...extra })
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  duration_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  session_id: 's',
  uuid: 'r',
  ...extra
})
const errors = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { kind: 'error' }> => e.kind === 'error')
const idle = async (s: AgentSession): Promise<boolean> => {
  let done = false
  void s.waitForIdle().then(() => { done = true })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

describe('AgentSession — fim do stream no meio do turno', () => {
  it('iterador termina SEM lançar com o turno aberto: um error incomplete/retryable com o id, turno ocioso, sessão morta', async () => {
    const { s, events, feed, end } = session()
    await s.send('primeira', undefined, S)
    feed(start('m1', echo(S)))
    await end()
    expect(errors(events)).toEqual([
      expect.objectContaining({ incomplete: true, retryable: true, turnIds: [S], text: expect.stringMatching(/encerrou no meio do turno/) })
    ])
    expect(await idle(s)).toBe(true)
    expect(s.isAlive()).toBe(false)
    expect(logSession).toHaveBeenCalledWith('stream-ended', expect.objectContaining({ convId: 'c-end', threw: false, turnIds: [S] }))
  })

  it('iterador termina sem lançar FORA de turno: nenhum error e nada muda (comportamento anterior)', async () => {
    const { s, events, feed, end } = session()
    await s.send('primeira', undefined, S)
    feed(result(echo(S)))
    await end()
    expect(errors(events)).toEqual([])
    expect(s.isAlive()).toBe(true)
    expect(logSession).not.toHaveBeenCalledWith('stream-ended', expect.anything())
  })

  it('iterador lança com o turno aberto: UM error só (o do catch), com incomplete', async () => {
    const { s, events, die } = session()
    await s.send('primeira', undefined, S)
    await die()
    expect(errors(events)).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^Agent stopped/), incomplete: true, retryable: true, turnIds: [S] })
    ])
    expect(logSession).toHaveBeenCalledWith('stream-ended', expect.objectContaining({ threw: true }))
  })

  it('iterador lança fora de turno: o error de sempre, sem incomplete', async () => {
    const { s, events, feed, die } = session()
    await s.send('primeira', undefined, S)
    feed(result(echo(S)))
    await die()
    const [error] = errors(events)
    expect(errors(events)).toHaveLength(1)
    expect(error).not.toHaveProperty('incomplete')
  })

  it('sessão descartada: o fim do stream não avisa nada', async () => {
    const { s, events, end } = session()
    await s.send('primeira', undefined, S)
    s.dispose()
    await end()
    expect(errors(events)).toEqual([])
  })
})

describe('AgentSession — travamento definitivo (timers falsos)', () => {
  const setup = async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const ctx = session()
    const interrupt = vi.fn(async () => undefined)
    await ctx.s.send('primeira', undefined, S)
    ctx.internals.q = { interrupt }
    return { ...ctx, interrupt }
  }

  it('sem ferramenta: avisa em 1 min e encerra depois de 10 min — interrupt, UM error, turno ocioso', async () => {
    const { s, events, interrupt } = await setup()
    vi.advanceTimersByTime(60_000 + STALL_POLL_MS)
    expect(events.filter((e) => e.kind === 'stall-status').at(-1)).toMatchObject({ stalled: true })
    expect(errors(events)).toEqual([])
    vi.advanceTimersByTime(STALL_ABORT_MS)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(errors(events)).toEqual([
      expect.objectContaining({ incomplete: true, retryable: true, turnIds: [S], text: expect.stringMatching(/^Sessão travada: sem resposta há 1\d min — retomando de onde parou/) })
    ])
    // O aviso desfeito e o turno fechado; mais tempo não gera outro terminal.
    expect(events.filter((e) => e.kind === 'stall-status').at(-1)).toMatchObject({ stalled: false })
    expect(await idle(s)).toBe(true)
    vi.advanceTimersByTime(STALL_ABORT_TOOL_MS * 2)
    expect(errors(events)).toHaveLength(1)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(logSession).toHaveBeenCalledWith('stall-abort', expect.objectContaining({ convId: 'c-end', toolInFlight: false }))
    // Encerrado pelo travamento não é o Stop do usuário: a próxima mensagem não leva a nota de cancelamento.
    expect((s as unknown as { canceledPending: boolean }).canceledPending).toBe(false)
  })

  it('depois do abort: sessão morta, result tardio do turno abortado e fim do stream engolidos', async () => {
    const { s, events, feed, die } = await setup()
    feed(start('m1', echo(S)))
    vi.advanceTimersByTime(STALL_ABORT_MS + STALL_POLL_MS)
    expect(errors(events)).toHaveLength(1)
    expect(s.isAlive()).toBe(false)
    // O CLI responde ao interrupt com o result do turno abortado: não é terminal novo.
    feed(result({ ...echo(S), is_error: true, subtype: 'error_during_execution', result: undefined }))
    expect(events.filter((e) => e.kind === 'result')).toEqual([])
    // E o processo morre depois: nenhum outro error.
    await die()
    expect(errors(events)).toHaveLength(1)
    // A retomada não vai para o CLI travado: o envio vira erro claro, sem empurrar no input.
    await s.send('retomando', undefined, '44444444-4444-4444-8444-444444444444')
    expect(errors(events).at(-1)).toMatchObject({ text: expect.stringMatching(/já tinha encerrado/) })
  })

  it('result de OUTRO turno depois do abort não é engolido', async () => {
    const { s, events, feed } = await setup()
    vi.advanceTimersByTime(STALL_ABORT_MS + STALL_POLL_MS)
    expect(s.isAlive()).toBe(false)
    feed(result(echo('55555555-5555-4555-8555-555555555555')))
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1)
  })

  it('com ferramenta em voo: 10 min não encerra; 30 min sim', async () => {
    const { events, internals, interrupt } = await setup()
    internals.toolsInFlight.add('toolu_build')
    vi.advanceTimersByTime(STALL_ABORT_MS + STALL_POLL_MS)
    expect(interrupt).not.toHaveBeenCalled()
    expect(errors(events)).toEqual([])
    vi.advanceTimersByTime(STALL_ABORT_TOOL_MS - STALL_ABORT_MS)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(errors(events)).toHaveLength(1)
  })

  it('mensagem de subagente é sinal de vida: o prazo recomeça', async () => {
    const { events, feed, interrupt } = await setup()
    vi.advanceTimersByTime(STALL_ABORT_MS - 30_000)
    feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      message: { id: 'sub-1', content: [{ type: 'text', text: 'subagente trabalhando' }] },
      session_id: 's',
      uuid: 'sub-u1'
    })
    vi.advanceTimersByTime(STALL_ABORT_MS - 30_000)
    expect(interrupt).not.toHaveBeenCalled()
    expect(errors(events)).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('permissão esperando o usuário: não encerra (só o aviso)', async () => {
    const { events, internals, interrupt } = await setup()
    internals.pendingPermissions.set('perm-1', { toolName: 'Bash', input: {}, resolve: vi.fn() })
    vi.advanceTimersByTime(STALL_ABORT_TOOL_MS + STALL_POLL_MS)
    expect(interrupt).not.toHaveBeenCalled()
    expect(errors(events)).toEqual([])
    expect(events.filter((e) => e.kind === 'stall-status').at(-1)).toMatchObject({ stalled: true })
    internals.pendingPermissions.clear()
  })
})
