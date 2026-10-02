/**
 * Realce por linha do editor do monitor — PURO (sem React).
 *
 * O hljs realça o texto INTEIRO (comentário e string de várias linhas precisam
 * do contexto) pelo highlightCode do CodeBlock — a lista única de linguagens do
 * app — e o HTML é partido por linha: o span aberto na quebra fecha no fim da
 * linha e reabre no começo da seguinte, para cada linha poder ser desenhada
 * sozinha (a lista virtual só monta as linhas à vista). O HTML vem do hljs (que
 * escapa o código) ou do escapeHtml daqui — nunca texto cru.
 *
 * LineHighlighter guarda o último resultado: num texto que só mudou no fim (o
 * código ao vivo) ele realça de novo só a partir do último fim de linha sem
 * span aberto, nas linguagens em que recomeçar ali dá o mesmo resultado.
 */
import { highlightCode } from '../../components/CodeBlock'

/** Acima disto, sem realce (texto escapado): o hljs num arquivo enorme travaria a tela. */
export const HIGHLIGHT_MAX = 400_000
/** Linguagens em que recomeçar num fim de linha sem span aberto dá o mesmo realce (CSS, XML e Markdown não). */
const RESTARTABLE = new Set(['typescript', 'javascript', 'python', 'bash', 'powershell', 'csharp', 'sql', 'json', 'yaml'])
/** Texto menor que isto é realçado inteiro (já é rápido). */
const INCREMENTAL_MIN = 12_000

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

interface Split {
  lines: string[]
  /** A linha termina sem span aberto (ponto seguro para recomeçar o realce). */
  safe: boolean[]
}

function split(html: string): Split {
  const lines: string[] = []
  const safe: boolean[] = []
  const stack: string[] = []
  const re = /<span[^>]*>|<\/span>|\n/g
  let cur = ''
  let last = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(last, m.index)
    last = m.index + m[0].length
    if (m[0] === '\n') {
      lines.push(cur + '</span>'.repeat(stack.length))
      safe.push(stack.length === 0)
      cur = stack.join('')
    } else {
      if (m[0] === '</span>') stack.pop()
      else stack.push(m[0])
      cur += m[0]
    }
  }
  cur += html.slice(last)
  lines.push(cur + '</span>'.repeat(stack.length))
  safe.push(stack.length === 0)
  return { lines, safe }
}

/** O HTML do hljs partido por linha, com os spans abertos reabertos na linha seguinte. */
export function splitHighlighted(html: string): string[] {
  return split(html).lines
}

function plain(text: string): Split {
  const lines = escapeHtml(text).split('\n')
  return { lines, safe: lines.map(() => true) }
}

function highlightSplit(text: string, lang: string): Split {
  const html = lang && text.length <= HIGHLIGHT_MAX ? highlightCode(text, lang) : null
  if (html === null) return plain(text)
  const out = split(html)
  // Defesa: uma linha a mais ou a menos desalinharia número e código.
  return out.lines.length === text.split('\n').length ? out : plain(text)
}

/** As linhas realçadas de `text` (HTML seguro). Sem linguagem, ou texto grande demais, o texto escapado. */
export function highlightToLines(text: string, lang: string): string[] {
  return highlightSplit(text, lang).lines
}

/** Realce que lembra o último texto: só refaz do último ponto seguro antes da 1ª linha que mudou. */
export class LineHighlighter {
  private text = ''
  private lang = ''
  private res: Split | null = null

  lines(text: string, lang: string): string[] {
    if (this.res && text === this.text && lang === this.lang) return this.res.lines
    const reuse = this.res && lang === this.lang && RESTARTABLE.has(lang) && text.length >= INCREMENTAL_MIN && text.length <= HIGHLIGHT_MAX
    this.res = (reuse && this.incremental(text, lang)) || highlightSplit(text, lang)
    this.text = text
    this.lang = lang
    return this.res.lines
  }

  private incremental(text: string, lang: string): Split | null {
    const before = this.res
    if (!before) return null
    const prev = this.text.split('\n')
    const next = text.split('\n')
    // A última linha do texto anterior pode ter crescido: nunca conta como igual.
    const max = Math.min(prev.length - 1, next.length)
    let k = 0
    while (k < max && prev[k] === next[k]) k++
    let j = k - 1
    while (j >= 0 && !before.safe[j]) j--
    if (j < 0) return null
    const tail = highlightSplit(next.slice(j + 1).join('\n'), lang)
    return { lines: before.lines.slice(0, j + 1).concat(tail.lines), safe: before.safe.slice(0, j + 1).concat(tail.safe) }
  }
}
