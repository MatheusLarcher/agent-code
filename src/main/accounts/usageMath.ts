import type { AccountUsageReading, UsageWindow } from '../../shared/claudeAccounts'
import { parseResetFromError } from '../../shared/resetTime'

/**
 * Consumo de uma conta a partir das janelas de limite do plano.
 *
 * "Consumo" é o MAIOR percentual entre as janelas que valem para o modelo da
 * conversa — a janela que vai estourar primeiro. Não existe limite mensal.
 */

/** Limite fixo (decisão do usuário, não configurável): a partir daqui a conta
 *  deixa de ser a preferida para conversa nova. */
export const ACCOUNT_SWITCH_THRESHOLD = 95

/** Chaves da resposta de `/usage` que não são janelas de limite do Claude Code:
 *  crédito pago, painel e janelas de outras superfícies (Cowork, apps OAuth de
 *  terceiros). Qualquer outra chave com forma de janela entra na conta. */
const NOT_A_LIMIT = new Set([
  'extra_usage',
  'spend',
  'limits',
  'model_scoped',
  'seven_day_breakdown',
  'member_dashboard_available',
  'seven_day_cowork',
  'seven_day_oauth_apps'
])

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

/** Família do modelo (`claude-opus-5-5` → `opus`), ou null para modelo desconhecido. */
export function modelFamily(model: string | undefined | null): string | null {
  const id = (model ?? '').toLowerCase()
  return MODEL_FAMILIES.find((family) => id.includes(family)) ?? null
}

/** A família a que uma janela pertence, ou null quando vale para todo modelo. */
function windowFamily(key: string): string | null {
  if (key.startsWith('model:')) return modelFamily(key.slice('model:'.length)) ?? key.slice('model:'.length)
  const match = /^seven_day_(\w+)$/.exec(key)
  if (match && (MODEL_FAMILIES as readonly string[]).includes(match[1])) return match[1]
  return null
}

/** Aceita segundos ou milissegundos (o `rate_limit_event` manda segundos). */
export function toEpochMs(value: number | string | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  if (!Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? value * 1000 : value
}

function asWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { utilization?: unknown; resets_at?: unknown }
  if (!('utilization' in raw)) return null
  const utilization = typeof raw.utilization === 'number' && Number.isFinite(raw.utilization) ? raw.utilization : null
  const resetsAt = typeof raw.resets_at === 'string' ? toEpochMs(raw.resets_at) : null
  if (utilization == null && resetsAt == null) return null
  return { utilization, resetsAt }
}

/**
 * Normaliza o `rate_limits` de `usage_EXPERIMENTAL…()` em janelas. Lança quando
 * o formato não é o esperado — é o teste de contrato da API experimental: se
 * ela mudar numa atualização do SDK, a leitura falha e cai na última guardada.
 */
export function windowsFromUsage(rateLimits: unknown): Record<string, UsageWindow> {
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
    throw new Error('usage: rate_limits ausente ou em formato desconhecido')
  }
  const source = rateLimits as Record<string, unknown>
  if (!('five_hour' in source) && !('seven_day' in source)) {
    throw new Error('usage: rate_limits sem five_hour/seven_day')
  }
  const windows: Record<string, UsageWindow> = {}
  for (const [key, value] of Object.entries(source)) {
    if (NOT_A_LIMIT.has(key)) continue
    const window = asWindow(value)
    if (window) windows[key] = window
  }
  // Limite semanal por modelo (ex.: Fable) vem numa lista à parte.
  const scoped = source.model_scoped
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      const name = (entry as { display_name?: unknown })?.display_name
      const window = asWindow(entry)
      if (typeof name === 'string' && name.trim() && window) windows[`model:${name.trim().toLowerCase()}`] = window
    }
  }
  return windows
}

/** Uma janela vinda do `rate_limit_event` (utilização em fração 0–1). */
export function windowFromRateLimitEvent(info: {
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
  status?: string
}): { key: string; window: UsageWindow } | null {
  if (!info.rateLimitType || info.rateLimitType === 'overage') return null
  let utilization: number | null = typeof info.utilization === 'number' ? info.utilization * 100 : null
  // Estouro sem número: o próprio status já diz que a janela acabou.
  if (utilization == null && info.status === 'rejected') utilization = 100
  const resetsAt = toEpochMs(info.resetsAt)
  if (utilization == null && resetsAt == null) return null
  return { key: info.rateLimitType, window: { utilization, resetsAt } }
}

/**
 * Junta janelas novas à leitura anterior (evento traz uma janela por vez).
 * Janela nova sem número (`utilization` null — o `rate_limit_event` com status
 * `allowed` não traz) mantém o número anterior enquanto a janela anterior não
 * venceu: ausência de dado não é 0%.
 */
