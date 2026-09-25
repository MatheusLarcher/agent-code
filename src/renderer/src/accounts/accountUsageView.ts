import type { RateLimitStatus } from '@shared/ipc'
import type { AccountUsageReading, ClaudeAccountView } from '@shared/claudeAccounts'

/** Janelas que o painel sabe rotular, na ordem das pílulas. */
const KNOWN: Array<RateLimitStatus['rateLimitType']> = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

/**
 * Leitura de uma conta → as mesmas pílulas do painel de sempre (utilização em
 * fração 0–1, `resetsAt` em ms). Janela já zerada (`resetsAt` passado) aparece
 * como 0%, igual à regra de troca.
 */
export function readingToLimits(reading: AccountUsageReading | null, now = Date.now()): RateLimitStatus[] {
  if (!reading) return []
  const out: RateLimitStatus[] = []
  for (const type of KNOWN) {
    const window = reading.windows[type]
    if (!window || (window.utilization == null && window.resetsAt == null)) continue
    const expired = window.resetsAt != null && window.resetsAt <= now
    const pct = expired ? 0 : (window.utilization ?? 0)
    out.push({
      rateLimitType: type,
      status: pct >= 100 ? 'rejected' : pct >= 80 ? 'allowed_warning' : 'allowed',
      utilization: pct / 100,
      ...(window.resetsAt != null && !expired ? { resetsAt: window.resetsAt } : {}),
      updatedAt: reading.at
    })
  }
  return out
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
