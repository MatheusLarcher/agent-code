/**
 * Divide uma resposta em Markdown em BLOCOS que se renderizam sozinhos, para o
 * streaming só reprocessar o último (o que cresce) — os anteriores ficam em memo.
 * Corta só em linha em branco fora de bloco de código, e nunca onde o corte mudaria
 * o resultado: continuação recuada, itens da mesma lista e mensagens com definição
 * de link (`[x]: url`, usada em qualquer ponto do texto) ficam juntos.
 */

/** Abaixo disto não vale dividir: o texto inteiro processa rápido. */
export const MIN_SPLIT_LENGTH = 600

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*\S/m

const isBlank = (line: string): boolean => line.trim() === ''

export function splitMarkdownBlocks(source: string): string[] {
  if (source.length < MIN_SPLIT_LENGTH || LINK_DEFINITION.test(source)) return [source]
  const lines = source.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: { char: string; size: number } | null = null
  let blankSeen = false
  /** O bloco atual tem item de lista: outro item depois da linha em branco é a mesma lista. */
  let listOpen = false
  for (const line of lines) {
    if (fence) {
      current.push(line)
      const close = FENCE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.size && line.trim() === close[1]) fence = null
      continue
    }
    if (isBlank(line)) {
      if (current.length) blankSeen = true
      current.push(line)
      continue
    }
    const indented = /^[ \t]/.test(line)
    const item = LIST_ITEM.test(line)
    if (blankSeen && !indented && !(item && listOpen) && current.some((l) => !isBlank(l))) {
      blocks.push(withoutTrailingBlank(current))
      current = []
      listOpen = false
    }
    blankSeen = false
    current.push(line)
    if (item) listOpen = true
    const open = FENCE.exec(line)
    if (open) fence = { char: open[1][0], size: open[1].length }
  }
  // As linhas em branco das bordas não entram no bloco: senão o bloco anterior mudaria
  // de texto (e seria processado de novo) só porque a linha em branco chegou.
  if (current.some((l) => !isBlank(l))) blocks.push(fence ? current.join('\n') : withoutTrailingBlank(current))
  return blocks.length ? blocks : [source]
}

function withoutTrailingBlank(lines: string[]): string {
  let end = lines.length
  while (end > 0 && isBlank(lines[end - 1])) end--
  return lines.slice(0, end).join('\n')
}
