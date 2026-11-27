/**
 * Elemento da página marcado pelo "Selecionar" do navegador, como anexo INLINE do
 * campo de mensagem — o mesmo mecanismo da imagem e do trecho citado: um TOKEN no
 * valor da caixa, um <img> atômico no campo e, no envio, "[elemento N]" no ponto
 * dele. Os detalhes (seletor, texto, html) vão ao agente no fim da mensagem.
 */
import type { PickedElement } from '@shared/ipc'
import { newAttId, type InlineAtt } from '../../inlineMedia/inlineAttachments'
import { elementName } from './elementName'

export type ElementAtt = Extract<InlineAtt, { kind: 'element' }>

/** Marca do elemento N no texto (e no anexo do campo). */
export const elementRef = (n: number): string => `[elemento ${n}]`

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/** Rótulo curto e legível: "botão “Comprar”", "título “Layout”", "forma do slide". */
export function elementLabel(el: PickedElement, max = 30): string {
  return elementName({ tag: el.tagName, id: el.id, classes: el.classes, text: el.text }, max)
}

/**
 * Chip do elemento N como SVG (vira o src do <img>, como o chip de arquivo): a
 * bolinha com o número — a mesma marca da página — e o nome legível. Mesmo
 * visual da etiqueta na bolha enviada (ElementRefText).
 */
export function elementChipSvg(n: number, el: PickedElement): string {
  const label = elementLabel(el)
  const w = 2 + 16 + 6 + Math.ceil(label.length * 6.05) + 9
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="19" rx="9.5" fill="#d97757" fill-opacity="0.16" stroke="#d97757" stroke-opacity="0.45"/>` +
    `<circle cx="10" cy="10" r="8" fill="#d97757"/>` +
    `<text x="10" y="13.5" text-anchor="middle" font-family="'Segoe UI', system-ui, sans-serif" font-size="10" font-weight="700" fill="#fff">${n}</text>` +
    `<text x="24" y="14" font-family="'Segoe UI', system-ui, sans-serif" font-size="12" fill="#f1e9e4">${xml(label)}</text>` +
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
  return `${BLOCK_HEAD}${refs}`
}

const BLOCK_HEAD = '--- Selected page elements ---\n'
/** Cabeçalho de cada elemento no bloco: "[elemento N] tag#id · aba: X" seguido da linha do seletor. */
const ENTRY = /(?:^|\n\n)\[elemento (\d+)\] ([^\n]*?) · aba: ([^\n]*)\nselector: /g

/** O que a bolha mostra de um elemento enviado (lido de volta do bloco de `formatElements`). */
export interface BubbleElement {
  n: number
  tag: string
  id: string
  classes: string
  /** Aba de onde veio ("Preview", "web - Google"...). */
  tab: string
  selector: string
  text: string
  html: string
}

/** As classes da tag de abertura do html (o bloco não leva `classes` à parte). */
function classesOf(html: string): string {
  const open = /^<[^>]*>?/.exec(html)?.[0] ?? ''
  const m = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(open)
  return (m?.[1] ?? m?.[2] ?? '').replace(/\s+/g, ' ').trim()
}

/** Lê os elementos do bloco "--- Selected page elements ---" no fim do texto enviado. */
export function parseElementsBlock(full: string): BubbleElement[] {
  const at = full.lastIndexOf(BLOCK_HEAD)
  if (at < 0) return []
  const body = full.slice(at + BLOCK_HEAD.length)
  const heads = [...body.matchAll(ENTRY)]
  return heads.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? body.length) : body.length
    const rest = body.slice(start, end)
    const t = rest.indexOf('\ntext: ')
    const afterText = t < 0 ? '' : rest.slice(t + '\ntext: '.length)
    const h = afterText.indexOf('\nhtml: ')
    const html = h < 0 ? '' : afterText.slice(h + '\nhtml: '.length).trim()
    const hash = m[2].indexOf('#')
    return {
      n: Number(m[1]),
      tag: (hash < 0 ? m[2] : m[2].slice(0, hash)).trim(),
      id: hash < 0 ? '' : m[2].slice(hash + 1).trim(),
      classes: classesOf(html),
      tab: m[3].trim(),
      selector: (t < 0 ? rest : rest.slice(0, t)).trim(),
      text: (h < 0 ? afterText : afterText.slice(0, h)).trim(),
      html
    }
  })
}

/** Os elementos para a bolha do usuário (`{}` quando o envio não tem nenhum). */
export function bubbleElements(full: string): { elements?: BubbleElement[] } {
  const elements = parseElementsBlock(full)
  return elements.length ? { elements } : {}
}
