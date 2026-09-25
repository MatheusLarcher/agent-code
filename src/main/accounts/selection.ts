import type { AccountUsageReading, ClaudeAccountStatus } from '../../shared/claudeAccounts'
import { ACCOUNT_SWITCH_THRESHOLD, accountConsumption } from './usageMath'

export interface AccountCandidate {
  id: string
  status: ClaudeAccountStatus
  usage: AccountUsageReading | null
}

/**
 * Conta de uma conversa nova, pela última leitura guardada (sem consultar: não
 * pode atrasar o primeiro envio).
 *
 * 1. A primeira da ORDEM do usuário que está abaixo de 95%.
 * 2. Todas em 95% ou mais: a de menor consumo que ainda não estourou.
 * 3. Todas estouradas: a de menor consumo (a troca para o GPT é do handoff 2).
 *
 * Só conta conectada é candidata. Nenhuma conectada → `undefined` (a sessão
 * segue com o login padrão da máquina, como sempre foi).
 */
export function chooseAccountForNewConversation(
  accounts: readonly AccountCandidate[],
  model: string | undefined | null,
  now = Date.now()
): string | undefined {
  const scored = accounts
    .filter((account) => account.status === 'connected')
    .map((account) => ({ id: account.id, consumption: accountConsumption(account.usage, model, now) }))
  if (!scored.length) return undefined

  const underThreshold = scored.find((account) => account.consumption < ACCOUNT_SWITCH_THRESHOLD)
  if (underThreshold) return underThreshold.id

  // `sort` é estável: empate fica com a que vem antes na ordem do usuário.
  const byConsumption = [...scored].sort((a, b) => a.consumption - b.consumption)
  return (byConsumption.find((account) => account.consumption < 100) ?? byConsumption[0]).id
}

/**
 * Conta de uma conversa que está sendo retomada: a gravada, se ainda existe e
 * está conectada; senão, a regra de conversa nova.
 */
export function accountForConversation(
  stored: string | undefined | null,
  accounts: readonly AccountCandidate[],
  model: string | undefined | null,
  now = Date.now()
): string | undefined {
  if (stored && accounts.some((account) => account.id === stored && account.status === 'connected')) return stored
  return chooseAccountForNewConversation(accounts, model, now)
}
