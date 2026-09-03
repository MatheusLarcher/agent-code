import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { RateLimitStatus } from '../shared/ipc'
import { getValidCodexTokens, refreshCodexTokensAfter, type CodexTokens } from './codexAuth'
import {
  CodexProtocolError,
  CodexToolStateCache,
  toAnthropicResponse,
  toCodexRequest,
  toCodexWireRequest,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResponse,
  type AnthropicMessage,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type CodexResponsesRequest,
  type CodexResponsesResult
} from './codexProtocol'
import {
  assertStreamComplete,
  initStreamState,
  translateCodexEvent,
  type AnthropicSSEEvent,
  type StreamState
} from './codexStream'

export {
  CodexProtocolError,
  CodexToolStateCache,
  assertStreamComplete,
  initStreamState,
  toAnthropicResponse,
  toCodexRequest,
  toCodexWireRequest,
  translateCodexEvent
}
export type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicSSEEvent,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  CodexResponsesRequest,
  CodexResponsesResult,
  StreamState
}

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_ORIGINATOR = 'codex_cli_rs'
// The ChatGPT Codex router uses this protocol version together with the
// originator when resolving newer model aliases (including GPT-5.6 Luna).
// Keep it aligned with a released Codex client that supports those models.
const CODEX_CLIENT_VERSION = '0.146.0'
const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`
/** Suffix `agentSession` appends to the loopback auth token to ask for fast
 *  mode on that one conversation. The proxy is process-wide and shared by every
 *  conversation, so a proxy-level flag would leak across chats; the token is the
 *  only per-session value we control end to end. */
export const FAST_MODE_TOKEN_SUFFIX = '+fast'

/** Codex's only non-default `service_tier`. Measured on 2026-09-03 against
 *  gpt-5.6-sol: ~1.6x output throughput and ~30% lower total latency over 10
 *  paired runs (both orderings). Two traps worth keeping in mind:
 *  1. The response echoes `service_tier: "default"` even when priority is
 *     applied — the echo is NOT a usable confirmation, only timing is.
 *  2. The backend rejects every unknown parameter and every other tier value
 *     (`fast`, `auto`, `flex`, `scale` all return HTTP 400), so this exact
 *     string is the whole supported surface. */
const CODEX_FAST_SERVICE_TIER = 'priority'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
export const DEFAULT_MAX_TOOL_ROUNDS = 64

type FetchLike = typeof fetch

export class CodexHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly responseDetail?: string
  ) {
    super(message)
    this.name = 'CodexHttpError'
  }
}

/** Headers expected by the ChatGPT Codex backend. Passing a session id keeps
 * provider-only tool state correlated across the Claude CLI's loop. */
export function buildCodexHeaders(
  tokens: CodexTokens,
  sessionId: string = randomUUID(),
  responsesLite = false
): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'chatgpt-account-id': tokens.accountId,
    originator: CODEX_ORIGINATOR,
    'User-Agent': CODEX_USER_AGENT,
    version: CODEX_CLIENT_VERSION,
    session_id: sessionId,
    'session-id': sessionId,
    'thread-id': sessionId,
    ...(responsesLite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {})
  }
}

async function codexHttpError(response: Response): Promise<CodexHttpError> {
  const detail = (await response.text().catch(() => '')).slice(0, 2_000)
  return new CodexHttpError(
    response.status,
    `Codex backend returned HTTP ${response.status}`,
    detail || undefined
  )
}

async function openCodexResponsesStream(
  tokens: CodexTokens,
  body: CodexResponsesRequest,
  sessionId: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<Response> {
  const responsesLite = body.model.startsWith('gpt-5.6-')
  const wireBody = toCodexWireRequest(body, sessionId)
  const response = await fetchImpl(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildCodexHeaders(tokens, sessionId, responsesLite),
    body: JSON.stringify(wireBody),
    signal
  })
  if (!response.ok) throw await codexHttpError(response)
  if (!response.body) throw new CodexProtocolError('Codex backend returned an empty stream')
  return response
}

function parseSSEFrame(frame: string, onEvent: (raw: Record<string, unknown>) => boolean | void): boolean {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    throw new CodexProtocolError(`Malformed JSON in Codex SSE stream: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CodexProtocolError('Codex SSE data must be a JSON object')
  }
  return onEvent(parsed as Record<string, unknown>) !== false
}

/** Reads fragmented LF or CRLF SSE frames and rejects malformed provider data
 * instead of silently turning protocol corruption into a successful turn. */
