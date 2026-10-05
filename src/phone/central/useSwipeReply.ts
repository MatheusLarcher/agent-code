/**
 * Responder uma mensagem da Central (estilo WhatsApp): arrastar para a direita
 * (horizontal dominante) move a mensagem e revela a seta; soltar além do limiar
 * entra no modo resposta (citação acima do campo, `replyTo` no envio — o PC
 * entrega direto na conversa dela, sem o decisor). Sempre volta ao lugar.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent } from 'react'
import { setCentralReply, type CentralQuote } from './centralStore'

/** Até onde a mensagem anda e a partir de onde soltar responde (px). */
const SWIPE_MAX = 80
const SWIPE_ARM = 56

export interface SwipeBind {
  className: string
  style: { transform?: string }
  iconOpacity: number
  armed: boolean
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onClickCapture: (e: MouseEvent) => void
  }
}

export function useSwipeReply(quote: CentralQuote | null): SwipeBind | null {
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const axis = useRef<'x' | 'y' | null>(null)
  const swiped = useRef(false)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  if (!quote) return null

  const end = (): void => {
    if (!start.current) return
    const fire = axis.current === 'x' && dx >= SWIPE_ARM
    swiped.current = axis.current === 'x'
    start.current = null
    axis.current = null
    setDragging(false)
    setDx(0)
    if (!fire) return
    try {
      navigator.vibrate?.(10)
    } catch {
      /* sem vibração */
    }
    setCentralReply(quote)
  }

  return {
    className: `c-swipe ${dragging ? 'c-dragging' : 'c-settle'}`,
    style: dx ? { transform: `translateX(${dx}px)` } : {},
    iconOpacity: Math.min(1, dx / SWIPE_ARM),
    armed: dx >= SWIPE_ARM,
    handlers: {
      onPointerDown: (e) => {
        if (e.button) return
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
        axis.current = null
        setDx(0)
      },
      onPointerMove: (e) => {
        const s = start.current
        if (!s || e.pointerId !== s.id) return
        const mx = e.clientX - s.x
        const my = e.clientY - s.y
        if (!axis.current) {
          if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
          axis.current = mx > 0 && Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
          if (axis.current !== 'x') return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* sem captura: segue */
          }
          setDragging(true)
        }
        if (axis.current !== 'x') return
        setDx(Math.max(0, Math.min(SWIPE_MAX, mx)))
        e.preventDefault()
      },
      onPointerUp: end,
      onPointerCancel: end,
      // O toque que terminou um arrasto não vira clique (abrir destino, mostrar o porquê).
      onClickCapture: (e) => {
        if (!swiped.current) return
        swiped.current = false
        e.stopPropagation()
        e.preventDefault()
      }
    }
  }
}
