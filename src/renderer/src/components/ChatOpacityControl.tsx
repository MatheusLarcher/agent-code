/**
 * "Transparência" no cabeçalho do chat: botão que abre um pequeno popover com o
 * controle deslizante da opacidade do fundo (vale para todos os chats do Agent).
 * Teclado: o botão abre/fecha, Esc fecha, as setas mexem no slider.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { CHAT_OPACITY_MAX, CHAT_OPACITY_MIN, CHAT_OPACITY_STEP, useChatOpacity } from '../chatOpacity'
import './chatOpacity.css'

export function ChatOpacityControl(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useChatOpacity()
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div
      className="chat-opacity"
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className={`chat-opacity-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        aria-label="Transparência do chat"
        title="Transparência do chat"
      >
        <span aria-hidden="true">◐</span>
      </button>
      {open && (
        <div className="chat-opacity-pop" id={`${id}-pop`} role="group" aria-label="Transparência do chat">
          <label htmlFor={`${id}-range`}>Opacidade do fundo</label>
          <input
            id={`${id}-range`}
            type="range"
            min={CHAT_OPACITY_MIN}
            max={CHAT_OPACITY_MAX}
            step={CHAT_OPACITY_STEP}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            aria-valuetext={`${value}%`}
          />
          <output htmlFor={`${id}-range`}>{value}%</output>
          <p className="chat-opacity-note">Vale para todos os chats do Agent.</p>
        </div>
      )}
    </div>
  )
}
