import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { CodexTokens } from './codexAuth'

vi.mock('./codexAuth', () => ({
  getValidCodexTokens: vi.fn(async () => null),
  refreshCodexTokens: vi.fn(async () => null)
}))

const {
  buildCodexHeaders,
  cacheScopeForAccount,
  consumeCodexStream,
  friendlyCodexError,
  initStreamState,
  sessionIdOf,
  toCodexRequest,
  toolRoundsInCurrentTurn,
  translateCodexEvent,
  CodexHttpError,
  CodexProtocolError,
  CodexToolStateCache
} =
  await import('./codexProxy')

const tokens: CodexTokens = {
  accessToken: 'at_test',
  refreshToken: 'rt_test',
  idToken: 'id_test',
  accountId: 'account_test',
  expiresAt: Date.now() + 60_000
}

describe('Codex proxy headers and session correlation', () => {
  it('uses OAuth and the explicit Claude session id for the Codex request', () => {
    const headers = buildCodexHeaders(tokens, 'session_12345678')
    expect(headers).toMatchObject({
      Authorization: 'Bearer at_test',
      'chatgpt-account-id': 'account_test',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.146.0',
      version: '0.146.0',
      session_id: 'session_12345678',
      'session-id': 'session_12345678',
      'thread-id': 'session_12345678'
    })
  })

  it('adds the Responses Lite compatibility header when requested', () => {
    expect(buildCodexHeaders(tokens, 'session_12345678', true)).toMatchObject({
      'x-openai-internal-codex-responses-lite': 'true'
    })
  })

  it('generates isolated ids only when no upstream session exists', () => {
    expect(buildCodexHeaders(tokens).session_id).not.toBe(buildCodexHeaders(tokens).session_id)
  })

  it('prefers the validated Claude session header', () => {
    const request = { headers: { 'x-claude-code-session-id': 'header_session_123' } } as unknown as IncomingMessage
    const body = {
      model: 'gpt-5.6-sol',
      messages: [],
      metadata: { user_id: JSON.stringify({ session_id: 'metadata_session_123' }) }
    }
    expect(sessionIdOf(request, body)).toBe('header_session_123')
  })

  it('falls back to a validated session in metadata', () => {
    const request = { headers: {} } as IncomingMessage
    const body = {
      model: 'gpt-5.6-sol',
      messages: [],
      metadata: { user_id: JSON.stringify({ session_id: 'metadata_session_123' }) }
    }
    expect(sessionIdOf(request, body)).toBe('metadata_session_123')
  })

  it('does not trust malformed session metadata', () => {
    const request = {
      headers: { 'x-claude-code-session-id': '../../other-session' }
    } as unknown as IncomingMessage
    const body = { model: 'gpt-5.6-sol', messages: [], metadata: { user_id: '{bad-json' } }
    expect(sessionIdOf(request, body)).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('friendlyCodexError', () => {
  it.each([
    [401, /reconecte/i],
    [403, /recusou/i],
    [429, /limite de uso/i],
    [502, /instável/i]
  ])('maps HTTP %s to an actionable message', (status, expected) => {
    expect(friendlyCodexError(new CodexHttpError(status, 'detail'))).toMatch(expected)
  })

  it('distinguishes a malformed provider response from a network failure', () => {
    expect(friendlyCodexError(new CodexProtocolError('bad event'))).toMatch(/malformada/i)
    expect(friendlyCodexError(new Error('fetch failed'))).toMatch(/rede|backend/i)
  })

  it('shows the structured provider reason for an HTTP 400 without exposing arbitrary bodies', () => {
    expect(
      friendlyCodexError(
        new CodexHttpError(
          400,
          'Codex backend returned HTTP 400',
          '{"error":{"message":"Model not found gpt-5.6-luna"}}'
        )
      )
    ).toContain('Model not found gpt-5.6-luna')
    expect(friendlyCodexError(new CodexHttpError(400, 'bad', '<html>secret</html>'))).not.toContain('secret')
  })
})

describe('Codex text stream fallbacks', () => {
  it('preserves text when output_text.done arrives without deltas', () => {
    const state = initStreamState('gpt-5.6-sol', undefined, 'session_12345678')
    const events = translateCodexEvent(
      { type: 'response.output_text.done', item_id: 'msg-1', output_index: 0, text: 'resposta final' },
      state
    )
    expect(events.find((event) => event.event === 'content_block_delta')?.data.delta).toEqual({
      type: 'text_delta',
      text: 'resposta final'
    })
  })

  it('uses response.completed when output_text.done omits its aggregate text', () => {
    const state = initStreamState('gpt-5.6-sol', undefined, 'session_12345678')
    expect(
      translateCodexEvent({ type: 'response.output_text.done', item_id: 'msg-1', output_index: 0 }, state)
    ).toEqual([])

    const events = translateCodexEvent(
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', id: 'msg-1', content: [{ type: 'output_text', text: 'texto recuperado' }] }]
        }
      },
      state
    )
    expect(events.filter((event) => event.event === 'content_block_start')).toHaveLength(1)
    expect(events.some((event) => JSON.stringify(event.data).includes('texto recuperado'))).toBe(true)
  })
})

describe('Codex per-turn loop accounting', () => {
  it('counts tool-result rounds only after the latest real user message', () => {
    expect(
      toolRoundsInCurrentTurn([
        { role: 'user', content: 'turno antigo' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'ok' }] },
        { role: 'user', content: 'turno atual' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'b', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'c', content: 'ok' }
          ]
        }
      ])
    ).toBe(2)
  })
})

