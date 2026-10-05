import type { RateLimitStatus } from '@shared/ipc'
import { parseResetFromError } from '@shared/resetTime'

export { parseResetFromError }

export const GENERIC_RETRY_DELAY_MS = 60_000
export const RESET_GRACE_MS = 60_000
export const MAX_GENERIC_RETRIES = 5

export type RecoveryReason = 'limit' | 'transient'

export interface FailureSchedule {
  reason: RecoveryReason
  scheduledAt: number
}

export function shouldRecoverTerminal(kind: 'error' | 'result', isError: boolean, wasInterrupted: boolean): boolean {
  return !wasInterrupted && (kind === 'error' || isError)
}

/** O terminal de um turno, como o App o classifica. */
export interface TerminalVerdictInput {
  kind: 'error' | 'result'
  /** `result` marcado como erro pelo modelo/CLI. */
  isError: boolean
  /** `error` que o main disse não valer repetir (ex.: os dois provedores esgotados). */
  retryable?: boolean
  /** `error` de um turno que morreu ANTES de terminar (contrato em shared/ipc.ts). */
  incomplete?: boolean
  /** O modelo já tinha mostrado texto neste turno. */
  responseReceived: boolean
  /** O usuário parou este turno (Stop): o fim dele é intencional. */
  wasInterrupted: boolean
}

/**
 * O turno falhou e fica suspenso para a recuperação (a fila não anda)? Texto já
 * recebido conta como turno concluído — alguns provedores marcam o fim como erro
 * depois de entregar a resposta —, EXCETO quando o main diz que o turno não
 * terminou (`incomplete`) ou que não vale repetir (`retryable: false`). Stop nunca
 * é falha.
 */
export function isFailedTerminal(t: TerminalVerdictInput): boolean {
  if (!shouldRecoverTerminal(t.kind, t.kind === 'result' && t.isError, t.wasInterrupted)) return false
  if (t.kind === 'error' && (t.incomplete === true || t.retryable === false)) return true
  return !t.responseReceived
}

const LIMIT_RE = /(you(?:'ve| have) hit .*limit|session limit|rate[_ -]?limit|usage limit|limit.*resets?)/i

export function scheduleFailure(
  text: string,
  limits: Record<string, RateLimitStatus>,
  now = Date.now()
): FailureSchedule {
  if (!LIMIT_RE.test(text)) return { reason: 'transient', scheduledAt: now + GENERIC_RETRY_DELAY_MS }
  const parsed = parseResetFromError(text, now)
  if (parsed != null) return { reason: 'limit', scheduledAt: parsed + RESET_GRACE_MS }
  const reset = Object.values(limits)
    .map((limit) => limit.resetsAt)
    .filter((at): at is number => typeof at === 'number' && at > now)
    .sort((a, b) => a - b)[0]
  return { reason: 'limit', scheduledAt: (reset ?? now) + RESET_GRACE_MS }
}
