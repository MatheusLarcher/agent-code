/**
 * BlurText do Markdown: um plugin rehype (sem dependência) que embrulha cada
 * palavra do texto num <span class="ca-w" style="--i:N"> — a palavra entra do
 * borrado ao nítido com N × 45 ms de atraso (chatAnim.css). Como mexe na árvore
 * ANTES do React, o DOM continua sendo do React (nada de mexer em nó de texto).
 *
 * Streaming: o atraso conta a partir de `state.base` (quantas palavras já havia
 * no último render pintado), então o pedaço novo entra em cascata a partir do
 * fim e o que já estava não recomeça (o span existente só ganha atraso menor).
 * Código (pre/code) fica de fora; depois de MAX_WORDS palavras, texto puro.
 */

interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

export interface BlurWordsState {
  /** Palavras já pintadas (atualizado por quem monta, depois do commit). */
  base: number
  /** Palavras embrulhadas no último processamento. */
  total: number
}

/** Um bloco da mensagem (Markdown memoizado por bloco): a numeração continua de onde
 *  os blocos anteriores pararam (`offset`), e quantas palavras ESTE bloco teve vai para
 *  `counts[index]` — assim o texto já pintado nos outros blocos não pisca de novo. */
export interface BlurBlockState {
  base: number
  counts: number[]
}

/** Mais que isto e o resto entra sem animação (respostas longas não viram milhares de camadas). */
export const MAX_WORDS = 400
/** O maior atraso, em passos de 45 ms. */
const MAX_STEP = 40
const SKIP = new Set(['pre', 'code', 'kbd', 'svg', 'math'])

export function rehypeBlurWords(state: BlurWordsState, offset = 0): () => (tree: HNode) => void {
  return () => (tree: HNode) => {
    let i = offset
    const walk = (node: HNode): void => {
      if (!node.children) return
      const out: HNode[] = []
      for (const child of node.children) {
        if (child.type === 'element') {
          if (!SKIP.has(child.tagName ?? '')) walk(child)
          out.push(child)
          continue
        }
        if (child.type !== 'text' || !child.value || i >= MAX_WORDS) {
          out.push(child)
          continue
        }
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part) || i >= MAX_WORDS) {
            out.push({ type: 'text', value: part })
            continue
          }
          const step = Math.min(MAX_STEP, Math.max(0, i - state.base))
          out.push({ type: 'element', tagName: 'span', properties: { className: ['ca-w'], style: `--i:${step}` }, children: [{ type: 'text', value: part }] })
          i++
        }
      }
      node.children = out
    }
    walk(tree)
    state.total = i
  }
}

/** O plugin de um bloco: numera a partir de `offset` e guarda as palavras dele em `counts[index]`. */
export function rehypeBlurBlock(shared: BlurBlockState, index: number, offset: number): () => (tree: HNode) => void {
  const local: BlurWordsState = { base: 0, total: 0 }
  const inner = rehypeBlurWords(local, offset)
  return () => (tree: HNode) => {
    local.base = shared.base
    inner()(tree)
    shared.counts[index] = local.total - offset
  }
}
