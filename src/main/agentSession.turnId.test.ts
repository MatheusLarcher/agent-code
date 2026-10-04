// @vitest-environment node
// Identidade de turno (`turnIds`, shared/ipc.ts): o `messageUuid` que o renderer
// mandou volta em toda saída e todo terminal do turno — pelo eco do CLI
// (`user_message_uuid(s)`), nunca por "o último envio": no Stop o CLI ainda fecha o
// turno parado quando o seguinte já foi enviado.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
import type { ChatEvent } from '../shared/ipc'

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

import { AgentSession } from './agentSession'

const S = '11111111-1111-4111-8111-111111111111'
const N = '22222222-2222-4222-8222-222222222222'
const T = '33333333-3333-4333-8333-333333333333'

afterEach(() => {
  vi.useRealTimers()
})

function session() {
  const events: ChatEvent[] = []
  const s = new AgentSession({ convId: 'c-turn', cwd: '/p' }, {} as BrowserController, (e) => events.push(e), vi.fn(), vi.fn())
  const internals = s as unknown as {
    handleMessage(m: unknown): void
    consumeMessages(q: AsyncGenerator<unknown>): Promise<void>
    input: { values: Array<{ uuid?: string }> }
    q: unknown
  }
  return {
    s,
    events,
    feed: (m: unknown): void => internals.handleMessage(m),
    /** A query morre: o iterador do SDK lança (o fim do stream). */
    die: (): Promise<void> =>
      internals.consumeMessages(
        (async function* () {
          throw new Error('Claude Code process aborted')
        })()
      ),
    pushed: (): string[] => internals.input.values.map((m) => m.uuid ?? ''),
    setQuery: (q: unknown): void => {
      internals.q = q
    }
  }
}

const echo = (...ids: string[]) => ({ user_message_uuid: ids[ids.length - 1], user_message_uuids: ids })
const stream = (event: unknown, extra: Record<string, unknown> = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 's', ...extra })
const start = (id: string, extra: Record<string, unknown> = {}) => stream({ type: 'message_start', message: { id } }, extra)
const delta = (text: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
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
const of = <K extends ChatEvent['kind']>(events: ChatEvent[], kind: K) =>
  events.filter((e): e is Extract<ChatEvent, { kind: K }> => e.kind === kind)

describe('AgentSession — identidade de turno', () => {
  it('o 1º frame do turno avisa o começo (turn-start); saída e result levam o id da mensagem', async () => {
    const { s, events, feed } = session()
    await s.send('primeira', undefined, S)
    feed(start('m1', echo(S)))
    expect(of(events, 'turn-start')).toEqual([{ kind: 'turn-start', turnIds: [S] }])
    feed(delta('oi'))
    expect(of(events, 'assistant-text').at(-1)).toMatchObject({ text: 'oi', turnIds: [S] })
    feed(result(echo(S)))
    expect(of(events, 'result')).toEqual([expect.objectContaining({ turnIds: [S] })])
  })

  it('Stop com o CLI ainda produzindo (recibo por prazo de 5 s) e o seguinte já enviado: o result tardio é do turno parado', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { s, events, feed, setQuery } = session()
    await s.send('primeira', undefined, S)
    feed(start('m1', echo(S)))
    feed(delta('olhando'))
    setQuery({ interrupt: () => new Promise(() => {}) }) // o CLI não responde ao interrupt
    const receipt = s.interrupt()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(receipt).resolves.toEqual({ stillQueued: [] })
    feed(delta(' ainda escrevendo'))
    expect(of(events, 'assistant-text').at(-1)).toMatchObject({ turnIds: [S] })
    await s.send('segunda', undefined, N)
    feed(result({ ...echo(S), is_error: true, subtype: 'error_during_execution', result: undefined }))
    expect(of(events, 'result').at(-1)).toMatchObject({ isError: true, turnIds: [S] })
    feed(start('m2', echo(N)))
    expect(of(events, 'turn-start').at(-1)).toEqual({ kind: 'turn-start', turnIds: [N] })
    feed(result(echo(N)))
    expect(of(events, 'result').at(-1)).toMatchObject({ isError: false, turnIds: [N] })
  })

  it('limite de uso (result com erro, sem texto antes): leva o id', async () => {
    const { s, events, feed } = session()
    await s.send('primeira', undefined, S)
    feed({
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'billing_error',
      message: { content: [{ type: 'text', text: "You've hit your usage limit" }] },
      ...echo(S)
    })
    expect(of(events, 'assistant-text')).toEqual([])
    feed(result({ ...echo(S), is_error: true, result: "You've hit your usage limit" }))
    expect(of(events, 'result')).toEqual([expect.objectContaining({ isError: true, usageExhausted: true, turnIds: [S] })])
  })

  it('error de fim de stream: leva as mensagens enviadas ainda sem result; sem nenhuma, o turno do último result', async () => {
    const tail = session()
    await tail.s.send('primeira', undefined, S)
    tail.feed(start('m1', echo(S)))
    tail.feed(result(echo(S)))
    await tail.die()
    expect(of(tail.events, 'error')).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Agent stopped/), turnIds: [S] })])

    const next = session()
    await next.s.send('primeira', undefined, S)
    next.feed(result(echo(S)))
    await next.s.send('segunda', undefined, N)
    await next.die()
    expect(of(next.events, 'error')).toEqual([expect.objectContaining({ turnIds: [N] })])
  })

  it('o Stop pegou a mensagem antes de o turno começar (sem result): o result do seguinte fecha as duas pendências', async () => {
    const { s, events, feed, die } = session()
    await s.send('primeira', undefined, S)
    await s.send('segunda', undefined, N)
    feed(result(echo(N)))
    await die()
    expect(of(events, 'error').at(-1)).toMatchObject({ turnIds: [N] })
  })

  it('envio depois de a query morrer: não some no input sem leitor — vira error com o id dele', async () => {
    const { s, events, die, pushed } = session()
    await die()
    await s.send('terceira', undefined, T)
    expect(pushed()).not.toContain(T)
    expect(of(events, 'error').at(-1)).toMatchObject({ turnIds: [T] })
  })

  it('CLI sem eco: nada de turnIds nem turn-start (o renderer decide como antes)', async () => {
    const { s, events, feed } = session()
    await s.send('primeira', undefined, S)
    feed(start('m1'))
    feed(delta('oi'))
    feed(result())
    expect(of(events, 'turn-start')).toEqual([])
    expect(of(events, 'assistant-text').at(-1)).not.toHaveProperty('turnIds')
    expect(of(events, 'result')[0]).not.toHaveProperty('turnIds')
  })
})
