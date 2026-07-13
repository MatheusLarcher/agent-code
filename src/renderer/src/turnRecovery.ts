import type { RateLimitStatus } from '@shared/ipc'

export const GENERIC_RETRY_DELAY_MS = 60_000
export const RESET_GRACE_MS = 60_000
export const MAX_GENERIC_RETRIES = 5

export type RecoveryReason = 'limit' | 'transient'

export interface FailureSchedule {
  reason: RecoveryReason
  scheduledAt: number
}

const LIMIT_RE = /(you(?:'ve| have) hit .*limit|session limit|rate[_ -]?limit|usage limit|limit.*resets?)/i
const RESET_RE = /resets?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i

function zonedParts(at: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(at))
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
}

/** Convert wall-clock fields in an IANA timezone to epoch milliseconds. */
function zonedEpoch(fields: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): number {
  let guess = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute)
  for (let i = 0; i < 2; i++) {
    const actual = zonedParts(guess, timeZone)
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    guess -= rendered - Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute)
  }
  return guess
}

export function parseResetFromError(text: string, now = Date.now()): number | null {
  const match = RESET_RE.exec(text)
  if (!match) return null
  const [, rawHour, rawMinute, meridiem, timeZone] = match
  try {
    let hour = Number(rawHour) % 12
    if (meridiem.toLowerCase() === 'pm') hour += 12
    const here = zonedParts(now, timeZone)
    let candidate = zonedEpoch(
      { year: here.year, month: here.month, day: here.day, hour, minute: Number(rawMinute) },
      timeZone
    )
    if (candidate <= now) {
      const tomorrow = new Date(Date.UTC(here.year, here.month - 1, here.day) + 86_400_000)
      candidate = zonedEpoch(
        {
          year: tomorrow.getUTCFullYear(),
          month: tomorrow.getUTCMonth() + 1,
          day: tomorrow.getUTCDate(),
          hour,
          minute: Number(rawMinute)
        },
        timeZone
      )
    }
    return candidate
  } catch {
    return null
  }
}

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