export async function consumeCodexStream(
  response: Response,
  onEvent: (raw: Record<string, unknown>) => boolean | void
): Promise<void> {
  if (!response.body) throw new CodexProtocolError('Codex backend returned an empty stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const normalized = buffer.replace(/\r\n/g, '\n')
      const frames = normalized.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        if (!parseSSEFrame(frame, onEvent)) {
          ended = true
          // A valid terminal event already belongs to the client. A provider-side
          // cancellation failure must not append an error after message_stop.
          await reader.cancel().catch(() => undefined)
          return
        }
      }
      if (done) break
    }
    if (buffer.trim()) parseSSEFrame(buffer, onEvent)
    ended = true
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Public transport helper used by focused tests and the local server. */
export async function streamCodexResponses(
  tokens: CodexTokens,
  body: CodexResponsesRequest,
  onEvent: (raw: Record<string, unknown>) => void,
  options: { sessionId?: string; fetchImpl?: FetchLike; signal?: AbortSignal } = {}
): Promise<void> {
  const response = await openCodexResponsesStream(
    tokens,
    body,
    options.sessionId ?? randomUUID(),
    options.fetchImpl ?? fetch,
    options.signal
  )
  await consumeCodexStream(response, onEvent)
}

function writeSSE(response: ServerResponse, event: AnthropicSSEEvent): void {
  response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
}

function sendAnthropicError(response: ServerResponse, status: number, type: string, message: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

function writeAnthropicStreamError(response: ServerResponse, error: unknown): void {
  writeSSE(response, {
    event: 'error',
    data: { type: 'error', error: { type: 'api_error', message: friendlyCodexError(error) } }
  })
}

export interface CodexProxyHandle {
  port: number
  close: () => Promise<void>
}

export interface CodexProxyDeps {
  getTokens: () => Promise<CodexTokens | null>
  refreshTokens: (failedAccessToken: string) => Promise<CodexTokens | null>
  secret: string
  fetchImpl?: FetchLike
  toolStateCache?: CodexToolStateCache
  maxToolRounds?: number
  log?: (line: string) => void
  /** Called with the ChatGPT plan usage windows found on an upstream response
   *  (see `parseCodexRateLimitHeaders`). Never called when the headers are absent. */
  onRateLimit?: (limits: RateLimitStatus[]) => void
}

/** Reads the ChatGPT plan usage that the Codex backend attaches to every
 *  response as `x-codex-{primary,secondary}-*` headers — the same headers the
 *  official Codex CLI uses for its `/status` display. Primary is the short
 *  window, secondary the long one; both carry the used percentage (0..100),
 *  the window length in minutes and the seconds until reset. Two spellings of
 *  the reset header exist across Codex versions, so both are accepted. Returns
 *  [] when nothing usable is present (no header, or an unparsable percent). */
export function parseCodexRateLimitHeaders(
  headers: { get(name: string): string | null },
  now: number = Date.now()
): RateLimitStatus[] {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name)
    if (raw === null) return undefined
    const value = Number(raw.trim())
    return Number.isFinite(value) ? value : undefined
  }
  const out: RateLimitStatus[] = []
  for (const [window, type] of [
    ['primary', 'gpt_primary'],
    ['secondary', 'gpt_secondary']
  ] as const) {
    const used = num(`x-codex-${window}-used-percent`)
    if (used === undefined) continue
    const utilization = Math.min(1, Math.max(0, used / 100))
    const resetSeconds =
      num(`x-codex-${window}-resets-in-seconds`) ?? num(`x-codex-${window}-reset-after-seconds`)
    const windowMinutes = num(`x-codex-${window}-window-minutes`)
    out.push({
      rateLimitType: type,
      status: utilization >= 1 ? 'rejected' : utilization >= 0.8 ? 'allowed_warning' : 'allowed',
      utilization,
      ...(resetSeconds !== undefined ? { resetsAt: now + resetSeconds * 1000 } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      updatedAt: now
    })
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Counts model/tool round-trips since the latest real user input. Parallel
 * tool results in one user message are one round, matching the harness loop. */
export function toolRoundsInCurrentTurn(messages: AnthropicMessage[]): number {
  let rounds = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      rounds = 0
      continue
    }
    if (!Array.isArray(message.content)) continue
    const blocks = message.content.filter(isRecord)
    if (blocks.some((block) => block.type !== 'tool_result')) rounds = 0
    if (blocks.some((block) => block.type === 'tool_result')) rounds++
  }
  return rounds
}

/** Provider-only reasoning must never cross a ChatGPT account boundary, even
 * when two accounts happen to use the same Claude session/call ids. */
export function cacheScopeForAccount(sessionId: string, accountId: string): string {
  return JSON.stringify([accountId, sessionId])
}

