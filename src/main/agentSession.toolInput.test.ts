// @vitest-environment node
// Integração do agentSession com toolInputStream.ts: o `stream_event` cru do SDK
// vira `tool-input-delta` só para o agente principal, e o texto ao vivo segue
// como antes.
import { describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
import type { ChatEvent } from '../shared/ipc'

vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', memoriesDir: '', skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => false }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))

import { AgentSession } from './agentSession'

function session(): { feed: (m: unknown) => void; events: ChatEvent[] } {
  const events: ChatEvent[] = []
  const s = new AgentSession({ convId: 'c', cwd: '/p' }, {} as BrowserController, (e) => events.push(e), vi.fn(), vi.fn())
  const feed = (m: unknown): void => (s as unknown as { handleMessage(m: unknown): void }).handleMessage(m)
  return { feed, events }
}

const stream = (event: unknown, parent: string | null = null): unknown => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
  uuid: 'u',
  session_id: 's'
})

const deltas = (events: ChatEvent[]): Array<Extract<ChatEvent, { kind: 'tool-input-delta' }>> =>
  events.filter((e): e is Extract<ChatEvent, { kind: 'tool-input-delta' }> => e.kind === 'tool-input-delta')

describe('AgentSession — tool-input-delta', () => {
  it('emite o código em escrita de um Write do principal, com o estado final no stop', () => {
    const { feed, events } = session()
    feed(stream({ type: 'message_start', message: { id: 'm1' } }))
    feed(stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Write', input: {} } }))
    feed(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/p/a.ts","content":"um\\ndo' } }))
    feed(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'is"}' } }))
    feed(stream({ type: 'content_block_stop', index: 1 }))
    const out = deltas(events)
    expect(out[0]).toEqual({
      kind: 'tool-input-delta',
      toolUseId: 'tu1',
      name: 'Write',
      filePath: '/p/a.ts',
      newText: 'um\ndo',
      totalLines: 2,
      done: false
    })
    expect(out.at(-1)).toMatchObject({ toolUseId: 'tu1', newText: 'um\ndois', totalLines: 2, done: true })
  })

  it('ignora o stream de subagente (parent_tool_use_id não nulo)', () => {
    const { feed, events } = session()
    const parent = 'task-1'
    feed(stream({ type: 'message_start', message: { id: 'm1' } }, parent))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu9', name: 'Write' } }, parent))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content":"x"}' } }, parent))
    feed(stream({ type: 'content_block_stop', index: 0 }, parent))
    expect(deltas(events)).toEqual([])
  })

  it('o fim do turno fecha com done o bloco que o Stop deixou aberto', () => {
    const { feed, events } = session()
    feed(stream({ type: 'message_start', message: { id: 'm1' } }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu2', name: 'Edit' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a","old_string":"x","new_string":"y' } }))
    events.length = 0
    feedTurnIdle(feed)
    expect(deltas(events)).toEqual([
      expect.objectContaining({ toolUseId: 'tu2', oldText: 'x', newText: 'y', done: true })
    ])
  })

  it('o texto ao vivo (text_delta) segue como antes', () => {
    const { feed, events } = session()
    feed(stream({ type: 'message_start', message: { id: 'm1' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'olá' } }))
    expect(events).toEqual([{ kind: 'assistant-text', id: 'm1', text: 'olá', final: false }])
  })
})

const thinks = (events: ChatEvent[]): Array<Extract<ChatEvent, { kind: 'thinking' }>> =>
  events.filter((e): e is Extract<ChatEvent, { kind: 'thinking' }> => e.kind === 'thinking')

const assistant = (content: unknown[], parent: string | null = null): unknown => ({
  type: 'assistant',
  message: { id: 'm1', role: 'assistant', model: 'claude-x', content },
  parent_tool_use_id: parent,
  uuid: 'a',
  session_id: 's'
})

// Integração com thinkingStream.ts: o `thinking_delta` do principal vira
// `thinking` parcial (final:false) e o bloco completo da mensagem `assistant`
// reescreve a MESMA bolha (mesmo id), sem final:false.
describe('AgentSession — thinking ao vivo', () => {
  it('thinking_delta do principal sai como thinking parcial, e o bloco completo reusa o id', () => {
    const { feed, events } = session()
    feed(stream({ type: 'message_start', message: { id: 'm1' } }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Preciso ' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }))
    feed(stream({ type: 'content_block_stop', index: 0 }))
    const live = thinks(events)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ kind: 'thinking', text: 'Preciso ', final: false })
    const liveId = live[0].id
    expect(typeof liveId).toBe('string')

    feed(assistant([{ type: 'thinking', thinking: 'Preciso ler o arquivo', signature: 'sig' }]))
    const full = thinks(events).at(-1)!
    expect(full).toMatchObject({ kind: 'thinking', id: liveId, text: 'Preciso ler o arquivo' })
    expect(full.final).toBeUndefined()
  })

  it('vários blocos thinking: cada bloco completo pega o id do seu bloco ao vivo, na ordem', () => {
    const { feed, events } = session()
    feed(stream({ type: 'message_start', message: { id: 'm1' } }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'um' } }))
    feed(stream({ type: 'content_block_stop', index: 0 }))
    feed(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }))
    feed(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'meio' } }))
    feed(stream({ type: 'content_block_stop', index: 1 }))
    feed(stream({ type: 'content_block_start', index: 2, content_block: { type: 'thinking' } }))
    feed(stream({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'dois' } }))
    feed(stream({ type: 'content_block_stop', index: 2 }))
    const liveIds = thinks(events).map((e) => e.id)
    expect(liveIds).toHaveLength(2)
    expect(liveIds[0]).not.toBe(liveIds[1])

    feed(assistant([
      { type: 'thinking', thinking: 'um' },
      { type: 'text', text: 'meio' },
      { type: 'thinking', thinking: 'dois' }
    ]))
    const full = thinks(events).slice(2)
    expect(full.map((e) => e.id)).toEqual(liveIds)
    expect(full.map((e) => e.text)).toEqual(['um', 'dois'])
    expect(full.every((e) => e.final === undefined)).toBe(true)
  })

  it('bloco thinking sem stream antes ganha id novo', () => {
    const { feed, events } = session()
    feed(assistant([{ type: 'thinking', thinking: 'direto' }]))
    const out = thinks(events)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: 'direto' })
    expect(out[0].id).toMatch(/^e/)
  })

  it('ignora thinking de subagente (parent_tool_use_id não nulo)', () => {
    const { feed, events } = session()
    const parent = 'task-1'
    feed(stream({ type: 'message_start', message: { id: 'm1' } }, parent))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, parent))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } }, parent))
    feed(stream({ type: 'content_block_stop', index: 0 }, parent))
    expect(thinks(events)).toEqual([])
  })
})

/** Um `result` do SDK: é onde a sessão marca o turno ocioso. */
function feedTurnIdle(feed: (m: unknown) => void): void {
  feed({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    session_id: 's',
    uuid: 'r'
  })
}
