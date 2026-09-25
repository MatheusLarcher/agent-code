import type { AccountUsageResult } from '../../shared/claudeAccounts'
import type { AccountCandidate } from './selection'
import type { AccountSwitchDeps } from './switchDeps'
import { decideExhaustedSwitch, decideTurnEndSwitch } from './switchPolicy'
import { ACCOUNT_SWITCH_THRESHOLD, accountConsumption } from './usageMath'

export interface SessionSwitchInput {
  /** Contas na ordem do usuário, com status e a última leitura guardada. */
  candidates(): Promise<AccountCandidate[]>
  /** Consulta de consumo (cache de 60 s; `force` ignora o cache). Nunca lança:
   *  falha devolve a última leitura com `fresh: false`. */
  readUsage(ids: readonly string[], force: boolean): Promise<AccountUsageResult[]>
  multiple(): boolean
  autoEnabled(): boolean
  label(id: string): string
  changed(id: string): void
  acquire?(): Promise<void>
}

function withReadings(list: AccountCandidate[], results: readonly AccountUsageResult[]): AccountCandidate[] {
  const byId = new Map(results.map((result) => [result.accountId, result.reading]))
  return list.map((account) => (byId.has(account.id) ? { ...account, usage: byId.get(account.id) ?? null } : account))
}

/**
 * As dependências de troca de conta de UMA conversa, sobre o registro real.
 * Sempre consulta as outras contas de verdade antes de trocar (a última
 * leitura de uma conta parada pode estar velha, e a consulta é grátis). Se a
 * consulta falha, vale a última leitura + `resets_at`; conta sem leitura
 * conta como "com folga"; login expirado nunca é candidata.
 */
export function createSessionSwitchDeps(input: SessionSwitchInput): AccountSwitchDeps {
  return {
    multiple: () => input.multiple(),
    autoEnabled: () => input.autoEnabled(),
    label: (id) => input.label(id),
    changed: (id) => input.changed(id),
    ...(input.acquire ? { acquire: () => input.acquire!() } : {}),

    async turnEndTarget(current, model) {
      // A leitura da conta atual: a que chegou no turno (a sessão grava cada
      // rate-limit) ou uma consulta nova, se já passou de 60 s.
      const [own] = await input.readUsage([current], false)
      if (accountConsumption(own?.reading ?? null, model) < ACCOUNT_SWITCH_THRESHOLD) return null
      const list = await input.candidates()
      const others = list.filter((account) => account.id !== current && account.status === 'connected')
      if (!others.length) return null
      const fresh = await input.readUsage(others.map((account) => account.id), true)
      const merged = withReadings(list, fresh)
      const currentCandidate: AccountCandidate = {
        ...(merged.find((account) => account.id === current) ?? { id: current, status: 'connected', usage: null }),
        usage: own?.reading ?? null
      }
      return decideTurnEndSwitch({ current: currentCandidate, others: merged, model })
    },

    async exhaustedTarget(current, model, tried) {
      const list = await input.candidates()
      const others = list.filter((account) => account.id !== current && !tried.has(account.id) && account.status === 'connected')
      if (!others.length) return null
      const fresh = await input.readUsage(others.map((account) => account.id), true)
      const merged = withReadings(list, fresh)
      return decideExhaustedSwitch({ current: merged.find((account) => account.id === current), others: merged, model, tried })
    }
  }
}
