import { randomUUID } from 'node:crypto'

export class CodexProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexProtocolError'
  }
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicImageBlock {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown }

export interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none'
  name?: string
  disable_parallel_tool_use?: boolean
}

export interface AnthropicMessagesRequest {
  model: string
  system?: string | AnthropicTextBlock[]
  messages: AnthropicMessage[]
  max_tokens?: number
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: { user_id?: string }
  thinking?: { type?: string }
  output_config?: { effort?: string }
}

export interface AnthropicMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

interface CodexTextPart {
  type: 'input_text' | 'output_text'
  text: string
}

interface CodexImagePart {
  type: 'input_image'
  image_url: string
  detail: 'auto'
}

type CodexFunctionOutputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }

export interface CodexFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  [key: string]: unknown
}

export interface CodexReasoningItem {
  type: 'reasoning'
  [key: string]: unknown
}

export type CodexInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer'; content: Array<CodexTextPart | CodexImagePart> }
  | { type: 'additional_tools'; role: 'developer'; tools: CodexFunctionTool[] }
  | CodexFunctionCallItem
  | { type: 'function_call_output'; call_id: string; output: string | CodexFunctionOutputPart[] }
  | CodexReasoningItem

export interface CodexFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: false
}

export interface CodexResponsesRequest {
  model: string
  input: CodexInputItem[]
  instructions?: string
  tools?: CodexFunctionTool[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
  parallel_tool_calls?: boolean
  include?: string[]
  max_output_tokens?: number
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; context?: 'all_turns' }
  prompt_cache_key?: string
  /** Codex fast mode. Only `'priority'` is ever set (and only when the user
   *  enabled the toggle); omitted otherwise, which the backend treats as
   *  `'default'`. See CODEX_FAST_SERVICE_TIER in codexProxy.ts. */
  service_tier?: 'priority'
  stream: boolean
  store: false
}

interface CodexOutputContentPart {
  type: string
  text?: string
  refusal?: string
}

export interface CodexOutputItem {
  type: string
  role?: string
  content?: CodexOutputContentPart[]
  call_id?: string
  name?: string
  arguments?: string
  [key: string]: unknown
}

export interface CodexResponsesResult {
  id?: string
  model?: string
  output?: CodexOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface CodexToolState {
  call: CodexFunctionCallItem
  reasoning: CodexReasoningItem[]
}

/** Keeps provider-only response items beside their public call id. The Claude
 * CLI preserves that id in tool_use/tool_result, which lets the next stateless
 * Codex request restore the exact function_call (and encrypted reasoning) item. */
export class CodexToolStateCache {
  private readonly entries = new Map<string, CodexToolState>()

  constructor(private readonly maxEntries = 4096) {}

  private key(sessionId: string, callId: string): string {
    return JSON.stringify([sessionId, callId])
  }

  get(sessionId: string, callId: string): CodexToolState | undefined {
    const key = this.key(sessionId, callId)
    const found = this.entries.get(key)
    if (!found) return undefined
    this.entries.delete(key)
    this.entries.set(key, found)
    return found
  }

