import { randomUUID } from 'node:crypto'
import {
  CodexProtocolError,
  CodexToolStateCache,
  parseCodexArguments,
  type CodexFunctionCallItem,
  type CodexReasoningItem
} from './codexProtocol'

export interface AnthropicSSEEvent {
  event: string
  data: Record<string, unknown>
}

interface OpenBlock {
  index: number
  kind: 'text' | 'tool'
  aliases: Set<string>
  callId?: string
  name?: string
  argumentsText: string
  textValue: string
  emittedArguments: boolean
  open: boolean
}

export interface StreamState {
  anthropicId: string
  model: string
  messageStarted: boolean
  nextIndex: number
  blocks: OpenBlock[]
  hasToolUse: boolean
  hasRefusal: boolean
  terminal: boolean
  reasoning: CodexReasoningItem[]
  functionCalls: CodexFunctionCallItem[]
  sessionId: string
  cache?: CodexToolStateCache
}

export function initStreamState(model: string, cache: CodexToolStateCache | undefined, sessionId: string): StreamState {
  return {
    anthropicId: `codex_${randomUUID()}`,
    model,
    messageStarted: false,
    nextIndex: 0,
    blocks: [],
    hasToolUse: false,
    hasRefusal: false,
    terminal: false,
    reasoning: [],
    functionCalls: [],
    sessionId,
    cache
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageStart(state: StreamState): AnthropicSSEEvent {
  state.messageStarted = true
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: state.anthropicId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
  }
}

function aliasesOf(raw: Record<string, unknown>, item?: Record<string, unknown>): Set<string> {
  const aliases = new Set<string>()
  for (const value of [raw.item_id, raw.call_id, item?.id, item?.call_id]) {
    if (typeof value === 'string' && value) aliases.add(value)
  }
  if (typeof raw.output_index === 'number') aliases.add(`output:${raw.output_index}`)
  return aliases
}

function findBlock(state: StreamState, raw: Record<string, unknown>, item?: Record<string, unknown>): OpenBlock | undefined {
  const aliases = aliasesOf(raw, item)
  return state.blocks.find((block) => [...aliases].some((alias) => block.aliases.has(alias)))
}

function ensureStarted(state: StreamState, events: AnthropicSSEEvent[]): void {
  if (!state.messageStarted) events.push(messageStart(state))
}

function startTextBlock(state: StreamState, raw: Record<string, unknown>, events: AnthropicSSEEvent[]): OpenBlock {
  const existing = findBlock(state, raw)
  if (existing) return existing
  ensureStarted(state, events)
  const block: OpenBlock = {
    index: state.nextIndex++,
    kind: 'text',
    aliases: aliasesOf(raw),
    argumentsText: '',
    textValue: '',
    emittedArguments: false,
    open: true
  }
  if (!block.aliases.size) block.aliases.add('text:default')
  state.blocks.push(block)
  events.push({
    event: 'content_block_start',
    data: { type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } }
  })
  return block
}

function startToolBlock(
  state: StreamState,
  raw: Record<string, unknown>,
  item: Record<string, unknown>,
  events: AnthropicSSEEvent[]
): OpenBlock {
  const existing = findBlock(state, raw, item)
  if (existing) return existing
  const callId = typeof item.call_id === 'string' ? item.call_id : typeof raw.call_id === 'string' ? raw.call_id : ''
  const name = typeof item.name === 'string' ? item.name : typeof raw.name === 'string' ? raw.name : ''
  if (!callId || !name) throw new CodexProtocolError('Function call is missing call_id or name')
  ensureStarted(state, events)
  const block: OpenBlock = {
    index: state.nextIndex++,
    kind: 'tool',
    aliases: aliasesOf(raw, item),
    callId,
    name,
    argumentsText: '',
    textValue: '',
    emittedArguments: false,
    open: true
  }
  block.aliases.add(callId)
  state.blocks.push(block)
  state.hasToolUse = true
  events.push({
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'tool_use', id: callId, name, input: {} }
    }
  })
  return block
}

