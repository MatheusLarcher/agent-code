/**
 * O editor de uma aba: número da linha, sinal do diff (+ verde, − vermelho) e o
 * código realçado. Lista virtual de altura fixa — só as linhas à vista (e uma
 * folga) ficam no DOM, então um arquivo de milhares de linhas não pesa. A
 * altura da linha vem do CSS (`--cm-row`); a rolagem é só do corpo (scrollTop,
 * nunca scrollIntoView: o palco 3D não se mexe).
 *
 * Uma montagem por arquivo (key no pai): ao abrir, a tela vai até `target` (o
 * cursor do Agent, a edição mais recente ou a 1ª mudança) e, enquanto o usuário
 * não rolar, volta a ir sempre que `targetKey` muda e o alvo sai da faixa do
 * meio; seguindo o Agent, sempre. A roda ou um clique no código é o usuário
 * assumindo a rolagem: `onUserScroll`.
 *
 * O realce é o do CodeBlock (highlightLines): o texto inteiro de cada lado,
 * guardado entre um pedaço e outro do código ao vivo.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { extToLang } from '../../components/CodeBlock'
import type { FileView, Row, RowKind } from './fileView'
import { highlightToLines, LineHighlighter } from './highlightLines'
import { extOf, Icon } from './icons'

/** Sem CSS (testes) ou antes de medir: a altura da linha e da área à vista. */
const ROW_FALLBACK = 19
const VIEW_FALLBACK = 640
/** Linhas a mais renderizadas acima e abaixo da área à vista. */
const OVERSCAN = 10
const TAB_SIZE = 4

export interface EditorPaneProps {
  path: string
  view: FileView
  /** Linha (índice em rows) que a tela acompanha; -1 = nenhuma. */
  target: number
  /** Muda quando a tela deve ir de novo até `target`. */
  targetKey: string
  follow: boolean
  onUserScroll: () => void
}

const SIGN: Record<RowKind, string> = { ctx: '', add: '+', del: '−', gap: '', hunk: '' }

/** Coluna na tela (tabulação = TAB_SIZE) do caractere `col` da linha. */
function visualCol(text: string, col: number): number {
  let v = 0
  for (let i = 0; i < col && i < text.length; i++) v = text[i] === '\t' ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1
  return v + Math.max(0, col - text.length)
}

/** Marcas da régua à direita, no máximo. */
const RULER_MAX = 300

interface Mark {
  at: number
  len: number
  kind: 'add' | 'del' | 'mix'
}

/** A régua da direita (a do VS Code): cada bloco de linhas mudadas vira uma marca na altura dele. */
function rulerMarks(rows: readonly Row[]): Mark[] {
  const out: Mark[] = []
  for (let i = 0; i < rows.length && out.length < RULER_MAX; ) {
    if (rows[i].kind !== 'add' && rows[i].kind !== 'del') {
      i++
      continue
    }
    let j = i
    let add = false
    let del = false
    for (; j < rows.length && (rows[j].kind === 'add' || rows[j].kind === 'del'); j++) {
      if (rows[j].kind === 'add') add = true
      else del = true
    }
    out.push({ at: i, len: j - i, kind: add && del ? 'mix' : add ? 'add' : 'del' })
    i = j
  }
  return out
}

/** Maior linha (em caracteres) dos textos: a largura da área que rola para o lado. */
function widest(texts: readonly string[]): number {
  let max = 0
  for (const t of texts) {
    let start = 0
    for (let i = t.indexOf('\n'); ; i = t.indexOf('\n', start)) {
      const end = i === -1 ? t.length : i
      if (end - start > max) max = end - start
      if (i === -1) break
      start = i + 1
    }
  }
  return max
}

interface RowProps {
  kind: RowKind
  num: number | null
  html: string
  label?: string
  /** Coluna do cursor do Agent nesta linha (null = sem cursor). */
  caret: number | null
  gapWidth: number
}

const CodeRow = memo(function CodeRow({ kind, num, html, label, caret, gapWidth }: RowProps): JSX.Element {
  return (
    <div className={`cm-row cm-${kind}${caret !== null ? ' cm-current' : ''}`}>
      <span className="cm-gutter">
        <span className="cm-num">{num ?? ''}</span>
        <span className="cm-sign">{SIGN[kind]}</span>
      </span>
      {kind === 'hunk' ? (
        <span className="cm-hunk-label">{label}</span>
      ) : (
        <span className="cm-code">
          {kind === 'gap' ? <span className="cm-skeleton" style={{ width: `${gapWidth}ch` }} /> : <span dangerouslySetInnerHTML={{ __html: html }} />}
          {caret !== null && (
            <span className="cm-caret" style={{ left: `${caret}ch` }}>
              <span className="cm-flag">Agent</span>
            </span>
          )}
        </span>
      )}
    </div>
  )
})

