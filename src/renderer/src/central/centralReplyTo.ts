/**
 * Responder uma mensagem da Central (estilo WhatsApp): a resposta vai DIRETO à
 * conversa da mensagem citada, sem o decisor (`centralRoute`). Só se responde o
 * que já tem destino e é deste PC: pedido entregue ou bloco de resposta do
 * agente. Destino sumido cai no fluxo normal de destino ausente (deliverEntry).
 */
import {
  CENTRAL_REPLY_QUOTE_MAX,
  CENTRAL_REPLY_WHY,
  type CentralEntry,
  type CentralReplyQuote,
  type CentralTarget
} from '@shared/central'
import { readableMediaText } from '@shared/inlineMedia'
import { clip, isOwnEntry } from './centralEntries'
import { conversationTarget } from './centralRecents'
import { deliverEntry, type CentralFlowDeps } from './centralDelivery'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A citação de uma entrada, ou null quando ela não pode ser respondida. */
export function replyQuoteOf(entry: CentralEntry | undefined, self: string | undefined): CentralReplyQuote | null {
  if (!entry || !isOwnEntry(entry, self)) return null
  if (entry.kind === 'request') {
    if (entry.state !== 'delivered' || !entry.anchor?.convId) return null
    return { id: entry.id, convId: entry.anchor.convId, text: clip(oneLine(readableMediaText(entry.text)), CENTRAL_REPLY_QUOTE_MAX) }
  }
  if (entry.kind === 'reply') {
    if (!entry.anchor?.convId) return null
    const notes = Array.isArray(entry.notes) ? entry.notes : []
    const body = entry.answer || notes[notes.length - 1] || entry.activity?.text || ''
    return { id: entry.id, convId: entry.anchor.convId, text: clip(oneLine(body), CENTRAL_REPLY_QUOTE_MAX) }
  }
  return null
}

/** A citação pelo id da entrada (o celular manda só o id). */
export function findReplyQuote(entries: readonly CentralEntry[], id: string | undefined, self: string | undefined): CentralReplyQuote | null {
  if (!id) return null
  return replyQuoteOf(entries.find((e) => e.id === id), self)
}

/** O destino da conversa citada (fora da tela: só o id — a entrega a lê do banco). */
function quotedTarget(d: CentralFlowDeps, convId: string): CentralTarget {
  const conv = d.convsRef.current.find((c) => c.id === convId)
  if (conv) return conversationTarget(conv, d.sandboxRoot)
  return { kind: 'conversation', convId, cwd: '', project: '', title: '', sandbox: false }
}

/** Entrega a resposta na conversa citada, sem passar pelo decisor. */
export function deliverReply(d: CentralFlowDeps, entryId: string, quote: CentralReplyQuote): Promise<boolean> {
  const target = quotedTarget(d, quote.convId)
  return deliverEntry(d, entryId, target, { target, why: CENTRAL_REPLY_WHY, byUser: true })
}