function bindSessionAccount(accounts: Map<string, string>, sessionId: string, accountId: string): void {
  const existing = accounts.get(sessionId)
  if (existing && existing !== accountId) {
    throw new CodexHttpError(401, 'This Codex session belongs to a different ChatGPT account')
  }
  if (existing) {
    return
  }
  accounts.set(sessionId, accountId)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new CodexProtocolError('Anthropic request body is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : undefined
}

/** The Claude CLI keeps this id stable for a query, including child agents. */
export function sessionIdOf(request: IncomingMessage, body: AnthropicMessagesRequest): string {
  const header = request.headers['x-claude-code-session-id']
  const fromHeader = validSessionId(Array.isArray(header) ? header[0] : header)
  if (fromHeader) return fromHeader
  const userId = body.metadata?.user_id
  if (typeof userId === 'string') {
    try {
      const metadata = JSON.parse(userId) as { session_id?: unknown }
      const fromMetadata = validSessionId(metadata.session_id)
      if (fromMetadata) return fromMetadata
    } catch {
      // An opaque metadata user id is valid Anthropic input, just not a session key.
    }
  }
  return randomUUID()
}

async function openWithAuthRetry(
  deps: CodexProxyDeps,
  body: CodexResponsesRequest,
  sessionId: string,
  sessionAccounts: Map<string, string>,
  signal: AbortSignal,
  initialTokens: CodexTokens
): Promise<Response> {
  const tokens = initialTokens
  bindSessionAccount(sessionAccounts, sessionId, tokens.accountId)
  try {
    return await openCodexResponsesStream(tokens, body, sessionId, deps.fetchImpl ?? fetch, signal)
  } catch (error) {
    if (!(error instanceof CodexHttpError) || error.status !== 401) throw error
    deps.log?.('codex proxy: upstream 401; reusing or refreshing OAuth token once')
    const refreshed = await deps.refreshTokens(tokens.accessToken).catch((refreshError) => {
      deps.log?.(`codex proxy: OAuth refresh failed: ${String(refreshError)}`)
      return null
    })
    if (!refreshed) throw new CodexHttpError(401, 'ChatGPT session expired')
    bindSessionAccount(sessionAccounts, sessionId, refreshed.accountId)
    return openCodexResponsesStream(refreshed, body, sessionId, deps.fetchImpl ?? fetch, signal)
  }
}

/** Validates the loopback `Authorization` header and reads the per-conversation
 *  fast-mode opt-in off it. Returns null when the secret does not match, so an
 *  unknown caller can never reach the upstream. The suffix is only honoured on
 *  an otherwise exact secret match — it grants no access of its own. */
export function parseProxyCredential(
  header: string | string[] | undefined,
  secret: string
): { fastMode: boolean } | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null
  const token = raw.slice('Bearer '.length)
  if (token === secret) return { fastMode: false }
  if (token === `${secret}${FAST_MODE_TOKEN_SUFFIX}`) return { fastMode: true }
  return null
}

