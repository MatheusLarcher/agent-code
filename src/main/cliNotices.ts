/**
 * Avisos do CLI que o app descartava, traduzidos para a tela: a nova tentativa da
 * API (`system/api_retry`), a negação sem perguntar (`permission_denied`), as
 * linhas do loop (`informational`) e as notificações (`notification`). Contrato:
 * os tipos públicos do sdk.d.ts. Os campos vêm do CLI — tudo é validado aqui, e o
 * que não serve devolve null (nada na tela).
 */
import type { ApiRetryState } from '../shared/apiRetry'

const TEXT_MAX = 400

type Loose = Record<string, unknown>

function asRecord(msg: unknown): Loose | null {
  return msg && typeof msg === 'object' ? (msg as Loose) : null
}

function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** `system/api_retry` → o estado da nova tentativa (`retryAt` = agora + espera). */
export function apiRetryFrom(msg: unknown, now: number): ApiRetryState | null {
  const m = asRecord(msg)
  if (!m || m.subtype !== 'api_retry') return null
  const attempt = finite(m.attempt)
  const maxRetries = finite(m.max_retries)
  const delay = finite(m.retry_delay_ms)
  if (attempt === undefined || maxRetries === undefined || delay === undefined) return null
  const status = finite(m.error_status)
  return {
    attempt,
    maxRetries,
    retryAt: now + Math.max(0, delay),
    status: status ?? null,
    error: typeof m.error === 'string' ? m.error : 'unknown'
  }
}

/** Quem negou, pelo `decision_reason_type`. Fora da lista: sem rótulo. */
const DENIAL_LABEL: Record<string, string> = {
  rule: 'regra de permissão',
  classifier: 'classificador do modo auto',
  mode: 'modo de permissão',
  asyncAgent: 'subagente em segundo plano'
}

/**
 * "Negado sem perguntar (regra de permissão): Bash — Permission to use Bash…". O
 * motivo é o `decision_reason` e, na falta dele, o `message` devolvido ao modelo.
 * `hook` não aparece: é o PreToolUse do próprio app, e o agente já leu o motivo.
 */
export function permissionDeniedText(msg: unknown): string | null {
  const m = asRecord(msg)
  if (!m || m.subtype !== 'permission_denied') return null
  const type = typeof m.decision_reason_type === 'string' ? m.decision_reason_type : ''
  if (type === 'hook') return null
  const tool = text(m.tool_name) ?? 'ferramenta'
  const label = DENIAL_LABEL[type]
  const reason = text(m.decision_reason) ?? text(m.message)
  return `Negado sem perguntar${label ? ` (${label})` : ''}: ${tool}${reason ? ` — ${reason}` : ''}`
}

/** Linha do loop do CLI: 'info' só vale no modo transcrição do terminal; as outras aparecem. */
export function informationalText(msg: unknown): string | null {
  const m = asRecord(msg)
  if (!m || m.subtype !== 'informational' || m.level === 'info') return null
  return text(m.content) ?? null
}

/** A linha de chat de um aviso do CLI (negação, informational, notification); null = nada a mostrar. */
export function cliNoticeText(msg: unknown): string | null {
  return permissionDeniedText(msg) ?? informationalText(msg) ?? notificationText(msg)
}

/** Notificação do CLI: as de prioridade baixa e média ficam fora (as outras aparecem). */
export function notificationText(msg: unknown): string | null {
  const m = asRecord(msg)
  if (!m || m.subtype !== 'notification') return null
  if (m.priority === 'low' || m.priority === 'medium') return null
  return text(m.text) ?? null
}