describe('Codex resumed-history fallback', () => {
  it('replays an uncached completed tool cycle as transcript instead of invalid provider state', () => {
    const out = toCodexRequest(
      {
        model: 'gpt-5.6-sol',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: 'Read', input: { file_path: 'a' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'conteúdo salvo' }] }
        ]
      },
      new CodexToolStateCache(),
      'session_12345678'
    )
    expect(out.input.some((item) => item.type === 'function_call' || item.type === 'function_call_output')).toBe(false)
    expect(JSON.stringify(out.input)).toContain('conteúdo salvo')
  })

  it('never replays encrypted reasoning across ChatGPT accounts', () => {
    const cache = new CodexToolStateCache()
    cache.remember(
      cacheScopeForAccount('session_12345678', 'account-a'),
      [{ type: 'function_call', call_id: 'same-call', name: 'Read', arguments: '{"file_path":"a"}' }],
      [{ type: 'reasoning', id: 'reason-a', encrypted_content: 'secret-from-account-a' }]
    )
    const out = toCodexRequest(
      {
        model: 'gpt-5.6-sol',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'same-call', name: 'Read', input: { file_path: 'a' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same-call', content: 'ok' }] }
        ]
      },
      cache,
      cacheScopeForAccount('session_12345678', 'account-b')
    )
    expect(JSON.stringify(out.input)).not.toContain('secret-from-account-a')
  })
})

describe('Codex terminal stream behavior', () => {
  it('maps refusal text, stop reason and final input/output usage', () => {
    const state = initStreamState('gpt-5.6-sol', undefined, 'session_12345678')
    const events = [
      ...translateCodexEvent({ type: 'response.refusal.delta', item_id: 'msg-r', output_index: 0, delta: 'não posso' }, state),
      ...translateCodexEvent({ type: 'response.refusal.done', item_id: 'msg-r', output_index: 0, refusal: 'não posso' }, state),
      ...translateCodexEvent(
        { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } },
        state
      )
    ]
    expect(events.some((event) => JSON.stringify(event.data).includes('não posso'))).toBe(true)
    expect(events.find((event) => event.event === 'message_delta')?.data).toMatchObject({
      delta: { stop_reason: 'refusal' },
      usage: { input_tokens: 7, output_tokens: 3 }
    })
  })

  it('cancels the provider body immediately after a terminal event', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{}}\n\n'))
        },
        cancel() {
          cancelled = true
        }
      })
    )
    const state = initStreamState('gpt-5.6-sol', undefined, 'session_12345678')
    await consumeCodexStream(response, (event) => {
      translateCodexEvent(event, state)
      return !state.terminal
    })
    expect(cancelled).toBe(true)
  })
})
