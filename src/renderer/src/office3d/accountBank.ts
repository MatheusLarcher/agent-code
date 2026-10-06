/**
 * As contas Claude no escritório — PURO (sem three, sem relógio próprio). A
 * energia do prédio é a janela de 5 h de UMA conta, a "em destaque" (a que
 * está sendo gasta); as outras contas conectadas ficam no banco de baterias
 * (a doca da pílula do HUD e do quadro de energia da parede).
 *
 *   featuredAccount(feed)   → id da conta em destaque; null sem conta conectada
 *     1. só contam as conectadas;
 *     2. a que mais tem conversas ocupadas (busyIds) num modelo Claude (fora
 *        GPT/Ollama; sem claudeAccountId = 'default'); no empate, a de leitura
 *        mais recente;
 *     3. ninguém trabalhando: a da conversa aberta (activeId), se for Claude;
 *     4. senão, a 1ª conectada na ordem do usuário.
 *   accountBank(feed, now)  → as conectadas na ordem do usuário, com a % que
 *     resta da janela de 5 h, o nível, o reset, os 7 dias usados, quantos
 *     agentes trabalham nela e a hora da leitura.
 *   accountLimits(account, now) → as janelas da leitura no formato usageLimits.
 */
import type { RateLimitStatus } from '@shared/ipc'
import { isOllamaModel, isOpenAIModel } from '@shared/ipc'
import type { ClaudeAccountView } from '@shared/claudeAccounts'
import { accountDisplayName, readingToLimits } from '../accounts/accountUsageView'
import type { OfficeFeed } from '../office/adapter/feed'
import { plainLevel, type PowerLevel } from './power'

/** O que a escolha da conta precisa do feed (todos opcionais: feeds antigos e testes). */
export type AccountFeed = Partial<Pick<OfficeFeed, 'claudeAccounts' | 'conversations' | 'busyIds' | 'activeId'>>

/** Uma conta no banco de baterias. */
export interface BankAccount {
  id: string
  /** Nome curto (apelido, e-mail ou "Conta N"). */
  name: string
  email: string | null
  /** % que resta da janela de 5 h (0..100); null sem leitura. */
  pct: number | null
  /** Nível pela carga (sem histerese); null sem leitura. */
  level: PowerLevel | null
  /** Epoch ms do reset da janela de 5 h; null sem horário (ou janela ainda sem uso). */
  resetsAt: number | null
  /** % usado da janela de 7 dias; null sem ela. */
  weekUsed: number | null
  /** Conversas ocupadas (agentes trabalhando) nesta conta. */
  busy: number
  /** Epoch ms da leitura; null sem leitura. */
  at: number | null
}

const DEFAULT_ID = 'default'

/** As contas conectadas, na ordem do usuário. */
export function connectedAccounts(feed: AccountFeed | null | undefined): ClaudeAccountView[] {
  return (feed?.claudeAccounts ?? []).filter((a) => a.status === 'connected')
}

/** A conta Claude de uma conversa (sem conta gravada = a padrão); null em GPT/Ollama. */
function accountOf(c: { model?: string; claudeAccountId?: string }): string | null {
  if (isOpenAIModel(c.model) || isOllamaModel(c.model)) return null
  return c.claudeAccountId ?? DEFAULT_ID
}

/** Quantas conversas ocupadas (num modelo Claude) cada conta tem. */
export function busyByAccount(feed: AccountFeed | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  const busy = feed?.busyIds
  if (!busy || busy.size === 0) return out
  for (const c of feed?.conversations ?? []) {
    if (!busy.has(c.id)) continue
    const id = accountOf(c)
    if (id !== null) out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** A conta em destaque (ver o topo); null sem conta conectada. */
export function featuredAccount(feed: AccountFeed | null | undefined): string | null {
  const list = connectedAccounts(feed)
  if (list.length === 0) return null
  const busy = busyByAccount(feed)
  let best: ClaudeAccountView | null = null
  for (const a of list) {
    const n = busy.get(a.id) ?? 0
    if (n === 0) continue
    const bn = best ? (busy.get(best.id) ?? 0) : 0
    if (!best || n > bn || (n === bn && (a.usage?.at ?? 0) > (best.usage?.at ?? 0))) best = a
  }
  if (best) return best.id
  const open = feed?.activeId ? feed.conversations?.find((c) => c.id === feed.activeId) : undefined
  const mine = open ? accountOf(open) : null
  if (mine !== null && list.some((a) => a.id === mine)) return mine
  return list[0].id
}

/** As janelas da última leitura da conta, no formato de usageLimits (janela vencida = 0% usado). */
export function accountLimits(account: Pick<ClaudeAccountView, 'usage'>, now: number): Record<string, RateLimitStatus> {
  const out: Record<string, RateLimitStatus> = {}
  for (const l of readingToLimits(account.usage, now)) out[l.rateLimitType] = l
  return out
}

/** O banco: as conectadas na ordem do usuário, cada uma com a leitura dela. */
export function accountBank(feed: AccountFeed | null | undefined, now: number): BankAccount[] {
  const busy = busyByAccount(feed)
  return connectedAccounts(feed).map((a, i): BankAccount => {
    const limits = accountLimits(a, now)
    const five = limits.five_hour
    const week = limits.seven_day
    const rejected = five?.status === 'rejected'
    const pct = five ? (rejected ? 0 : Math.round((1 - Math.min(1, Math.max(0, five.utilization ?? 0))) * 100)) : a.usage ? 100 : null
    return {
      id: a.id,
      name: accountDisplayName(a, i),
      email: a.email,
      pct,
      level: pct === null ? null : plainLevel(pct, rejected),
      resetsAt: five?.resetsAt ?? null,
      weekUsed: week ? Math.round((week.utilization ?? 0) * 100) : null,
      busy: busy.get(a.id) ?? 0,
      at: a.usage?.at ?? null
    }
  })
}

/** A assinatura do banco (o que a pílula e o quadro mostram): muda só quando muda algo visível. */
export function bankSig(bank: readonly BankAccount[]): string {
  return bank.map((b) => `${b.id}:${b.name}:${b.pct}:${b.level}:${b.resetsAt}:${b.weekUsed}:${b.busy}:${b.at}`).join('|')
}
