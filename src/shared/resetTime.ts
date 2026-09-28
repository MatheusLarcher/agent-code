/**
 * Horário de reset escrito no aviso de limite do CLI. O claude.exe formata o
 * reset (função `ud`, 0.3.283) como `resets 11pm (America/Sao_Paulo)`,
 * `resets 2:10am (…)` ou, a mais de 24h, `resets Oct 1, 9pm (…)` — com o ano
 * (`Oct 1, 2027, 9:30pm`) quando não é o ano corrente. Sem o fuso entre
 * parênteses não há como saber o instante: devolve null.
 *
 * Usado pelo renderer (nova tentativa na hora do reset) e pelo main (até quando
 * a conta esgotada fica fora da escolha).
 */
const RESET_RE = /resets?\s+(?:([a-z]{3})\s+(\d{1,2}),\s*(?:(\d{4}),\s*)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

type WallClock = { year: number; month: number; day: number; hour: number; minute: number }

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
function zonedEpoch(fields: WallClock, timeZone: string): number {
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
  const [, rawMonth, rawDay, rawYear, rawHour, rawMinute, meridiem, timeZone] = match
  try {
    let hour = Number(rawHour) % 12
    if (meridiem.toLowerCase() === 'pm') hour += 12
    const minute = rawMinute ? Number(rawMinute) : 0
    const here = zonedParts(now, timeZone)
    if (rawMonth) {
      // Data explícita: é aquele dia; no passado, o aviso está velho.
      const month = MONTHS.indexOf(rawMonth.toLowerCase()) + 1
      if (month === 0) return null
      const at = zonedEpoch({ year: rawYear ? Number(rawYear) : here.year, month, day: Number(rawDay), hour, minute }, timeZone)
      return at > now ? at : null
    }
    // Só a hora: hoje, ou amanhã se a hora já passou.
    let candidate = zonedEpoch({ year: here.year, month: here.month, day: here.day, hour, minute }, timeZone)
    if (candidate <= now) {
      const tomorrow = new Date(Date.UTC(here.year, here.month - 1, here.day) + 86_400_000)
      candidate = zonedEpoch(
        { year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour, minute },
        timeZone
      )
    }
    return candidate
  } catch {
    return null
  }
}
