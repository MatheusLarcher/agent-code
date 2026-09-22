/**
 * Divisor arrastável entre o canvas e o chat do Manager. Arrastar para a
 * esquerda alarga o chat; as setas fazem o mesmo pelo teclado (Home = mínimo,
 * End = máximo). A largura fica entre CHAT_MIN_W e metade da área; quem guarda
 * o valor é quem recebe `onCommit` (fim do arrasto ou tecla).
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { CHAT_KEY_STEP, CHAT_MIN_W, clampChatWidth, maxChatWidth } from './paneSizes'

export interface ChatSplitterProps {
  /** Largura atual do chat. */
  width: number
  /** Largura da área que o chat divide com roteiro e canvas (0 = não medida). */
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

export function ChatSplitter({ width, getContainerWidth, onResize, onCommit }: ChatSplitterProps): JSX.Element {
  const drag = useRef<Drag | null>(null)
  const max = maxChatWidth(getContainerWidth())

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startW = clampChatWidth(width, getContainerWidth())
    drag.current = { startX: e.clientX, startW, last: startW }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const next = clampChatWidth(d.startW + (d.startX - e.clientX), getContainerWidth())
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
      e.key === 'ArrowLeft'
        ? width + CHAT_KEY_STEP
        : e.key === 'ArrowRight'
          ? width - CHAT_KEY_STEP
          : e.key === 'Home'
            ? CHAT_MIN_W
            : e.key === 'End'
              ? maxChatWidth(cw)
              : null
    if (target === null || !Number.isFinite(target)) return
    e.preventDefault()
    const next = clampChatWidth(target, cw)
    onResize(next)
    onCommit(next)
  }

  return (
    <div
      className="pl-splitter nokey"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura do chat"
      aria-valuemin={CHAT_MIN_W}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuenow={width}
      tabIndex={0}
      title="Arraste para mudar a largura do chat"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  )
}