export function mergeReading(
  previous: AccountUsageReading | null,
  windows: Record<string, UsageWindow>,
  at: number
): AccountUsageReading {
  const merged = { ...(previous?.windows ?? {}) }
  for (const [key, window] of Object.entries(windows)) {
    const old = merged[key]
    const keepOld = window.utilization == null && old?.utilization != null && (old.resetsAt == null || old.resetsAt > at)
    merged[key] = keepOld ? { utilization: old.utilization, resetsAt: window.resetsAt ?? old.resetsAt } : window
  }
  return { at, windows: merged }
}

/** Janela que o aviso de estouro do CLI nomeia (`You've hit your weekly limit`). */
const LIMIT_WINDOWS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsession limit\b/i, 'five_hour'],
  // "weekly limit" e "you have reached your weekly usage limit".
  [/\bweekly (?:usage )?limit\b/i, 'seven_day'],
  // "Opus limit", "Fable 5 limit", "Fable 5.1 requires usage credits".
  [/\bopus\b/i, 'seven_day_opus'],
  [/\bsonnet\b/i, 'seven_day_sonnet'],
  [/\bfable\b/i, 'model:fable']
]

const HOUR_MS = 3_600_000
/**
 * Prazo máximo da marca de esgotada quando o reset não é conhecido — nem da API
 * nem do texto do aviso. É a duração da própria janela: uma janela de 5h não
 * fica esgotada por mais de 5h, e a semanal (geral ou por modelo) por mais de 7
 * dias. O aviso sem janela reconhecível (`exhausted`, vale para todo modelo)
 * fica com o prazo da janela mais curta do plano (5h): liberar cedo demais custa
 * uma tentativa que estoura e troca de novo (sem laço, `triedAccounts`); liberar
 * tarde prenderia a conta por dias.
 */
export const EXHAUSTED_MAX_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
  seven_day_opus: 7 * 24 * HOUR_MS,
  seven_day_sonnet: 7 * 24 * HOUR_MS,
  'model:fable': 7 * 24 * HOUR_MS,
  exhausted: 5 * HOUR_MS
}

/**
 * A leitura de uma conta que acabou de estourar: a janela citada no aviso vai a
 * 100% até o reset. O reset é, nesta ordem: o `resetsAt` já conhecido da janela
 * (vem da API, exato ao segundo), o horário escrito no aviso ("resets 11pm
 * (America/Sao_Paulo)") ou o prazo máximo da janela. Nunca fica sem prazo: a
 * conta volta a ser elegível mesmo que as consultas de consumo dela falhem.
 * Aviso sem janela reconhecível marca a conta toda (`exhausted`).
 */
/** O aviso traz DATA ("resets Oct 3, 9am (…)"), não só a hora: o CLI só põe a data a mais de 24h. */
const EXPLICIT_DATE_RE = /resets?\s+[a-z]{3}\s+\d{1,2},/i
const LONGEST_WINDOW_MS = Math.max(...Object.values(EXHAUSTED_MAX_MS))

export function exhaustedReading(previous: AccountUsageReading | null, text: string, now: number): AccountUsageReading {
  const key = LIMIT_WINDOWS.find(([pattern]) => pattern.test(text))?.[1] ?? 'exhausted'
  const knownReset = previous?.windows[key]?.resetsAt ?? null
  const maxReset = now + EXHAUSTED_MAX_MS[key]
  // O texto nunca passa do prazo da janela. O CLI trunca o reset para o minuto:
  // "resets 11pm" lido às 23:00:30 cai em "amanhã" (+24h) — numa janela de 5h
  // isso prenderia a conta um dia inteiro. No aviso genérico (`exhausted`) a
  // janela é desconhecida: o prazo de 5h vale só para o reset com hora; com data
  // explícita (dias à frente), o teto é o da janela mais longa (7 dias).
  const textCap = key === 'exhausted' && EXPLICIT_DATE_RE.test(text) ? now + LONGEST_WINDOW_MS : maxReset
  const parsed = parseResetFromError(text, now)
  const textReset = parsed != null ? Math.min(parsed, textCap) : null
  const resetsAt =
    knownReset != null && knownReset > now ? knownReset
      : textReset != null && textReset > now ? textReset
        : maxReset
  return mergeReading(previous, { [key]: { utilization: 100, resetsAt } }, now)
}

/**
 * Consumo (0–100) de uma leitura para um modelo. Janela cujo `resetsAt` já
 * passou conta como zerada. Sem leitura = 0 ("com folga").
 */
export function accountConsumption(
  reading: AccountUsageReading | null,
  model: string | undefined | null,
  now = Date.now()
): number {
  if (!reading) return 0
  const family = modelFamily(model)
  let max = 0
  for (const [key, window] of Object.entries(reading.windows)) {
    const owner = windowFamily(key)
    if (owner && owner !== family) continue
    if (window.resetsAt != null && window.resetsAt <= now) continue
    if (window.utilization != null && window.utilization > max) max = window.utilization
  }
  return Math.min(100, max)
}
