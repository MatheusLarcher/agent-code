import type { AccountCandidate } from './selection'
import { ACCOUNT_SWITCH_THRESHOLD, accountConsumption } from './usageMath'

/**
 * A regra da troca automática de conta (decisão do usuário, 24/09). Pura: quem
 * chama já consultou o consumo das contas; aqui só se decide.
 *
 * - Fim de turno: a conta da conversa em 95%+ → vai para a de MENOR consumo,
 *   desde que ela esteja abaixo de 95%. Todas as outras em 95%+ → fica onde
 *   está até estourar (é o que impede a conversa de ir e voltar).
 * - Estouro: vai para a de menor consumo que ainda NÃO estourou, mesmo acima de
 *   95%; cada conta entra uma vez por turno.
 * - Empate: a primeira na ordem do usuário. Login expirado nunca é destino.
 */

export interface SwitchTarget {
  to: string
  /** Consumo (0–100) da conta de onde se sai e da de destino. */
  fromPct: number
  toPct: number
}

function scoreCandidates(
  others: readonly AccountCandidate[],
  model: string | undefined,
  now: number
): Array<{ id: string; pct: number }> {
  return others
    .filter((account) => account.status === 'connected')
    .map((account) => ({ id: account.id, pct: accountConsumption(account.usage, model, now) }))
    // `sort` é estável: empate fica com quem vem antes na ordem do usuário.
    .sort((a, b) => a.pct - b.pct)
}

/** Troca silenciosa de fim de turno, ou `null` para ficar. */
export function decideTurnEndSwitch(input: {
  current: AccountCandidate
  others: readonly AccountCandidate[]
  model: string | undefined
  now?: number
}): SwitchTarget | null {
  const now = input.now ?? Date.now()
  const fromPct = accountConsumption(input.current.usage, input.model, now)
  if (fromPct < ACCOUNT_SWITCH_THRESHOLD) return null
  const best = scoreCandidates(input.others.filter((a) => a.id !== input.current.id), input.model, now)[0]
  if (!best || best.pct >= ACCOUNT_SWITCH_THRESHOLD) return null
  return { to: best.id, fromPct, toPct: best.pct }
}

/** Destino no estouro, ou `null` quando todas as contas já estouraram/foram tentadas. */
export function decideExhaustedSwitch(input: {
  current: AccountCandidate | undefined
  others: readonly AccountCandidate[]
  model: string | undefined
  /** Contas que já entraram neste turno (inclui a que acabou de estourar). */
  tried: ReadonlySet<string>
  now?: number
}): SwitchTarget | null {
  const now = input.now ?? Date.now()
  const best = scoreCandidates(
    input.others.filter((a) => !input.tried.has(a.id) && a.id !== input.current?.id),
    input.model,
    now
  ).find((account) => account.pct < 100)
  if (!best) return null
  return { to: best.id, fromPct: 100, toPct: best.pct }
}