function closeBlock(block: OpenBlock, events: AnthropicSSEEvent[]): void {
  if (!block.open) return
  block.open = false
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: block.index } })
}

function emitArguments(block: OpenBlock, text: string, events: AnthropicSSEEvent[]): void {
  if (!text) return
  block.argumentsText += text
  block.emittedArguments = true
  events.push({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: text } }
  })
}

function emitText(block: OpenBlock, text: string, events: AnthropicSSEEvent[]): void {
  if (!text) return
  block.textValue += text
  events.push({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text } }
  })
}

function completeTool(
  state: StreamState,
  raw: Record<string, unknown>,
  item: Record<string, unknown>,
  events: AnthropicSSEEvent[]
): void {
  const block = startToolBlock(state, raw, item, events)
  const argumentsText = typeof item.arguments === 'string' ? item.arguments : block.argumentsText || '{}'
  if (!block.emittedArguments) emitArguments(block, argumentsText, events)
  if (block.argumentsText !== argumentsText) throw new CodexProtocolError('Function-call argument stream does not match final item')
  parseCodexArguments(argumentsText)
  closeBlock(block, events)
  const call: CodexFunctionCallItem = {
    ...item,
    type: 'function_call',
    call_id: block.callId as string,
    name: block.name as string,
    arguments: argumentsText
  }
  const previous = state.functionCalls.findIndex((known) => known.call_id === call.call_id)
  if (previous >= 0) state.functionCalls[previous] = call
  else state.functionCalls.push(call)
}

function usageOf(raw: Record<string, unknown>): { input_tokens?: number; output_tokens?: number } {
  const response = isRecord(raw.response) ? raw.response : undefined
  const usage = isRecord(response?.usage) ? response.usage : isRecord(raw.usage) ? raw.usage : undefined
  return {
    input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
    output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined
  }
}

function rememberReasoning(state: StreamState, item: Record<string, unknown>): void {
  const key = typeof item.id === 'string' ? item.id : JSON.stringify(item)
  const known = state.reasoning.some((candidate) =>
    (typeof candidate.id === 'string' ? candidate.id : JSON.stringify(candidate)) === key
  )
  if (!known) state.reasoning.push(item as CodexReasoningItem)
}

function completeMessage(
  state: StreamState,
  raw: Record<string, unknown>,
  item: Record<string, unknown>,
  events: AnthropicSSEEvent[]
): void {
  let block = findBlock(state, raw, item)
  const parts = (Array.isArray(item.content) ? item.content : []).filter(isRecord)
  if (parts.some((part) => part.type === 'refusal')) state.hasRefusal = true
  const text = parts
    .map((part) => {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal
      return ''
    })
    .join('')
  if (!block && text) block = startTextBlock(state, { ...raw, item_id: item.id }, events)
  if (block && text) {
    if (!block.textValue) emitText(block, text, events)
    else if (block.textValue !== text) throw new CodexProtocolError('Output-text stream does not match final item')
  }
  if (block) closeBlock(block, events)
}

function ingestCompletedOutput(
  state: StreamState,
  raw: Record<string, unknown>,
  events: AnthropicSSEEvent[]
): void {
  const response = isRecord(raw.response) ? raw.response : undefined
  const output = Array.isArray(response?.output) ? response.output : []
  output.forEach((candidate, outputIndex) => {
    if (!isRecord(candidate)) throw new CodexProtocolError('Codex response output item is malformed')
    const synthetic = { ...raw, item: candidate, item_id: candidate.id, output_index: outputIndex }
    if (candidate.type === 'reasoning') rememberReasoning(state, candidate)
    else if (candidate.type === 'function_call') completeTool(state, synthetic, candidate, events)
    else if (candidate.type === 'message') completeMessage(state, synthetic, candidate, events)
  })
}

