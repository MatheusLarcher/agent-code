// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CodexProtocolError,
  CodexToolStateCache,
  toAnthropicResponse,
  toCodexRequest,
  toCodexWireRequest,
  type AnthropicMessagesRequest,
  type CodexFunctionCallItem,
  type CodexInputItem
} from './codexProtocol'
import {
  assertStreamComplete,
  initStreamState,
  translateCodexEvent,
  type AnthropicSSEEvent,
  type StreamState
} from './codexStream'

const MODEL = 'gpt-5.6-sol'
const SESSION_A = 'session-alpha'
const SESSION_B = 'session-bravo'

function request(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'Execute a tarefa.' }],
    ...overrides
  }
}

function toolRequest(
  toolChoice?: AnthropicMessagesRequest['tool_choice']
): AnthropicMessagesRequest {
  return request({
    tools: [
      {
        name: 'Read',
        description: 'Read one file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          required: ['file_path'],
          additionalProperties: false
        }
      }
    ],
    ...(toolChoice ? { tool_choice: toolChoice } : {})
  })
}

function translate(state: StreamState, ...rawEvents: Array<Record<string, unknown>>): AnthropicSSEEvent[] {
  return rawEvents.flatMap((event) => translateCodexEvent(event, state))
}

function eventNames(events: AnthropicSSEEvent[]): string[] {
  return events.map((event) => event.event)
}

function eventDeltas(events: AnthropicSSEEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data.delta as Record<string, unknown>)
}

function functionCall(
  callId: string,
  name: string,
  argumentsText: string,
  id = `item-${callId}`
): CodexFunctionCallItem {
  return { type: 'function_call', id, call_id: callId, name, arguments: argumentsText }
}

describe('Codex protocol — Anthropic request to Responses request', () => {
  it('preserves tool names, descriptions and the complete JSON schema', () => {
    const out = toCodexRequest(toolRequest(), undefined, SESSION_A)

    expect(out.tools).toEqual([
      {
        type: 'function',
        name: 'Read',
        description: 'Read one file',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          required: ['file_path'],
          additionalProperties: false
        },
        strict: false
      }
    ])
    expect(out.tool_choice).toBe('auto')
    expect(out.parallel_tool_calls).toBe(true)
    expect(out.include).toEqual(['reasoning.encrypted_content'])
  })

  it('shapes GPT-5.6 requests for Responses Lite', () => {
    const canonical = toCodexRequest(
      toolRequest({ type: 'any', disable_parallel_tool_use: false }),
      undefined,
      SESSION_A
    )
    canonical.instructions = 'Use the available tools.'

    const wire = toCodexWireRequest(canonical, SESSION_A)

    expect(wire.tools).toBeUndefined()
    expect(wire.instructions).toBeUndefined()
    expect(wire.max_output_tokens).toBeUndefined()
    expect(wire.input[0]).toEqual({ type: 'additional_tools', role: 'developer', tools: canonical.tools })
    expect(wire.input[1]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Use the available tools.' }]
    })
    expect(wire.tool_choice).toBe('auto')
    expect(wire.parallel_tool_calls).toBe(false)
    expect(wire.reasoning).toEqual({ effort: 'high', context: 'all_turns' })
    expect(wire.prompt_cache_key).toBe(SESSION_A)
  })

  it.each([
    [{ type: 'auto' as const }, 'auto'],
    [{ type: 'any' as const }, 'required'],
    [{ type: 'none' as const }, 'none'],
    [{ type: 'tool' as const, name: 'Read' }, { type: 'function', name: 'Read' }]
  ])('maps tool_choice %# without converting it to prompt text', (choice, expected) => {
    const out = toCodexRequest(toolRequest(choice), undefined, SESSION_A)
    expect(out.tool_choice).toEqual(expected)
  })

  it('maps disable_parallel_tool_use independently from all four choices', () => {
    const enabled = toCodexRequest(toolRequest({ type: 'auto', disable_parallel_tool_use: false }), undefined, SESSION_A)
    const disabled = toCodexRequest(toolRequest({ type: 'any', disable_parallel_tool_use: true }), undefined, SESSION_A)

    expect(enabled.parallel_tool_calls).toBe(true)
    expect(disabled.parallel_tool_calls).toBe(false)
  })

  it('keeps assistant tool_use and user tool_result string/array/error as structured items', () => {
    const out = toCodexRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: 'a.txt' } },
              { type: 'tool_use', id: 'call-shell', name: 'Bash', input: { command: 'exit 1' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call-read', content: 'arquivo real' },
              {
                type: 'tool_result',
                tool_use_id: 'call-shell',
                is_error: true,
                content: [
                  { type: 'text', text: 'process failed' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
                ]
              }
            ]
          }
        ]
      }),
      undefined,
      SESSION_A
    )

    expect(out.input).toEqual([
      { type: 'function_call', call_id: 'call-read', name: 'Read', arguments: '{"file_path":"a.txt"}' },
      { type: 'function_call', call_id: 'call-shell', name: 'Bash', arguments: '{"command":"exit 1"}' },
      { type: 'function_call_output', call_id: 'call-read', output: 'arquivo real' },
      {
        type: 'function_call_output',
        call_id: 'call-shell',
        output: [
          { type: 'input_text', text: '[tool_error]' },
          { type: 'input_text', text: 'process failed' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' }
        ]
      }
    ])
  })

  it('converts a base64 Anthropic image into an input_image data URL', () => {
    const out = toCodexRequest(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
              { type: 'text', text: 'O que aparece?' }
            ]
          }
        ]
      }),
      undefined,
      SESSION_A
    )

    expect(out.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' },
          { type: 'input_text', text: 'O que aparece?' }
        ]
      }
    ])
  })

  it('maps max_tokens and reasoning effort without changing OAuth transport fields', () => {
    const withEffort = toCodexRequest(
      request({ max_tokens: 2048, output_config: { effort: 'max' } }),
      undefined,
      SESSION_A
    )
    const disabled = toCodexRequest(
      request({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } }),
      undefined,
      SESSION_A
    )

    expect(withEffort.max_output_tokens).toBe(2048)
    expect(withEffort.reasoning).toEqual({ effort: 'max' })
    expect(disabled.reasoning).toEqual({ effort: 'none' })
  })
})

