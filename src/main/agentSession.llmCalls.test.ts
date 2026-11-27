// @vitest-environment node
// Cada linha de llm_calls é UMA resposta do modelo: guarda o usage daquela
// resposta. O modelUsage do result (total acumulado do turno) não pode
// sobrescrever as chamadas — só completar a que veio zerada.
import { describe, expect, it, vi } from 'vitest'
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

const MODEL = 'claude-sonnet-5-5'
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

function session() {
  const events: ChatEvent[] = []
  let n = 0
  const insertLlmCall = vi.fn(async () => ({ id: `row-${++n}` }) as never)
  const updateLlmCall = vi.fn(async () => null)
  const s = new AgentSession(
    { convId: 'c-llm', cwd: '/p' },
    {} as BrowserController,
    (e) => events.push(e),
    vi.fn(),
    vi.fn(),
    undefined,
    undefined,
    undefined,
    undefined,
    { insertLlmCall, updateLlmCall, insertTurnTime: async () => undefined } as never
  )
  const feed = (m: unknown): void => (s as unknown as { handleMessage(m: unknown): void }).handleMessage(m)
  /** O que ficou gravado em cada linha: o último update dela. */
  const rows = (): Record<string, unknown> =>
    Object.fromEntries(updateLlmCall.mock.calls.map((c) => c as unknown as [string, unknown]))
  const lastEventTokens = (seq: number): unknown =>
    events.filter((e): e is Extract<ChatEvent, { kind: 'llm-call' }> => e.kind === 'llm-call' && e.seq === seq).at(-1)?.tokens
  return { feed, rows, lastEventTokens, insertLlmCall, events }
}

const assistant = (u: Usage) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    model: MODEL,
    usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
    content: [{ type: 'text', text: 'ok' }]
  }
})
const result = (total: Usage) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  modelUsage: {
    [MODEL]: { inputTokens: total.input, outputTokens: total.output, cacheReadInputTokens: total.cacheRead, cacheCreationInputTokens: total.cacheWrite }
  }
})
const row = (u: Usage) => ({ inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('AgentSession — uso por chamada (llm_calls)', () => {
  it('3 respostas no turno: cada linha guarda o próprio uso, não o total do result', async () => {
    const { feed, rows, lastEventTokens } = session()
    const a = { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }
    const b = { input: 20, output: 200, cacheRead: 2000, cacheWrite: 60 }
    const c = { input: 30, output: 300, cacheRead: 3000, cacheWrite: 70 }
    feed(assistant(a))
    feed(assistant(b))
    feed(assistant(c))
    await flush()
    feed(result({ input: 60, output: 600, cacheRead: 6000, cacheWrite: 180 }))
    await flush()
    expect(rows()).toEqual({ 'row-1': row(a), 'row-2': row(b), 'row-3': row(c) })
    expect([1, 2, 3].map(lastEventTokens)).toEqual([a, b, c])
  })

  it('chamada que veio zerada recebe só o que falta do total do modelo', async () => {
    const { feed, rows, lastEventTokens } = session()
    const a = { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    feed(assistant(a))
    feed(assistant(zero))
    await flush()
    feed(result({ input: 25, output: 140, cacheRead: 1500, cacheWrite: 50 }))
    await flush()
    const rest = { input: 15, output: 40, cacheRead: 500, cacheWrite: 0 }
    expect(rows()).toEqual({ 'row-1': row(a), 'row-2': row(rest) })
    expect(lastEventTokens(2)).toEqual(rest)
  })
})

// O SDK manda uma mensagem `assistant` por bloco (texto, ferramenta, pensamento),
// todas com o mesmo message.id e o mesmo usage: é UMA resposta da API.
const block = (id: string, u: Usage, content: unknown, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: {
    id,
    model: MODEL,
    usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
    content: [content]
  }
})
const text = { type: 'text', text: 'ok' }
const usage = { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }
const llmEvents = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { kind: 'llm-call' }> => e.kind === 'llm-call')

describe('AgentSession — uma linha por resposta (message.id)', () => {
  it('3 blocos com o mesmo message.id contam o uso uma vez só', async () => {
    const { feed, insertLlmCall, events } = session()
    feed(block('msg_1', usage, text))
    feed(block('msg_1', usage, { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }))
    feed(block('msg_1', usage, text))
    await flush()
    expect(insertLlmCall).toHaveBeenCalledTimes(1)
    expect(insertLlmCall).toHaveBeenCalledWith(expect.objectContaining(row(usage)))
    expect(llmEvents(events)).toHaveLength(1)
  })

  it('ids diferentes continuam sendo chamadas separadas', async () => {
    const { feed, insertLlmCall } = session()
    feed(block('msg_1', usage, text))
    feed(block('msg_2', usage, text))
    await flush()
    expect(insertLlmCall).toHaveBeenCalledTimes(2)
  })

  it('Task no 2º bloco de uma resposta ainda vira pai do subagente', async () => {
    const { feed, events } = session()
    feed(block('msg_1', usage, text))
    feed(block('msg_1', usage, { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'x', prompt: 'y' } }))
    const root = llmEvents(events)[0].node_id
    feed(block('msg_sub', usage, text, 'task-1'))
    await flush()
    expect(llmEvents(events).at(-1)).toMatchObject({ node_id: 'task-1', parent_node_id: root })
  })
})
