/**
 * O trecho comentado como anexo INLINE do campo de mensagem — o mesmo mecanismo
 * da imagem (inlineMedia/): um TOKEN no valor da caixa, um <img> atômico no
 * campo (Backspace/Delete apagam inteiro) e, no envio, "[trecho N]" no ponto
 * dele (ver serializeInline). Aqui só a criação do item e a imagem dele.
 */
import { newAttId, type InlineAtt } from '../../inlineMedia/inlineAttachments'
import { quoteRef, type Quote } from './quoteFormat'
import './quoteComment.css'

export type QuoteAtt = Extract<InlineAtt, { kind: 'quote' }>

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/** Chip "↳ [trecho N]" como SVG (vira o src do <img>, como o chip de arquivo). */
export function quoteChipSvg(n: number): string {
  const label = quoteRef(n)
  // Largura estimada (sem canvas): a fonte é pequena e o rótulo, curto.
  const w = 26 + Math.ceil(label.length * 6.6)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="19" rx="6" fill="#2b2f36" stroke="#6b8afd"/>` +
    `<text x="8" y="14" font-family="'Segoe UI', system-ui, sans-serif" font-size="12" fill="#9fb3ff">↳</text>` +
    `<text x="20" y="14" font-family="'Segoe UI', system-ui, sans-serif" font-size="12" fill="#e8eaed">${xml(label)}</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** O item do trecho `n` (a ordem no texto; renumerado quando muda — ver useComposerQuotes). */
export function makeQuoteAtt(quote: Quote, n: number, id: string = newAttId()): QuoteAtt {
  return { id, kind: 'quote', name: `trecho ${n}`, quote: { messageId: quote.messageId, text: quote.text }, src: quoteChipSvg(n) }
}

/** Os trechos no campo, na ordem do texto. */
export function quotesInOrder(order: readonly string[], atts: ReadonlyMap<string, InlineAtt>): QuoteAtt[] {
  const out: QuoteAtt[] = []
  for (const id of order) {
    const a = atts.get(id)
    if (a?.kind === 'quote') out.push(a)
  }
  return out
}
