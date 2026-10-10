import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { isUsageExhausted, sdkUsageExhausted } from './providerQuota'

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

/** A conta Claude escolhida para uma chamada avulsa (`env` ausente = login da máquina). */
export interface ClaudeObserverAccount {
  id: string
  env?: NodeJS.ProcessEnv
}

/**
 * As contas Claude vistas pelos observadores. `pick` devolve a conta da
 * conversa se ela não estourou, senão a de menor uso que ainda tem folga, fora
 * as de `exclude`; `null` = nenhuma sobrou. `markExhausted` tira a conta da
 * escolha até o reset — a mesma marca que a troca do agente principal grava.
 */
export interface ClaudeObserverAccounts {
  pick(conversationId: string | undefined, model: string, exclude: ReadonlySet<string>): Promise<ClaudeObserverAccount | null>
  markExhausted(id: string, text: string): void
}

let claudeAccounts: ClaudeObserverAccounts | null = null

/**
 * Ligado no boot (index.ts) com as contas Claude. Injetado, não importado: o
 * adaptador continua sem depender do store/electron — e os testes também.
 */
export function setClaudeObserverAccounts(accounts: ClaudeObserverAccounts | null): void {
  claudeAccounts = accounts
}

async function pickClaudeAccount(
  conversationId: string | undefined,
  model: string,
  exclude: ReadonlySet<string>
): Promise<ClaudeObserverAccount | null | undefined> {
  if (!claudeAccounts) return undefined
  try {
    return await claudeAccounts.pick(conversationId, model, exclude)
  } catch (error) {
    console.warn('[observador] conta da conversa indisponível, seguindo com o login da máquina:', (error as Error).message)
    return undefined
  }
}

/** Env de uma chamada Claude avulsa (observador, título, curador). Nunca lança. */
export async function claudeObserverEnv(
  conversationId: string | undefined,
  model: string
): Promise<NodeJS.ProcessEnv | undefined> {
  return (await pickClaudeAccount(conversationId, model, new Set()))?.env
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

/**
 * Frame de erro do SDK (sem login, plano, sobrecarga…): o texto dele é a
 * mensagem de erro ("Not logged in · Please run /login"), não a resposta do
 * modelo. O cortado em `max_output_tokens` é resposta de verdade.
 */
function isSdkErrorFrame(message: unknown): boolean {
  const error = (message as { error?: unknown }).error
  return typeof error === 'string' && error !== 'max_output_tokens'
}

async function* singlePrompt(prompt: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null
  } as SDKUserMessage
}

/** Teto de contas Claude tentadas numa chamada avulsa (cada uma, uma vez). */
const MAX_OBSERVER_ACCOUNTS = 8

/**
 * Runs one observer request. The caller owns policy (whether a failed Claude
 * attempt can proceed to Luna); this adapter extracts text, preserves
 * recognized, structured Claude failures and — like the main agent — moves to
 * the next Claude account when the current one hits its usage limit.
 *
 * Claude sem env explícito: a conta da conversa acompanhada; estourou, marca
 * a conta e tenta a próxima com folga. Sem nenhuma, falha com `claude_plan`
 * — o motivo que leva o PO e o memorista à Luna. Env explícito (Luna, ou quem
 * já escolheu a conta) roda uma vez só, como sempre.
 */
export async function runObserverAttempt(request: ObserverRequest): Promise<ObserverAttempt> {
  if (request.env || request.provider !== 'claude') return (await runOnce(request, request.env)).attempt
  const tried = new Set<string>()
  for (let round = 0; round < MAX_OBSERVER_ACCOUNTS; round++) {
    const account = await pickClaudeAccount(request.conversationId, request.model, tried)
    // Sem contas configuradas (ou a escolha falhou): o login da máquina, uma vez.
    if (account === undefined) return (await runOnce(request, undefined)).attempt
    if (account === null) break
    tried.add(account.id)
    const { attempt, exhausted } = await runOnce(request, account.env)
    if (!exhausted) return attempt
    claudeAccounts?.markExhausted(account.id, exhausted)
    console.log(`[observador] conta ${account.id} atingiu o limite de uso; tentando a próxima`)
  }
  return { provider: 'claude', state: 'failed', reason: 'claude_plan' }
}

/** Uma consulta; `exhausted` traz o aviso de limite do provedor, quando houve. */
async function runOnce(
  request: ObserverRequest,
  env: NodeJS.ProcessEnv | undefined
): Promise<{ attempt: ObserverAttempt; exhausted: string | null }> {
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
  let exhausted: string | null = null
  try {
    const q = query({ prompt: singlePrompt(request.prompt), options })
    for await (const message of q) {
      const errorFrame = isSdkErrorFrame(message)
      if (message.type === 'assistant' && !errorFrame) {
        const content = (message.message as { content?: Array<{ type: string; text?: string }> }).content ?? []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') text += block.text
        }
      }
      // O mesmo critério do agente principal: só o frame de erro do provedor
      // com o aviso de limite — nunca o texto normal do modelo.
      if (!exhausted && errorFrame && sdkUsageExhausted(message)) exhausted = frameText(message) || 'usage limit reached'
      if (request.provider === 'claude') reason ??= classifyClaudeObserverFailure(message)
    }
  } catch (error) {
    if (request.provider === 'claude') reason ??= classifyClaudeObserverFailure(error)
    if (!exhausted && isUsageExhausted(error)) exhausted = (error as Error).message
  }

  const usable = text.trim()
  if (usable) return { attempt: { provider: request.provider, state: 'completed', text: usable }, exhausted: null }
  return { attempt: { provider: request.provider, state: 'failed', ...(reason ? { reason } : {}) }, exhausted }
}

function frameText(message: unknown): string {
  const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
  return content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('').trim()
}

/**
 * Compatibility wrapper for the vigia and existing consumers. They retain the
 * old best-effort string contract; only the PO consumes typed attempts.
 */
export async function askObserver(prompt: string, model: string, conversationId?: string): Promise<string> {
  const attempt = await runObserverAttempt({ prompt, model, provider: 'claude', conversationId })
  return attempt.state === 'completed' ? attempt.text : ''
}