  remember(sessionId: string, calls: CodexFunctionCallItem[], reasoning: CodexReasoningItem[]): void {
    for (const call of calls) {
      this.entries.set(this.key(sessionId, call.call_id), {
        call: { ...call },
        reasoning: reasoning.map((item) => ({ ...item }))
      })
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(content: string | AnthropicTextBlock[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

function toolResultOutput(block: AnthropicToolResultBlock): string | CodexFunctionOutputPart[] {
  const content = block.content
  if (typeof content === 'string') return block.is_error ? `[tool_error]\n${content || 'Tool execution failed.'}` : content
  else if (Array.isArray(content)) {
    const output: CodexFunctionOutputPart[] = []
    if (block.is_error) output.push({ type: 'input_text', text: '[tool_error]' })
    for (const part of content) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') {
        output.push({ type: 'input_text', text: part.text })
        continue
      }
      if (part.type !== 'image') continue
      const source = isRecord(part.source) ? part.source : undefined
      const mediaType =
        typeof source?.media_type === 'string'
          ? source.media_type
          : typeof part.mimeType === 'string'
            ? part.mimeType
            : undefined
      const data = typeof source?.data === 'string' ? source.data : typeof part.data === 'string' ? part.data : undefined
      if (mediaType && data) {
        output.push({ type: 'input_image', image_url: `data:${mediaType};base64,${data}`, detail: 'auto' })
      }
    }
    if (!output.length) return block.is_error ? '[tool_error]\nTool execution failed.' : ''
    if (output.every((part) => part.type === 'input_text')) {
      return output.map((part) => (part.type === 'input_text' ? part.text : '')).join('\n')
    }
    return output
  } else if (content !== undefined) {
    try {
      const text = JSON.stringify(content)
      return block.is_error ? `[tool_error]\n${text}` : text
    } catch {
      const text = String(content)
      return block.is_error ? `[tool_error]\n${text}` : text
    }
  }
  return block.is_error ? '[tool_error]\nTool execution failed.' : ''
}

function toolChoiceOf(choice: AnthropicToolChoice | undefined): CodexResponsesRequest['tool_choice'] {
  if (!choice || choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) return { type: 'function', name: choice.name }
  throw new CodexProtocolError('Anthropic tool_choice is malformed')
}

function reasoningOf(req: AnthropicMessagesRequest): CodexResponsesRequest['reasoning'] {
  if (req.thinking?.type === 'disabled') return { effort: 'none' }
  const effort = req.output_config?.effort
  if (!effort) return undefined
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return { effort }
  }
  throw new CodexProtocolError(`Unsupported reasoning effort: ${effort}`)
}

function validateRequest(req: AnthropicMessagesRequest): void {
  if (!isRecord(req) || typeof req.model !== 'string' || !req.model || !Array.isArray(req.messages)) {
    throw new CodexProtocolError('Malformed Anthropic Messages request')
  }
  if (req.tools !== undefined && !Array.isArray(req.tools)) {
    throw new CodexProtocolError('Anthropic tools must be an array')
  }
}

function appendMessageItems(
  target: CodexInputItem[],
  message: AnthropicMessage,
  cache: CodexToolStateCache | undefined,
  sessionId: string,
  injectedReasoning: Set<string>,
  structuredCallIds: Set<string>,
  fallbackCallIds: Set<string>
): void {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  if (typeof message.content === 'string') {
    target.push({
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
    })
    return
  }
  if (!Array.isArray(message.content)) throw new CodexProtocolError('Anthropic message content is malformed')

  const savedCalls = new Map<string, CodexToolState>()
  if (role === 'assistant') {
    // Responses emits reasoning before any visible preamble/function calls.
    // Look ahead so an Anthropic [text, tool_use] message is reconstructed as
    // [reasoning, message, function_call], not [message, reasoning, call].
    for (const raw of message.content) {
      if (!isRecord(raw) || raw.type !== 'tool_use' || typeof raw.id !== 'string') continue
      const saved = cache?.get(sessionId, raw.id)
      if (!saved) continue
      savedCalls.set(raw.id, saved)
      for (const item of saved.reasoning) {
        const key = typeof item.id === 'string' ? item.id : JSON.stringify(item)
        if (!injectedReasoning.has(key)) {
          injectedReasoning.add(key)
          target.push(item)
        }
      }
    }
  }

  let pending: Array<CodexTextPart | CodexImagePart> = []
  const flush = (): void => {
    if (!pending.length) return
    target.push({ type: 'message', role, content: pending })
    pending = []
  }

  for (const raw of message.content) {
    if (!isRecord(raw) || typeof raw.type !== 'string') throw new CodexProtocolError('Anthropic content block is malformed')
    if (raw.type === 'text' && typeof raw.text === 'string') {
      pending.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: raw.text })
      continue
    }
    if (raw.type === 'image' && role === 'user') {
      const source = isRecord(raw.source) ? raw.source : undefined
      if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
        pending.push({ type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}`, detail: 'auto' })
      }
      continue
    }
    flush()
    if (raw.type === 'tool_use') {
      if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.input)) {
        throw new CodexProtocolError('Anthropic tool_use block is malformed')
      }
      const saved = savedCalls.get(raw.id) ?? cache?.get(sessionId, raw.id)
      if (cache && !saved) {
        fallbackCallIds.add(raw.id)
        target.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `[Tool call ${raw.name} (${raw.id})]\n${JSON.stringify(raw.input)}` }]
        })
        continue
      }
      structuredCallIds.add(raw.id)
      target.push(
        saved?.call ?? {
          type: 'function_call',
          call_id: raw.id,
          name: raw.name,
          arguments: JSON.stringify(raw.input)
        }
      )
      continue
    }
    if (raw.type === 'tool_result') {
      if (typeof raw.tool_use_id !== 'string' || !raw.tool_use_id) {
        throw new CodexProtocolError('Anthropic tool_result block is malformed')
      }
      const output = toolResultOutput(raw as unknown as AnthropicToolResultBlock)
      if ((cache && !structuredCallIds.has(raw.tool_use_id)) || fallbackCallIds.has(raw.tool_use_id)) {
        const content: Array<CodexTextPart | CodexImagePart> = [
          { type: 'input_text', text: `[Tool result ${raw.tool_use_id}]` },
          ...(typeof output === 'string' ? [{ type: 'input_text' as const, text: output }] : output)
        ]
        target.push({ type: 'message', role: 'user', content })
      } else {
        target.push({ type: 'function_call_output', call_id: raw.tool_use_id, output })
      }
    }
  }
  flush()
}

/** Converts the full stateless Anthropic history emitted by Claude Code into
 * Responses input items. No tool is executed here; the SDK remains the host. */
export function toCodexRequest(
  req: AnthropicMessagesRequest,
  cache: CodexToolStateCache | undefined,
  sessionId: string
): CodexResponsesRequest {
  validateRequest(req)
  const input: CodexInputItem[] = []
  const systemText = textOf(req.system)
  const injectedReasoning = new Set<string>()
  const structuredCallIds = new Set<string>()
  const fallbackCallIds = new Set<string>()
  for (const message of req.messages) {
    appendMessageItems(input, message, cache, sessionId, injectedReasoning, structuredCallIds, fallbackCallIds)
  }

  const tools = (req.tools ?? []).map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name || !isRecord(tool.input_schema)) {
      throw new CodexProtocolError('Anthropic tool definition is malformed')
    }
    return {
      type: 'function' as const,
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.input_schema,
      strict: false as const
    }
  })
  const reasoning = reasoningOf(req)

  return {
    model: req.model,
    input,
    ...(systemText ? { instructions: systemText } : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: toolChoiceOf(req.tool_choice),
          parallel_tool_calls: req.tool_choice?.disable_parallel_tool_use !== true,
          include: ['reasoning.encrypted_content']
        }
      : {}),
    ...(typeof req.max_tokens === 'number' ? { max_output_tokens: req.max_tokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    stream: req.stream ?? false,
    store: false
  }
}

/** Shapes the canonical Responses request for the ChatGPT Responses Lite
 * transport used by GPT-5.6. Lite carries tools and instructions inside the
 * input prefix instead of their regular top-level fields. */
export function toCodexWireRequest(req: CodexResponsesRequest, sessionId: string): CodexResponsesRequest {
  if (!req.model.startsWith('gpt-5.6-')) return { ...req, stream: true }

  const prefix: CodexInputItem[] = []
  if (req.tools?.length) prefix.push({ type: 'additional_tools', role: 'developer', tools: req.tools })
  if (req.instructions) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: req.instructions }]
    })
  }

  const { tools: _tools, instructions: _instructions, max_output_tokens: _maxOutputTokens, ...rest } = req
  return {
    ...rest,
    input: [...prefix, ...req.input],
    ...(req.tools?.length ? { tool_choice: 'auto' } : {}),
    parallel_tool_calls: false,
    reasoning: { ...(req.reasoning ?? { effort: 'high' }), context: 'all_turns' },
    prompt_cache_key: sessionId,
    stream: true
  }
}

export function toAnthropicResponse(codex: CodexResponsesResult, model: string): AnthropicMessagesResponse {
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = []
  for (const item of codex.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
      }
    } else if (
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string'
    ) {
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseCodexArguments(item.arguments) })
    }
  }
  const hasTools = content.some((block) => block.type === 'tool_use')
  return {
    id: codex.id ?? `codex_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: codex.usage?.input_tokens ?? 0,
      output_tokens: codex.usage?.output_tokens ?? 0
    }
  }
}

export function parseCodexArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText || '{}')
    if (!isRecord(parsed)) throw new Error('arguments must be a JSON object')
    return parsed
  } catch (error) {
    throw new CodexProtocolError(`Malformed function-call arguments: ${String(error)}`)
  }
}
