import type { RateLimitStatus } from '@shared/ipc'
import type { AccountUsageReading, ClaudeAccountView } from '@shared/claudeAccounts'

/** Janelas que o painel sabe rotular, na ordem das pílulas. */
const KNOWN: Array<RateLimitStatus['rateLimitType']> = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

/**
 * Leitura de uma conta → as mesmas pílulas do painel de sempre (utilização em
 * fração 0–1, `resetsAt` em ms). Janela já zerada (`resetsAt` passado) aparece
 * como 0%, igual à regra de troca. Janela só com o horário (sem o número) fica
 * sem `utilization`: ausência de dado não é 0% usado (a pílula ainda mostra 0;
 * a energia do escritório mostra "sem leitura").
 */
export function readingToLimits(reading: AccountUsageReading | null, now = Date.now()): RateLimitStatus[] {
  if (!reading) return []
  const out: RateLimitStatus[] = []
  for (const type of KNOWN) {
    const window = reading.windows[type]
    if (!window || (window.utilization == null && window.resetsAt == null)) continue
    const expired = window.resetsAt != null && window.resetsAt <= now
    const pct = expired ? 0 : window.utilization
    out.push({
      rateLimitType: type,
      status: (pct ?? 0) >= 100 ? 'rejected' : (pct ?? 0) >= 80 ? 'allowed_warning' : 'allowed',
      ...(pct != null ? { utilization: pct / 100 } : {}),
      ...(window.resetsAt != null && !expired ? { resetsAt: window.resetsAt } : {}),
      updatedAt: reading.at
    })
  }
  return out
}

/** Texto de quando a leitura chegou sem o número da janela de 5 h (o mesmo do escritório). */
export const FIVE_HOUR_UNREAD = 'janela de 5 h sem leitura'

/**
 * Pílulas da barra do topo: a janela de 5 h sem número (ausente na leitura —
 * a API passou a mandar `five_hour: null` — ou só com o horário) sai das
 * pílulas, que a mostrariam como 0% usado, e vira `fiveHourUnread` ("—").
 * Janela já zerada continua lida (0%). Sem leitura nenhuma, não é "sem leitura de 5 h".
 */
export function barLimits(reading: AccountUsageReading | null, now = Date.now()): { limits: RateLimitStatus[]; fiveHourUnread: boolean } {
  const limits = readingToLimits(reading, now).filter((l) => l.rateLimitType !== 'five_hour' || l.utilization != null)
  return { limits, fiveHourUnread: reading != null && !limits.some((l) => l.rateLimitType === 'five_hour') }
}

/** "Claude · apelido" (ou e-mail, ou "Conta N"). */
export function accountDisplayName(account: Pick<ClaudeAccountView, 'label' | 'email'>, index: number): string {
  return account.label || account.email || `Conta ${index + 1}`
}

/** "atualizado há 3 min" / "atualizado agora". */
export function updatedAgo(at: number, now = Date.now()): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'atualizado agora'
  if (mins < 60) return `atualizado há ${mins} min`
  const hours = Math.floor(mins / 60)
  return hours < 48 ? `atualizado há ${hours} h` : `atualizado há ${Math.floor(hours / 24)} d`
}
