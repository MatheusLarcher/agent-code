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