function terminalEvents(state: StreamState, raw: Record<string, unknown>, stopReason: 'end_turn' | 'max_tokens'): AnthropicSSEEvent[] {
  if (state.terminal) return []
  const events: AnthropicSSEEvent[] = []
  ensureStarted(state, events)
  for (const block of state.blocks) closeBlock(block, events)
  state.cache?.remember(state.sessionId, state.functionCalls, state.reasoning)
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: state.hasToolUse ? 'tool_use' : state.hasRefusal ? 'refusal' : stopReason, stop_sequence: null },
      usage: usageOf(raw)
    }
  })
  events.push({ event: 'message_stop', data: { type: 'message_stop' } })
  state.terminal = true
  return events
}

export function translateCodexEvent(raw: Record<string, unknown>, state: StreamState): AnthropicSSEEvent[] {
  if (!isRecord(raw) || typeof raw.type !== 'string') throw new CodexProtocolError('Malformed Codex stream event')
  if (state.terminal) return []
  const type = raw.type
  const events: AnthropicSSEEvent[] = []
  const item = isRecord(raw.item) ? raw.item : undefined

  if (type === 'response.output_item.added' && item?.type === 'function_call') {
    startToolBlock(state, raw, item, events)
  } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    if (type === 'response.refusal.delta') state.hasRefusal = true
    const delta = typeof raw.delta === 'string' ? raw.delta : ''
    const block = startTextBlock(state, raw, events)
    emitText(block, delta, events)
  } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
    if (type === 'response.refusal.done') state.hasRefusal = true
    const existing = findBlock(state, raw)
    const finalText =
      type === 'response.refusal.done' && typeof raw.refusal === 'string'
        ? raw.refusal
        : typeof raw.text === 'string'
          ? raw.text
          : existing?.textValue ?? ''
    // Some gateways omit the aggregate value on *.done. Keep the block open so
    // response.completed can still supply the authoritative final content.
    if (!existing && !finalText) return events
    const block = existing ?? startTextBlock(state, raw, events)
    if (!block.textValue && !finalText) return events
    if (!block.textValue) emitText(block, finalText, events)
    else if (block.textValue !== finalText) throw new CodexProtocolError('Output-text stream is incomplete')
    closeBlock(block, events)
  } else if (type === 'response.function_call_arguments.delta') {
    const block = findBlock(state, raw)
    if (!block || block.kind !== 'tool') throw new CodexProtocolError('Function argument delta arrived before its function call')
    if (typeof raw.delta !== 'string') throw new CodexProtocolError('Function argument delta is malformed')
    emitArguments(block, raw.delta, events)
  } else if (type === 'response.function_call_arguments.done') {
    const block = findBlock(state, raw)
    if (!block || block.kind !== 'tool') throw new CodexProtocolError('Function arguments completed before their function call')
    const finalArguments = typeof raw.arguments === 'string' ? raw.arguments : block.argumentsText
    if (!block.emittedArguments) emitArguments(block, finalArguments, events)
    if (block.argumentsText !== finalArguments) throw new CodexProtocolError('Function-call argument stream is incomplete')
    parseCodexArguments(finalArguments)
  } else if (type === 'response.output_item.done' && item?.type === 'function_call') {
    completeTool(state, raw, item, events)
  } else if (type === 'response.output_item.done' && item?.type === 'reasoning') {
    rememberReasoning(state, item)
  } else if (type === 'response.output_item.done' && item?.type === 'message') {
    completeMessage(state, raw, item, events)
  } else if (type === 'response.completed') {
    ingestCompletedOutput(state, raw, events)
    return [...events, ...terminalEvents(state, raw, 'end_turn')]
  } else if (type === 'response.incomplete') {
    ingestCompletedOutput(state, raw, events)
    return [...events, ...terminalEvents(state, raw, 'max_tokens')]
  } else if (type === 'response.failed' || type === 'error') {
    const response = isRecord(raw.response) ? raw.response : undefined
    const error = isRecord(response?.error) ? response.error : isRecord(raw.error) ? raw.error : undefined
    const message = typeof error?.message === 'string' ? error.message : 'Codex response failed'
    throw new CodexProtocolError(message)
  }
  return events
}

export function assertStreamComplete(state: StreamState): void {
  if (!state.terminal) throw new CodexProtocolError('Codex stream ended before a terminal response event')
}
