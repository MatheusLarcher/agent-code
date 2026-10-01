/**
 * Elemento da página marcado pelo "Selecionar" do navegador, como anexo INLINE do
 * campo de mensagem — o mesmo mecanismo da imagem e do trecho citado: um TOKEN no
 * valor da caixa, um <img> atômico no campo e, no envio, "[elemento N]" no ponto
 * dele. Os detalhes (seletor, texto, html) vão ao agente no fim da mensagem.
 */
import type { PickedElement } from '@shared/ipc'
import { newAttId, type InlineAtt } from '../../inlineMedia/inlineAttachments'

export type ElementAtt = Extract<InlineAtt, { kind: 'element' }>

/** Marca do elemento N no texto (e no anexo do campo). */
export const elementRef = (n: number): string => `[elemento ${n}]`

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/** Rótulo curto: a tag e o id, ou o começo do texto/seletor. */
export function elementLabel(el: PickedElement, max = 24): string {
  const hint = el.id ? `#${el.id}` : (el.text.replace(/\s+/g, ' ').trim() || el.selector)
  const s = `${el.tagName} ${hint}`.trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Chip "[elemento N] tag #id" como SVG (vira o src do <img>, como o chip de arquivo). */
export function elementChipSvg(n: number, el: PickedElement): string {
  const ref = elementRef(n)
  const label = elementLabel(el)
  const refW = Math.ceil(ref.length * 6.6)
  const w = 8 + refW + 6 + Math.ceil(label.length * 6.6) + 8
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="19" rx="6" fill="#2b2f36" stroke="#3aa162"/>` +
    `<text x="8" y="14" font-family="'Segoe UI', system-ui, sans-serif" font-size="12" fill="#7fd6a0">${xml(ref)}</text>` +
    `<text x="${8 + refW + 6}" y="14" font-family="ui-monospace, monospace" font-size="11" fill="#e8eaed">${xml(label)}</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** O item do elemento `n` (a ordem no texto; renumerado quando muda). */
export function makeElementAtt(el: PickedElement, n: number, id: string = newAttId()): ElementAtt {
  return { id, kind: 'element', name: `elemento ${n}`, el, src: elementChipSvg(n, el) }
}

/** Os elementos no campo, na ordem do texto. */
export function elementsInOrder(order: readonly string[], atts: ReadonlyMap<string, InlineAtt>): ElementAtt[] {
  const out: ElementAtt[] = []
  for (const id of order) {
    const a = atts.get(id)
    if (a?.kind === 'element') out.push(a)
  }
  return out
}

/** Os detalhes que o agente lê, no fim da mensagem (N casa com "[elemento N]" do texto). */
export function formatElements(elements: readonly PickedElement[]): string {
  if (elements.length === 0) return ''
  const refs = elements
    .map(
      (c, i) =>
        `${elementRef(i + 1)} ${c.tagName}${c.id ? '#' + c.id : ''} · aba: ${c.tabName || 'web'}\n` +
        `selector: ${c.selector}\ntext: ${c.text.slice(0, 400)}\nhtml: ${c.html.slice(0, 600)}`
    )
    .join('\n\n')
  return `--- Selected page elements ---\n${refs}`
}
