/**
 * Alça arrastável entre dois painéis, no padrão do RoteiroSplitter: o painel
 * fica de um lado da alça (`side`) e cresce na direção dela — 'end' = o painel
 * está à direita (puxar para a esquerda alarga), 'start' = à esquerda (puxar
 * para a direita alarga). As setas andam `step` px no mesmo sentido do
 * arrasto, Home vai ao mínimo e End ao máximo. `onResize` a cada passo;
 * `onCommit` só no fim do arrasto ou da tecla — quem guarda o valor é quem o
 * recebe. O máximo é lido na hora (`getMax`): a área pode ter mudado; abaixo do
 * mínimo, vale o mínimo.
 *
 * O delta do ponteiro passa pela escala da área (a largura na tela ÷ a de
 * layout): numa tela inclinada pela âncora do Escritório o px do mouse não é o
 * px do painel; plana (escala 1), é.
 *
 * Visual (paneSplitter.css): 1 px de linha e 9 px de área de captura; a faixa
 * de 3 px na cor `--pane-splitter-accent` acende no hover (com atraso), no foco
 * e no arrasto, que mostra a largura em px num rótulo.
 */
import './paneSplitter.css'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

/** Passo das setas (px). */
export const PANE_KEY_STEP = 16

/** A largura entre `min` e `max` (max abaixo do mínimo vale o mínimo), em px inteiros. */
export function clampPane(width: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(Math.max(min, max), width)))
}

export interface PaneSplitterProps {
  /** Largura atual do painel. */
  width: number
  min: number
  /** O máximo agora (Infinity = área ainda não medida). */
  getMax: () => number
  /** O lado do painel: 'end' (à direita da alça) ou 'start' (à esquerda). */
  side: 'start' | 'end'
  label: string
  title?: string
  step?: number
  className?: string
  /** A cada passo do arrasto ou da tecla. */
  onResize: (width: number) => void
  /** Fim do arrasto ou ajuste pelo teclado: a largura escolhida. */
  onCommit: (width: number) => void
}

interface Drag {
  startX: number
  startW: number
  last: number
  /** px na tela por px de layout. */
  scale: number
}

export function PaneSplitter({ width, min, getMax, side, label, title, step = PANE_KEY_STEP, className, onResize, onCommit }: PaneSplitterProps): JSX.Element {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const max = Math.max(min, getMax())
  const grows = side === 'end' ? -1 : 1

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const host = e.currentTarget.parentElement
    const shown = host?.getBoundingClientRect().width ?? 0
    const scale = host && host.offsetWidth > 0 && shown > 0 ? shown / host.offsetWidth : 1
    const startW = clampPane(width, min, getMax())
    drag.current = { startX: e.clientX, startW, last: startW, scale }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const next = clampPane(d.startW + (grows * (e.clientX - d.startX)) / d.scale, min, getMax())
    if (next === d.last) return
    d.last = next
    onResize(next)
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    onCommit(d.last)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const wider = side === 'end' ? 'ArrowLeft' : 'ArrowRight'
    const narrower = side === 'end' ? 'ArrowRight' : 'ArrowLeft'
    const target = e.key === wider ? width + step : e.key === narrower ? width - step : e.key === 'Home' ? min : e.key === 'End' ? getMax() : null
    if (target === null || !Number.isFinite(target)) return
    e.preventDefault()
    const next = clampPane(target, min, getMax())
    onResize(next)
    onCommit(next)
  }

  return (
    <div
      className={`pane-splitter${dragging ? ' dragging' : ''}${className ? ` ${className}` : ''}`}
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuenow={width}
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {dragging && (
        <span className="pane-splitter-tip" aria-hidden="true">
          {width} px
        </span>
      )}
    </div>
  )
}
