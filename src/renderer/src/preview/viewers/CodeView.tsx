/**
 * Código e texto do Preview: número de linha + realce do highlight.js (o mesmo
 * realce e as mesmas cores do chat, via highlightCode do CodeBlock).
 *
 * Dois <pre> lado a lado (números | código) em vez de um elemento por linha:
 * um arquivo de 2 MB com 50 mil linhas continua sendo dois nós no DOM.
 * Arquivo grande demais vai sem realce para não travar a tela.
 */
import { useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import { PREVIEW_LIMITS } from '@shared/preview'
import { highlightCode } from '../../components/CodeBlock'
import { ViewerNotice } from './ViewerNotice'
import { fmtInt } from './tableData'
import './viewers.css'

/** Acima disto (caracteres), sem realce. */
export const CODE_HIGHLIGHT_MAX = 300_000
/** Sem linguagem conhecida, a detecção automática roda todas as linguagens: só até aqui. */
const AUTO_DETECT_MAX = 100_000
/** Quanto do arquivo de texto o main manda (para o aviso de cortado). */
const TEXT_MB = PREVIEW_LIMITS.textBytes / (1024 * 1024)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeHtml = (s: string): string => s.replace(/[&<>]/g, (c) => ESC[c])

/** HTML seguro do código: realçado quando dá, senão o texto escapado. */
export function codeHtml(text: string, lang: string | undefined, plain: boolean): { html: string; highlighted: boolean } {
  const known = !!lang && !!hljs.getLanguage(lang)
  const canHighlight = !plain && text.length <= CODE_HIGHLIGHT_MAX && (known || (!!lang && text.length <= AUTO_DETECT_MAX))
  if (canHighlight) {
    const html = highlightCode(text, known ? lang : undefined)
    if (html !== null) return { html, highlighted: true }
  }
  return { html: escapeHtml(text), highlighted: false }
}

export interface CodeViewProps {
  text: string
  /** Linguagem do highlight.js (codeLangFor). */
  lang?: string
  truncated?: boolean
  /** Texto puro (.txt, .log): sem realce. */
  plain?: boolean
  /** Aviso extra acima do código (ex.: JSON inválido). */
  notice?: string
}

export function CodeView({ text, lang, truncated = false, plain = false, notice }: CodeViewProps): JSX.Element {
  // A quebra de linha final do arquivo não vira uma linha vazia numerada.
  const body = useMemo(() => text.replace(/\r\n?/g, '\n').replace(/\n$/, ''), [text])
  const { html, highlighted } = useMemo(() => codeHtml(body, lang, plain), [body, lang, plain])
  const gutter = useMemo(() => {
    let lines = 1
    for (let i = body.indexOf('\n'); i !== -1; i = body.indexOf('\n', i + 1)) lines++
    return Array.from({ length: lines }, (_, i) => i + 1).join('\n')
  }, [body])
  const tooBig = !plain && body.length > CODE_HIGHLIGHT_MAX

  return (
    <div className="pv-code-wrap">
      {notice && <ViewerNotice>{notice}</ViewerNotice>}
      {(truncated || tooBig) && (
        <ViewerNotice>
          {truncated ? `Arquivo grande: mostrando só os primeiros ${fmtInt(TEXT_MB)} MB` : 'Arquivo grande'}
          {tooBig ? ', sem cores para não travar.' : '.'}
        </ViewerNotice>
      )}
      <div className="pv-code pv-scroll" data-highlighted={highlighted ? 'true' : 'false'}>
        <pre className="pv-code-gutter" aria-hidden="true">
          {gutter}
        </pre>
        <pre className="pv-code-text hljs">
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  )
}