describe('Codex protocol — non-streaming response back to Anthropic', () => {
  it('returns text and function calls as text/tool_use blocks with the original call id', () => {
    const out = toAnthropicResponse(
      {
        id: 'resp-1',
        output: [
          { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Vou ler.' }] },
          functionCall('call-read', 'Read', '{"file_path":"a.txt"}')
        ],
        usage: { input_tokens: 11, output_tokens: 7 }
      },
      MODEL
    )

    expect(out.content).toEqual([
      { type: 'text', text: 'Vou ler.' },
      { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: 'a.txt' } }
    ])
    expect(out.stop_reason).toBe('tool_use')
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 7 })
  })

  it('rejects malformed function-call arguments instead of fabricating an empty input', () => {
    expect(() =>
      toAnthropicResponse(
        { output: [functionCall('call-bad', 'Read', '{"file_path":')] },
        MODEL
      )
    ).toThrow(CodexProtocolError)
  })
})

describe('Codex protocol — structured streaming', () => {
  it('streams one function call with argument deltas and terminates as tool_use', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    const events = translate(
      state,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: functionCall('call-read', 'Read', '', 'fc-read')
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-read', delta: '{"file_' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-read', delta: 'path":"a.txt"}' },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc-read',
        arguments: '{"file_path":"a.txt"}'
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: functionCall('call-read', 'Read', '{"file_path":"a.txt"}', 'fc-read')
      },
      { type: 'response.completed', response: { usage: { output_tokens: 9 } } }
    )

    expect(eventNames(events)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(eventDeltas(events)).toEqual([
      { type: 'input_json_delta', partial_json: '{"file_' },
      { type: 'input_json_delta', partial_json: 'path":"a.txt"}' }
    ])
    expect(events.at(-2)?.data.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null })
    assertStreamComplete(state)
  })

  it('keeps interleaved parallel calls in distinct block indexes and call ids', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    const events = translate(
      state,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: functionCall('call-a', 'Read', '', 'fc-a')
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: functionCall('call-b', 'Glob', '', 'fc-b')
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-b', output_index: 1, delta: '{"pattern":"*.ts"}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-a', output_index: 0, delta: '{"file_path":"a.ts"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc-a', output_index: 0, arguments: '{"file_path":"a.ts"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc-b', output_index: 1, arguments: '{"pattern":"*.ts"}' },
      { type: 'response.output_item.done', output_index: 0, item: functionCall('call-a', 'Read', '{"file_path":"a.ts"}', 'fc-a') },
      { type: 'response.output_item.done', output_index: 1, item: functionCall('call-b', 'Glob', '{"pattern":"*.ts"}', 'fc-b') },
      { type: 'response.completed', response: {} }
    )

    const starts = events.filter((event) => event.event === 'content_block_start')
    expect(starts.map((event) => event.data.index)).toEqual([0, 1])
    expect(starts.map((event) => event.data.content_block)).toEqual([
      { type: 'tool_use', id: 'call-a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'call-b', name: 'Glob', input: {} }
    ])
    expect(events.filter((event) => event.event === 'content_block_stop').map((event) => event.data.index)).toEqual([0, 1])
  })

  it('preserves a text block followed by a tool block in the same response', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    const events = translate(
      state,
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg-1', delta: 'Vou consultar.' },
      { type: 'response.output_text.done', output_index: 0, item_id: 'msg-1' },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: functionCall('call-read', 'Read', '', 'fc-read')
      },
      { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc-read', arguments: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: functionCall('call-read', 'Read', '{}', 'fc-read') },
      { type: 'response.completed', response: {} }
    )

    const starts = events.filter((event) => event.event === 'content_block_start')
    expect(starts.map((event) => event.data.content_block)).toEqual([
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'call-read', name: 'Read', input: {} }
    ])
    expect(eventDeltas(events)).toEqual([
      { type: 'text_delta', text: 'Vou consultar.' },
      { type: 'input_json_delta', partial_json: '{}' }
    ])
    expect(events.at(-2)?.data.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null })
  })

  it('uses a complete output_item.done when no argument delta was emitted', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    const events = translate(
      state,
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: functionCall('call-read', 'Read', '{"file_path":"late.txt"}', 'fc-late')
      },
      { type: 'response.completed', response: {} }
    )

    expect(eventNames(events).slice(0, 4)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop'
    ])
    expect(eventDeltas(events)[0]).toEqual({
      type: 'input_json_delta',
      partial_json: '{"file_path":"late.txt"}'
    })
  })

  it('rejects malformed streamed arguments before completing the tool block', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)

    expect(() =>
      translateCodexEvent(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: functionCall('call-bad', 'Read', '{"file_path":', 'fc-bad')
        },
        state
      )
    ).toThrow(CodexProtocolError)
  })

  it('rejects a function call without an executor name or call id', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    expect(() =>
      translateCodexEvent(
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: '', name: '', arguments: '{}' } },
        state
      )
    ).toThrow(/call_id|name/i)
  })
})