export function EditorPane({ path, view, target, targetKey, follow, onUserScroll }: EditorPaneProps): JSX.Element {
  const ext = extOf(path)
  const lang = ext === 'ipynb' ? 'python' : extToLang(path)
  const hl0 = useRef<LineHighlighter | null>(null)
  const hl1 = useRef<LineHighlighter | null>(null)
  hl0.current ??= new LineHighlighter()
  hl1.current ??= new LineHighlighter()
  const html0 = useMemo(() => hl0.current!.lines(view.before, lang), [view.before, lang])
  const html1 = useMemo(() => hl1.current!.lines(view.after, lang), [view.after, lang])
  const html2 = useMemo(() => view.blocks.map((b) => highlightToLines(b, lang)), [view.blocks, lang])
  const cols = useMemo(() => widest([view.before, view.after, ...view.blocks]), [view.before, view.after, view.blocks])
  const maxNum = useMemo(() => view.rows.reduce((m, r) => (r.num !== null && r.num > m ? r.num : m), 0), [view.rows])
  const marks = useMemo(() => rulerMarks(view.rows), [view.rows])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ top: 0, height: 0, rowH: ROW_FALLBACK })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const rowH = parseFloat(getComputedStyle(el).getPropertyValue('--cm-row')) || ROW_FALLBACK
      setBox((b) => (b.height === el.clientHeight && b.rowH === rowH ? b : { ...b, height: el.clientHeight, rowH }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // O usuário rolou este arquivo: sem seguir, a tela não se mexe mais sozinha.
  const manual = useRef(false)
  const onManual = (): void => {
    manual.current = true
    onUserScroll()
  }
  // O alvo no meio da tela quando ele sai da faixa confortável (ao abrir o arquivo e seguindo).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || (!follow && manual.current)) return
    const h = el.clientHeight || VIEW_FALLBACK
    const y = target < 0 ? 0 : target * box.rowH
    const top = el.scrollTop
    if (target >= 0 && y >= top + h * 0.2 && y + box.rowH <= top + h * 0.75) return
    // Em linhas inteiras: a primeira linha à vista não sai cortada embaixo da trilha.
    const next = target < 0 ? 0 : Math.max(0, Math.round((y - h * 0.4) / box.rowH) * box.rowH)
    if (next === top) return
    el.scrollTop = next
    setBox((b) => ({ ...b, top: el.scrollTop }))
    // Só a mudança de alvo (ou voltar a seguir) rola; o resto do render não.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, follow, box.rowH])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setBox((b) => (b.top === el.scrollTop ? b : { ...b, top: el.scrollTop }))
  }

  const rows = view.rows
  const viewH = box.height || VIEW_FALLBACK
  const first = Math.max(0, Math.floor(box.top / box.rowH) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((box.top + viewH) / box.rowH) + OVERSCAN)
  const textOf = (r: Row): string => {
    const src = r.src === 0 ? view.before : r.src === 1 ? view.after : view.blocks[r.block ?? 0] ?? ''
    // Só a linha do cursor pede o texto puro: corta a linha sem dividir o arquivo inteiro.
    let start = 0
    for (let i = 0; i < r.line; i++) {
      const nl = src.indexOf('\n', start)
      if (nl === -1) return ''
      start = nl + 1
    }
    const end = src.indexOf('\n', start)
    return src.slice(start, end === -1 ? src.length : end)
  }
  const caretRow = view.caret ? view.caret.row : -1
  const caretCol = caretRow >= first && caretRow < last ? visualCol(textOf(rows[caretRow]), view.caret!.col - 1) : null
  const htmlOf = (r: Row): string => (r.src === 0 ? html0[r.line] : r.src === 1 ? html1[r.line] : html2[r.block ?? 0]?.[r.line]) ?? ''

  const digits = Math.max(3, String(maxNum).length)
  // Digitando: espaço depois da última linha (como o "rolar além da última linha" do VS Code)
  // para o cursor do Agent poder ficar no meio da tela.
  const beyond = view.caret ? Math.max(0, viewH - 4 * box.rowH) : 0
  const total = rows.length * box.rowH + beyond
  const style = {
    '--cm-num-w': `${digits}ch`,
    height: `${total}px`,
    // Calha (número + folga + sinal) + a linha mais longa: a largura que rola para o lado.
    minWidth: `${digits + 4 + cols + 3}ch`
  } as CSSProperties
  // A régua cobre a altura que rola; arquivo mais curto que a tela fica com as marcas na altura real das linhas.
  const span = Math.max(total, viewH, 1)
  const pct = (row: number): string => `${((row * box.rowH) / span) * 100}%`

  return (
    <div className="cm-editor">
      {view.note && (
        <div className="cm-note" role="note">
          <Icon name="info" />
          <span>{view.note}</span>
        </div>
      )}
      <div className="cm-scroll-wrap">
        <div
          className="cm-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onManual}
          onPointerDown={onManual}
          tabIndex={0}
          aria-label={`Código de ${path.split(/[\\/]/).pop() ?? path}`}
          data-mode={view.mode}
        >
          <div className="cm-canvas" style={style}>
            <div className="cm-rows" style={{ top: `${first * box.rowH}px` }}>
              {rows.slice(first, last).map((r, i) => {
                const idx = first + i
                return (
                  <CodeRow
                    key={idx}
                    kind={r.kind}
                    num={r.num}
                    html={r.kind === 'gap' || r.kind === 'hunk' ? '' : htmlOf(r)}
                    label={r.label}
                    caret={idx === caretRow ? caretCol : null}
                    gapWidth={8 + (((r.num ?? idx) * 13) % 40)}
                  />
                )
              })}
            </div>
          </div>
        </div>
        {(marks.length > 0 || caretRow >= 0) && (
          <div className="cm-ruler" aria-hidden="true">
            {marks.map((m) => (
              <span key={m.at} className={`cm-mark cm-mark-${m.kind}`} style={{ top: pct(m.at), height: `max(2px, ${pct(m.len)})` }} />
            ))}
            {caretRow >= 0 && <span className="cm-mark cm-mark-caret" style={{ top: pct(caretRow) }} />}
          </div>
        )}
      </div>
    </div>
  )
}