async function handleMessages(
  request: IncomingMessage,
  response: ServerResponse,
  deps: CodexProxyDeps,
  cache: CodexToolStateCache,
  sessionAccounts: Map<string, string>
): Promise<void> {
  const credential = parseProxyCredential(request.headers.authorization, deps.secret)
  if (!credential) {
    sendAnthropicError(response, 401, 'authentication_error', 'Invalid local proxy credentials.')
    return
  }

  let body: AnthropicMessagesRequest
  try {
    const parsed: unknown = JSON.parse(await readBody(request))
    if (!isRecord(parsed)) throw new CodexProtocolError('Anthropic request body must be a JSON object')
    body = parsed as unknown as AnthropicMessagesRequest
  } catch (error) {
    sendAnthropicError(response, 400, 'invalid_request_error', String(error))
    return
  }

  const sessionId = sessionIdOf(request, body)
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  let initialTokens: CodexTokens
  try {
    const tokens = await deps.getTokens()
    if (!tokens) throw new CodexHttpError(401, 'ChatGPT account is not connected')
    bindSessionAccount(sessionAccounts, sessionId, tokens.accountId)
    initialTokens = tokens
  } catch (error) {
    const status = error instanceof CodexHttpError ? error.status : 502
    const type = status === 401 ? 'authentication_error' : 'api_error'
    sendAnthropicError(response, status, type, friendlyCodexError(error))
    return
  }

  const cacheSessionId = cacheScopeForAccount(sessionId, initialTokens.accountId)
  let codexBody: CodexResponsesRequest
  try {
    codexBody = toCodexRequest({ ...body, stream: true }, cache, cacheSessionId)
    if (credential.fastMode) codexBody.service_tier = CODEX_FAST_SERVICE_TIER
  } catch (error) {
    sendAnthropicError(response, 400, 'invalid_request_error', String(error))
    return
  }
  const maxToolRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 1) {
    sendAnthropicError(response, 500, 'api_error', 'Codex proxy has an invalid tool-round limit.')
    return
  }
  if (toolRoundsInCurrentTurn(body.messages) >= maxToolRounds) {
    sendAnthropicError(
      response,
      400,
      'invalid_request_error',
      `Codex tool-call loop stopped after ${maxToolRounds} rounds in the current turn.`
    )
    return
  }

  let upstream: Response
  try {
    upstream = await openWithAuthRetry(deps, codexBody, sessionId, sessionAccounts, controller.signal, initialTokens)
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return
    const status = error instanceof CodexHttpError ? error.status : 502
    const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error'
    sendAnthropicError(response, status, type, friendlyCodexError(error))
    return
  }

  if (deps.onRateLimit) {
    const limits = parseCodexRateLimitHeaders(upstream.headers)
    if (limits.length > 0) deps.onRateLimit(limits)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const state = initStreamState(body.model, cache, cacheSessionId)
  try {
    await consumeCodexStream(upstream, (event) => {
      for (const translated of translateCodexEvent(event, state)) writeSSE(response, translated)
      return !state.terminal
    })
    assertStreamComplete(state)
  } catch (error) {
    deps.log?.(`codex proxy: stream failed: ${String(error)}`)
    if (!controller.signal.aborted && !response.writableEnded) writeAnthropicStreamError(response, error)
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

export function friendlyCodexError(error: unknown): string {
  const status = error instanceof CodexHttpError ? error.status : (error as { status?: number } | undefined)?.status
  if (status === 401) return 'Sua sessão do ChatGPT expirou. Reconecte em Configurações → OpenAI.'
  if (status === 403) return 'A OpenAI recusou esta chamada do Codex. Reconecte a conta ou tente novamente.'
  if (status === 429) return 'O limite de uso do seu plano ChatGPT foi atingido. Aguarde o reset ou troque de modelo.'
  if (typeof status === 'number' && status >= 500) return 'O backend do Codex está instável. Tente novamente em instantes.'
  if (status === 400) {
    const detail = error instanceof CodexHttpError ? friendlyProviderDetail(error.responseDetail) : undefined
    return detail
      ? `O Codex recusou a solicitação (HTTP 400): ${detail}`
      : 'O Codex recusou a solicitação (HTTP 400). Verifique o modelo selecionado e tente novamente.'
  }
  if (error instanceof CodexProtocolError) return `Resposta malformada do Codex: ${error.message}`
  return 'Não consegui completar a resposta pelo Codex por uma falha de rede ou do backend.'
}

function friendlyProviderDetail(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) {
      const error = parsed.error
      const message = isRecord(error) ? error.message : parsed.message
      if (typeof message === 'string') return cleanProviderMessage(message)
    }
  } catch {
    // Only structured provider messages are safe and useful to expose in UI.
  }
  return undefined
}

function cleanProviderMessage(message: string): string | undefined {
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  return clean || undefined
}

/** Starts the loopback-only Anthropic compatibility endpoint used by the
 * bundled Claude CLI. Tool execution remains entirely inside that harness. */
export function startCodexProxyServer(deps: CodexProxyDeps): Promise<CodexProxyHandle> {
  const cache = deps.toolStateCache ?? new CodexToolStateCache()
  const sessionAccounts = new Map<string, string>()
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        return
      }
      if (request.method === 'POST' && request.url?.startsWith('/v1/messages')) {
        void handleMessages(request, response, deps, cache, sessionAccounts).catch((error) => {
          deps.log?.(`codex proxy: unhandled request failure: ${String(error)}`)
          if (!response.headersSent) sendAnthropicError(response, 500, 'api_error', friendlyCodexError(error))
          else if (!response.writableEnded) {
            writeAnthropicStreamError(response, error)
            response.end()
          }
        })
        return
      }
      response.writeHead(404).end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      deps.log?.(`codex proxy listening on 127.0.0.1:${port}`)
      resolve({
        port,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())))
      })
    })
  })
}

let running: Promise<{ baseUrl: string; secret: string }> | null = null
let rateLimitListener: ((limits: RateLimitStatus[]) => void) | null = null

/** Registers the single process-wide consumer of GPT usage snapshots (the main
 *  process forwards them to the renderer as `rate-limit` events). The proxy is
 *  shared by every conversation, so this is account-level, not per chat. */
export function onCodexRateLimit(listener: ((limits: RateLimitStatus[]) => void) | null): void {
  rateLimitListener = listener
}

export function ensureCodexProxyRunning(log?: (line: string) => void): Promise<{ baseUrl: string; secret: string }> {
  if (running) return running
  const secret = randomUUID()
  running = startCodexProxyServer({
    getTokens: getValidCodexTokens,
    refreshTokens: refreshCodexTokensAfter,
    secret,
    log,
    onRateLimit: (limits) => rateLimitListener?.(limits)
  })
    .then((handle) => ({ baseUrl: `http://127.0.0.1:${handle.port}`, secret }))
    .catch((error) => {
      running = null
      throw error
    })
  return running
}
