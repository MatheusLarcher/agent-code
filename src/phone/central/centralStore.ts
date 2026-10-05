/**
 * O estado de tela da Central no celular (não vem do PC): bolhas "enviando…",
 * escolhas/respostas em andamento, marcações de pergunta, porquês abertos, ações
 * de turno carregadas e o modo resposta (citação acima do campo).
 */
import { createStore } from '../core/store'
import type { ChatMsg } from '../core/types'

/** A bolha "enviando…" some se o retrato do PC não trouxer o pedido neste tempo. */
export const CENTRAL_SENT_TTL_MS = 20000
/** Escolha/resposta enviada: os botões ficam travados até o retrato mudar (ou este tempo). */
export const CENTRAL_BUSY_TTL_MS = 10000

export interface CentralQuote {
  id: string
  who: string
  color?: string
  text: string
}

export interface SentBubble {
  text: string
  files: number
  at: number
  /** Ids de entradas que já existiam quando enviamos (não contam como "chegou"). */
  known: Record<string, true>
}

export interface TurnTools {
  loading: boolean
  count: number
  found?: boolean
  list?: ChatMsg[]
  closed?: boolean
  partial?: boolean
  error?: string
}

export interface CentralUi {
  sent: SentBubble[]
  /** id do pedido / 'q:' + id da pergunta → quando a escolha/resposta saiu. */
  busy: Record<string, number>
  /** convId:id da pergunta → escolhas por pergunta. */
  picks: Record<string, string[][]>
  why: Record<string, boolean>
  open: Record<string, boolean>
  tools: Record<string, TurnTools>
  replyTo: CentralQuote | null
}

export const centralUi = createStore<CentralUi>({ sent: [], busy: {}, picks: {}, why: {}, open: {}, tools: {}, replyTo: null })

export function setCentralReply(q: CentralQuote | null): void {
  centralUi.set({ replyTo: q })
}

/** O `replyTo` do próximo envio (e sai do modo resposta). */
export function takeCentralReply(): string | null {
  const q = centralUi.get().replyTo
  if (q) setCentralReply(null)
  return q ? q.id : null
}
