/**
 * "Ler daqui": acha, no texto-fonte (Markdown) da mensagem, onde começa o bloco
 * clicado e devolve o texto dali até o fim — para o mesmo TTS do botão "Ouvir"
 * (que faz a limpeza de Markdown). O bloco chega como texto VISÍVEL (sem `**`,
 * `#`, `- `...), então a busca é pelas primeiras palavras, tolerando qualquer
 * marcação entre elas. Não achou: devolve só o texto do bloco.
 */

/** Quantas palavras do começo do bloco bastam para localizá-lo. */
const LEAD_WORDS = 8

/** Só marcação de Markdown antes do texto na linha (título, lista, citação, tabela...). */
const MARKUP_PREFIX = /^[\s>#*_\-+`~\d.)[\]!|]*$/

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const lineStart = (source: string, idx: number): number => source.lastIndexOf('\n', idx - 1) + 1

/** Primeira linha do bloco de código: sobe para a cerca (```), que o TTS descarta junto com o código. */
function withFence(source: string, start: number): number {
  if (start === 0) return start
  const prev = lineStart(source, start - 1)
  return /^\s*(```|~~~)/.test(source.slice(prev, start)) ? prev : start
}

/** Onde o bloco começa no texto-fonte (início da linha dele), ou -1. */
export function findBlockStart(source: string, blockText: string): number {
  const text = blockText.trim()
  if (!text) return -1
  const words = text.match(/[\p{L}\p{N}]+/gu)?.slice(0, LEAD_WORDS) ?? []
  const candidates: number[] = []
  if (words.length > 0) {
    const re = new RegExp(words.map(escapeRe).join('[^\\p{L}\\p{N}]+'), 'gu')
    for (let m = re.exec(source); m; m = re.exec(source)) candidates.push(m.index)
  } else {
    // Bloco sem palavras (ex.: código só com símbolos): o texto literal.
    for (let i = source.indexOf(text); i >= 0; i = source.indexOf(text, i + 1)) candidates.push(i)
  }
  if (candidates.length === 0) return -1
  // Prefere a ocorrência que abre a linha (só marcação antes): é um bloco, não o meio de outro.
  const atLineStart = candidates.find((i) => MARKUP_PREFIX.test(source.slice(lineStart(source, i), i)))
  const idx = atLineStart ?? candidates[0]
  return withFence(source, lineStart(source, idx))
}

/** O texto a ler: do bloco até o fim da mensagem; sem achar o bloco, só ele. */
export function readFromText(source: string, blockText: string): { start: number; text: string } {
  const start = findBlockStart(source, blockText)
  return start < 0 ? { start: -1, text: blockText } : { start, text: source.slice(start) }
}