describe('Codex protocol — stream failure and terminal invariants', () => {
  it('throws the provider failure message instead of converting response.failed into success', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)

    expect(() =>
      translateCodexEvent(
        { type: 'response.failed', response: { error: { message: 'backend exploded' } } },
        state
      )
    ).toThrow('backend exploded')
  })

  it('rejects EOF before response.completed/incomplete', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    translateCodexEvent({ type: 'response.output_text.delta', item_id: 'msg-1', delta: 'partial' }, state)

    expect(() => assertStreamComplete(state)).toThrow('ended before a terminal')
  })

  it('emits one terminal only and ignores provider events after it', () => {
    const state = initStreamState(MODEL, undefined, SESSION_A)
    const first = translateCodexEvent({ type: 'response.completed', response: {} }, state)
    const duplicate = translateCodexEvent({ type: 'response.completed', response: {} }, state)
    const late = translateCodexEvent({ type: 'response.output_text.delta', delta: 'late' }, state)

    expect([...first, ...duplicate, ...late].filter((event) => event.event === 'message_stop')).toHaveLength(1)
    expect(duplicate).toEqual([])
    expect(late).toEqual([])
    expect(() => assertStreamComplete(state)).not.toThrow()
  })
})

describe('Codex protocol — tool reasoning cache', () => {
  function rememberCall(
    cache: CodexToolStateCache,
    sessionId: string,
    reasoningId: string,
    encryptedContent: string,
    name: string,
    argumentValue: string
  ): void {
    const state = initStreamState(MODEL, cache, sessionId)
    translateCodexEvent(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningId, encrypted_content: encryptedContent }
      },
      state
    )
    translateCodexEvent(
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: functionCall('shared-call-id', name, JSON.stringify({ value: argumentValue }), `item-${sessionId}`)
      },
      state
    )
    translateCodexEvent({ type: 'response.completed', response: {} }, state)
  }

  function replay(cache: CodexToolStateCache, sessionId: string): CodexInputItem[] {
    return toCodexRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'shared-call-id', name: 'placeholder', input: { value: 'placeholder' } }]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'shared-call-id', content: `result-${sessionId}` }]
          }
        ]
      }),
      cache,
      sessionId
    ).input
  }

  it('isolates encrypted reasoning by explicit sessionId even when call_id is identical', () => {
    const cache = new CodexToolStateCache()
    rememberCall(cache, SESSION_A, 'reason-a', 'encrypted-a', 'Read', 'a.txt')
    rememberCall(cache, SESSION_B, 'reason-b', 'encrypted-b', 'Glob', '*.ts')

    const replayA = replay(cache, SESSION_A)
    const replayB = replay(cache, SESSION_B)

    expect(replayA).toEqual([
      { type: 'reasoning', id: 'reason-a', encrypted_content: 'encrypted-a' },
      functionCall('shared-call-id', 'Read', '{"value":"a.txt"}', `item-${SESSION_A}`),
      { type: 'function_call_output', call_id: 'shared-call-id', output: `result-${SESSION_A}` }
    ])
    expect(replayB).toEqual([
      { type: 'reasoning', id: 'reason-b', encrypted_content: 'encrypted-b' },
      functionCall('shared-call-id', 'Glob', '{"value":"*.ts"}', `item-${SESSION_B}`),
      { type: 'function_call_output', call_id: 'shared-call-id', output: `result-${SESSION_B}` }
    ])
  })
})
