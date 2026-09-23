/**
 * Alça arrastável na borda direita do roteiro. Arrastar para a direita alarga
 * o roteiro; as setas fazem o mesmo pelo teclado (Home = mínimo, End =
 * máximo). A largura fica entre ROTEIRO_MIN_W e 40% da área; quem guarda o
 * valor é quem recebe `onCommit` (fim do arrasto ou tecla).
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { ROTEIRO_KEY_STEP, ROTEIRO_MIN_W, clampRoteiroWidth, maxRoteiroWidth } from './paneSizes'

export interface RoteiroSplitterProps {
  /** Largura atual do roteiro. */
  width: number
  /** Largura da área que o roteiro divide com o canvas (0 = não medida). */
  getContainerWidth: () => number
  /** A cada passo do arrasto. */
  onResize: (width: number) => void
  /** Fim do arrasto ou ajuste pelo teclado: a largura escolhida. */
  onCommit: (width: number) => void
}

interface Drag {
  startX: number
  startW: number
  last: number
}

export function RoteiroSplitter({ width, getContainerWidth, onResize, onCommit }: RoteiroSplitterProps): JSX.Element {
  const drag = useRef<Drag | null>(null)
  const max = maxRoteiroWidth(getContainerWidth())

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startW = clampRoteiroWidth(width, getContainerWidth())
    drag.current = { startX: e.clientX, startW, last: startW }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const next = clampRoteiroWidth(d.startW + (e.clientX - d.startX), getContainerWidth())
    if (next === d.last) return
    d.last = next
    onResize(next)
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit(d.last)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const cw = getContainerWidth()
    const target =
      e.key === 'ArrowRight'
        ? width + ROTEIRO_KEY_STEP
        : e.key === 'ArrowLeft'
          ? width - ROTEIRO_KEY_STEP
          : e.key === 'Home'
            ? ROTEIRO_MIN_W
            : e.key === 'End'
              ? maxRoteiroWidth(cw)
              : null
    if (target === null || !Number.isFinite(target)) return
    e.preventDefault()
    const next = clampRoteiroWidth(target, cw)
    onResize(next)
    onCommit(next)
  }

  return (
    <div
      className="pl-splitter pl-roteiro-splitter nokey"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura do roteiro"
      aria-valuemin={ROTEIRO_MIN_W}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuenow={width}
      tabIndex={0}
      title="Arraste para mudar a largura do roteiro"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  )
}
