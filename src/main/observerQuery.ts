import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** A reason the PO may safely expose and use to move from Claude to Luna. */
export type SafeProviderReason = 'claude_plan' | 'claude_auth' | 'claude_authorization'

export type ObserverAttempt =
  | { provider: 'claude' | 'gpt-luna'; state: 'completed'; text: string }
  | { provider: 'claude' | 'gpt-luna'; state: 'not-started' | 'failed'; reason?: SafeProviderReason }

export interface ObserverRuntime {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ObserverRequest extends ObserverRuntime {
  prompt: string
  model: string
  provider: 'claude' | 'gpt-luna'
  /** Conversa acompanhada: o observador Claude usa a MESMA conta dela. */
  conversationId?: string
}

/** Resolve o env da conta Claude de uma conversa (undefined = login da máquina). */
export type ClaudeObserverEnvResolver = (
  conversationId: string | undefined,
  model: string
) => Promise<NodeJS.ProcessEnv | undefined>

let claudeEnvResolver: ClaudeObserverEnvResolver | null = null

/**
 * Ligado no boot (index.ts) com as contas Claude. Injetado, não importado: o
 * adaptador continua sem depender do store/electron — e os testes também.
 */
export function setClaudeObserverEnvResolver(resolver: ClaudeObserverEnvResolver | null): void {
  claudeEnvResolver = resolver
}

/** Env de uma chamada Claude avulsa (observador, título, curador). Nunca lança. */
export async function claudeObserverEnv(
  conversationId: string | undefined,
  model: string
): Promise<NodeJS.ProcessEnv | undefined> {
  if (!claudeEnvResolver) return undefined
  try {
    return await claudeEnvResolver(conversationId, model)
  } catch (error) {
    console.warn('[observador] conta da conversa indisponível, seguindo com o login da máquina:', (error as Error).message)
    return undefined
  }
}

/**
 * Reduces only explicit provider codes emitted by the SDK to the three PO
 * failover reasons. HTTP status, message text and arbitrary exceptions are
 * deliberately not interpreted: a 401/403 without an SDK classification is
 * ambiguous and must not start a second provider.
 */
export function classifyClaudeObserverFailure(value: unknown): SafeProviderReason | undefined {
  if (!value || typeof value !== 'object') return undefined

  // Agent SDK 0.3.278 exposes classified provider failures on the assistant
  // frame. Do not broaden this to lookalike exception/status fields: that
  // would turn arbitrary HTTP failures into an unsafe second-provider call.
  const failure = value as { type?: unknown; error?: unknown }
  if (failure.type !== 'assistant') return undefined

  switch (failure.error) {
    case 'billing_error':
    case 'account_on_hold':
      return 'claude_plan'
    case 'authentication_failed':
      return 'claude_auth'
    case 'oauth_org_not_allowed':
      return 'claude_authorization'
    default:
      return undefined
  }
}

async function* singlePrompt(prompt: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null
  } as SDKUserMessage
}

/**
 * Runs exactly one observer request. The caller owns policy (whether a failed
 * Claude attempt can proceed to Luna); this adapter only extracts text and
 * preserves recognized, structured Claude failures.
 */
export async function runObserverAttempt(request: ObserverRequest): Promise<ObserverAttempt> {
  // Claude sem env explícito: a conta da conversa acompanhada. Luna já vem com
  // o env do proxy do GPT.
  const env =
    request.env ?? (request.provider === 'claude' ? await claudeObserverEnv(request.conversationId, request.model) : undefined)
  const options: Options = {
    cwd: request.cwd,
    model: request.model,
    ...(env ? { env } : {}),
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    // Sem a auto-memória do CLI: a única pasta de memória é a de Configurações.
    settings: { autoMemoryEnabled: false }
  }

  let text = ''
  let reason: SafeProviderReason | undefined
  try {
    const q = query({ prompt: singlePrompt(request.prompt), options })
    for await (const message of q) {
      if (message.type === 'assistant') {
        const content = (message.message as { content?: Array<{ type: string; text?: string }> }).content ?? []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') text += block.text
        }
      }
      if (request.provider === 'claude') reason ??= classifyClaudeObserverFailure(message)
    }
  } catch (error) {
    if (request.provider === 'claude') reason ??= classifyClaudeObserverFailure(error)
  }

  const usable = text.trim()
  if (usable) return { provider: request.provider, state: 'completed', text: usable }
  return { provider: request.provider, state: 'failed', ...(reason ? { reason } : {}) }
}

/**
 * Compatibility wrapper for the vigia and existing consumers. They retain the
 * old best-effort string contract; only the PO consumes typed attempts.
 */
export async function askObserver(prompt: string, model: string, conversationId?: string): Promise<string> {
  const attempt = await runObserverAttempt({ prompt, model, provider: 'claude', conversationId })
  return attempt.state === 'completed' ? attempt.text : ''
}
