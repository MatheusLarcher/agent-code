/**
 * Modelo do campo inline (contenteditable) <-> texto serializado.
 *
 * No DOM, cada anexo é um `<img data-att-id>` (atômico no Chromium: Backspace,
 * Delete, setas e desfazer tratam como um caractere). Serializado, cada anexo
 * vira UM caractere `TOKEN` (U+FFFC) e `order` guarda os ids na ordem do texto.
 * Assim o resto do Composer (menções @, "[[", ditado) segue trabalhando com
 * string + posição de cursor, como no textarea.
 *
 * Regras de linha (o campo usa `white-space: pre-wrap`):
 * - "\n" em nó de texto é quebra; o Chromium deixa um "\n" extra no FIM para a
 *   última linha vazia aparecer — a serialização descarta esse último.
 * - `<br>` é quebra, menos o último filho do bloco (marcador de linha vazia).
 * - `<div>`/`<p>` (colagem de várias linhas) começa linha nova.
 */

export const TOKEN = '￼'
/** Só o TOKEN (que só vem de <img>) sai do texto; qualquer outro caractere do usuário (U+200B inclusive) fica. */
const STRIP_RE = /￼/
const BLOCKS = new Set(['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE'])

export function isTokenNode(n: Node | null | undefined): n is HTMLElement {
  return !!n && n.nodeType === 1 && (n as Element).nodeName === 'IMG' && (n as Element).hasAttribute('data-att-id')
}

type Item =
  | { kind: 'text'; node: Text; text: string; map: number[]; start: number }
  | { kind: 'token'; node: HTMLElement; id: string; start: number }
  /** Quebra de linha que fica logo ANTES de `node` (um <br> ou o início de um bloco). */
  | { kind: 'nl'; node: Node; start: number }

export interface Scan {
  items: Item[]
  /** Texto cru (com o "\n" final de placeholder, se houver). */
  raw: string
  value: string
  order: string[]
}

/** Quantas varreduras do DOM já rodaram (medição de desempenho nos testes). */
export const scanStats = { count: 0 }

export function scanEditor(root: HTMLElement): Scan {
  scanStats.count++
  const items: Item[] = []
  let raw = ''
  const order: string[] = []
  let breakPending = false
  const push = (item: Item, text: string): void => {
    items.push(item)
    raw += text
  }
  const lineBreakBefore = (node: Node): void => {
    if (breakPending && raw.length > 0 && !raw.endsWith('\n')) push({ kind: 'nl', node, start: raw.length }, '\n')
    breakPending = false
  }
  const visit = (parent: Node): void => {
    const kids = parent.childNodes
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (c.nodeType === 3) {
        const data = (c as Text).data
        let text = ''
        const map: number[] = []
        for (let k = 0; k < data.length; k++) {
          if (STRIP_RE.test(data[k])) continue
          text += data[k]
          map.push(k)
        }
        if (!text) continue
        lineBreakBefore(c)
        push({ kind: 'text', node: c as Text, text, map, start: raw.length }, text)
      } else if (isTokenNode(c)) {
        lineBreakBefore(c)
        const id = c.getAttribute('data-att-id') ?? ''
        order.push(id)
        push({ kind: 'token', node: c, id, start: raw.length }, TOKEN)
      } else if (c.nodeName === 'BR') {
        breakPending = false
        if (i < kids.length - 1) push({ kind: 'nl', node: c, start: raw.length }, '\n')
      } else if (c.nodeType === 1 && BLOCKS.has(c.nodeName)) {
        // Bloco depois de bloco é sempre linha nova (mesmo o anterior vazio: <div><br></div>).
        if (raw.length > 0 && (!raw.endsWith('\n') || breakPending)) push({ kind: 'nl', node: c, start: raw.length }, '\n')
        breakPending = false
        visit(c)
        breakPending = true
      } else if (c.nodeType === 1) {
        visit(c)
      }
    }
  }
  visit(root)
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  return { items, raw, value, order }
}

export function serializeEditor(root: HTMLElement): { value: string; order: string[] } {
  const { value, order } = scanEditor(root)
  return { value, order }
}

/** Posição de cursor no DOM -> índice no texto serializado. */
export function offsetFromPoint(root: HTMLElement, container: Node, offset: number, scan: Scan = scanEditor(root)): number {
  const { items, value } = scan
  const doc = root.ownerDocument
  const range = doc.createRange()
  try {
    range.setStart(container, offset)
  } catch {
    return value.length
  }
  let pos = 0
  for (const item of items) {
    if (item.kind === 'text' && item.node === container) {
      let n = 0
      while (n < item.map.length && item.map[n] < offset) n++
      return Math.min(item.start + n, value.length)
    }
    const cmp = range.comparePoint(item.node, 0)
    const before = cmp < 0 || (cmp === 0 && item.kind === 'nl')
    if (!before) break
    pos = item.start + (item.kind === 'text' ? item.text.length : 1)
  }
  return Math.min(pos, value.length)
}

function indexIn(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node) as number
}

/** Índice no texto serializado -> posição de cursor no DOM. */
export function pointFromOffset(root: HTMLElement, offset: number, scan: Scan = scanEditor(root)): { node: Node; offset: number } {
  const { items } = scan
  for (const item of items) {
    if (item.kind === 'text') {
      const end = item.start + item.text.length
      if (offset >= item.start && offset <= end) {
        const k = offset - item.start
        return { node: item.node, offset: k < item.map.length ? item.map[k] : item.map[item.map.length - 1] + 1 }
      }
    } else if (offset === item.start) {
      const parent = item.node.parentNode
      if (parent) return { node: parent, offset: indexIn(item.node) }
    }
  }
  return { node: root, offset: root.childNodes.length }
}

/**
 * Reconstrói o DOM a partir do texto serializado. Cada TOKEN consome o próximo
 * id de `order`; TOKEN sem id (ou sem anexo) some. `makeToken` cria o <img>.
 */
export function renderEditor(
  root: HTMLElement,
  value: string,
  order: readonly string[],
  makeToken: (id: string) => HTMLElement | null
): void {
  const doc = root.ownerDocument
  while (root.firstChild) root.removeChild(root.firstChild)
  let buf = ''
  let next = 0
  const flush = (): void => {
    if (buf) root.appendChild(doc.createTextNode(buf))
    buf = ''
  }
  for (const ch of value) {
    if (ch !== TOKEN) {
      buf += ch
      continue
    }
    const id = order[next++]
    const el = id ? makeToken(id) : null
    if (!el) continue
    flush()
    root.appendChild(el)
  }
  // Última linha vazia só aparece com um "\n" a mais (placeholder do pre-wrap).
  if (value.endsWith('\n')) buf += '\n'
  flush()
}

/** O anexo encostado no cursor: o de trás (Backspace) tem prioridade sobre o da frente. */
export function tokenAtCaret(root: HTMLElement, caret: number, scan: Scan = scanEditor(root)): HTMLElement | null {
  const { items } = scan
  let after: HTMLElement | null = null
  for (const item of items) {
    if (item.kind !== 'token') continue
    if (item.start + 1 === caret) return item.node
    if (item.start === caret) after = item.node
  }
  return after
}
