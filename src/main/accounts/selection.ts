import type { AccountUsageReading, ClaudeAccountStatus } from '../../shared/claudeAccounts'
import { accountConsumption } from './usageMath'

export interface AccountCandidate {
  id: string
  status: ClaudeAccountStatus
  usage: AccountUsageReading | null
}

/**
 * Conta de uma conversa nova, pela última leitura guardada (sem consultar: não
 * pode atrasar o primeiro envio).
 *
 * 1. A primeira da ORDEM do usuário que não está esgotada (< 100%). O limiar
 *    de troca (95%) é só da troca automática de fim de turno (switchPolicy.ts):
 *    não pula a 1ª conta numa conversa nova.
 * 2. Todas esgotadas: a primeira da ordem (a troca para o GPT é do handoff 2).
 *
 * Só conta conectada é candidata. Nenhuma conectada → `undefined` (a sessão
 * segue com o login padrão da máquina, como sempre foi).
 */
export function chooseAccountForNewConversation(
  accounts: readonly AccountCandidate[],
  model: string | undefined | null,
  now = Date.now()
): string | undefined {
  const connected = accounts.filter((account) => account.status === 'connected')
  if (!connected.length) return undefined
  const available = connected.find((account) => accountConsumption(account.usage, model, now) < 100)
  return (available ?? connected[0]).id
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
