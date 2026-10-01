/**
 * Gatilhos das animações 6 a 10 (card dec-todas-animacoes). Pura: o feed e o
 * relógio vêm de fora.
 *
 *   6 café       — 'error' novo com usageExhausted na conversa, ou janela
 *                  Claude que passou a 'rejected' em usageLimits → 'cafe'.
 *                  Com conta conhecida (claudeAccountId), vão todas as
 *                  conversas daquela conta; volta no próximo turno ('cafe-fim')
 *                  ou no resetsAt (prazo da animação).
 *   8 crachá     — UIMessage 'account-switch' nova (só troca efetiva: não
 *                  'suggest' nem 'scheduled') → 'cracha' com o nome da conta.
 *   7, 9, 10     — são ESTADO, não evento: deriveOverlayState (impressora por
 *                  sala, pilha de papéis por conversa, quem está falando).
 *
 * Primeiro feed (prev null) é o ponto de partida: o histórico não dispara.
 */
import { contextLimitFor, usageProviderOf, type RateLimitStatus } from '@shared/ipc'
import type { Conversation, UIMessage } from '../../types'
import type { OfficeFeed } from './feed'
import { roomIdFor } from './model'

export type ExtraTrigger =
  | { type: 'cafe'; convIds: string[]; resetsAt: number | null }
  | { type: 'cafe-fim'; convId: string }
  | { type: 'cracha'; convId: string; name: string }

/** Degraus da pilha: 0 = sem pilha; 1, 2, 3 = 80, 90 e 95% do contexto. */
export type PileLevel = 0 | 1 | 2 | 3
export const PILE_STEPS: readonly number[] = [0.8, 0.9, 0.95]

export interface OverlayState {
  /** Tarefas em segundo plano por sala (soma das conversas dela). */
  printers: Map<string, number>
  /** Pilha de papéis por conversa (só as com degrau > 0). */
  piles: Map<string, PileLevel>
  /** Conversa da mensagem lida em voz agora (null = silêncio). */
  speakingConvId: string | null
}

export function pileLevel(tokens: number, model: string | undefined): PileLevel {
  const ratio = tokens / contextLimitFor(model)
  let n = 0
  for (const s of PILE_STEPS) if (ratio >= s) n++
  return n as PileLevel
}

const idOf = (m: UIMessage): string | null => ('id' in m && typeof m.id === 'string' ? m.id : null)

/** Mensagens que não estavam no feed anterior (pela identidade do array, depois pelo id). */
function newMessages(prev: Conversation | undefined, next: Conversation): UIMessage[] {
  if (!prev || prev.messages === next.messages) return []
  const seen = new Set<string>()
  for (const m of prev.messages) {
    const id = idOf(m)
    if (id) seen.add(id)
  }
  return next.messages.filter((m) => {
    const id = idOf(m)
    return id !== null && !seen.has(id)
  })
}

/** "…atingiu o limite|1999999999" (segundos) → epoch ms. */
function resetFromText(text: string): number | null {
  const m = /\|(\d{9,})\s*$/.exec(text)
  return m ? Number(m[1]) * 1000 : null
}

/**
 * Nome da conta NOVA no texto do aviso (providerFailover): "…na conta X.",
 * "…para a conta X (40% usado)…", "…passou a usar a conta X.". Sem achar, o id.
 */
export function accountName(text: string, fallback: string): string {
  const m = /(?:na|para a|usar a) conta (.+?)(?=\s*\(|\.(?:\s|$)|\s—|$)/.exec(text)
  const name = m?.[1]?.trim()
  return name && name.length <= 32 ? name : fallback
}

/** Conversas da mesma conta (sem conta: a própria conversa só). */
function sameAccount(convs: readonly Conversation[], c: Conversation): string[] {
  if (!c.claudeAccountId) return [c.id]
  return convs.filter((o) => o.claudeAccountId === c.claudeAccountId).map((o) => o.id)
}

const isClaude = (l: RateLimitStatus): boolean => usageProviderOf(l.rateLimitType) === 'claude'

export function detectExtraTriggers(prev: OfficeFeed | null, next: OfficeFeed): ExtraTrigger[] {
  if (!prev) return []
  const out: ExtraTrigger[] = []
  const before = new Map(prev.conversations.map((c) => [c.id, c]))
  const rejected = Object.values(next.usageLimits ?? {}).find((l) => isClaude(l) && l.status === 'rejected')
  for (const c of next.conversations) {
    for (const m of newMessages(before.get(c.id), c)) {
      if (m.kind === 'error' && m.usageExhausted) {
        out.push({ type: 'cafe', convIds: sameAccount(next.conversations, c), resetsAt: resetFromText(m.text) ?? rejected?.resetsAt ?? null })
      } else if (m.kind === 'account-switch' && m.reason !== 'suggest' && m.reason !== 'scheduled') {
        out.push({ type: 'cracha', convId: c.id, name: accountName(m.text, m.toAccountId) })
      }
    }
    if (next.busyIds.has(c.id) && !prev.busyIds.has(c.id)) out.push({ type: 'cafe-fim', convId: c.id })
  }
  // Janela da conta que estourou agora: vão todos da conta da conversa aberta.
  for (const [type, l] of Object.entries(next.usageLimits ?? {})) {
    if (!isClaude(l) || l.status !== 'rejected' || prev.usageLimits?.[type]?.status === 'rejected') continue
    const active = next.conversations.find((c) => c.id === next.activeId)
    if (active) out.push({ type: 'cafe', convIds: sameAccount(next.conversations, active), resetsAt: l.resetsAt ?? null })
  }
  return out
}

/** Estado contínuo das animações 7, 9 e 10. */
export function deriveOverlayState(feed: OfficeFeed): OverlayState {
  const printers = new Map<string, number>()
  const piles = new Map<string, PileLevel>()
  let speakingConvId: string | null = null
  const speaking = feed.speakingId ?? null
  for (const c of feed.conversations) {
    const n = c.backgroundTasks?.length ?? 0
    if (n > 0) {
      const room = roomIdFor(c.cwd)
      printers.set(room, (printers.get(room) ?? 0) + n)
    }
    const level = pileLevel(c.tokens.context, c.autoModel ?? c.model)
    if (level > 0) piles.set(c.id, level)
    if (speaking && speakingConvId === null && c.messages.some((m) => idOf(m) === speaking)) speakingConvId = c.id
  }
  return { printers, piles, speakingConvId }
}
