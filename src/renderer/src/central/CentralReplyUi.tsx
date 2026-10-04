/**
 * Responder uma mensagem na Central (estilo WhatsApp), no PC: o botão de traço
 * que aparece no hover da mensagem, o menu do clique com o botão direito e a
 * citação (projeto · conversa + trecho) — acima do campo, com ×, e dentro da
 * bolha do pedido que respondeu.
 */
import { useEffect, type CSSProperties } from 'react'
import type { CentralReplyQuote } from '@shared/central'
import type { LabelOf } from './centralView'
import { CentralWho } from './CentralGlyph'

/** A seta de "responder" (traço, como os ícones do app). */
function ReplyIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  )
}

export function ReplyButton({ onReply }: { onReply: () => void }): JSX.Element {
  return (
    <button type="button" className="central-reply-btn" aria-label="Responder" title="Responder" onClick={onReply}>
      <ReplyIcon />
    </button>
  )
}

/** A citação: na cor da conversa citada, "projeto · conversa" e o trecho. */
export function ReplyQuote({ quote, labelFor, onCancel }: { quote: CentralReplyQuote; labelFor: LabelOf; onCancel?: () => void }): JSX.Element {
  const dest = labelFor(quote.convId)
  return (
    <div className={`central-quote${onCancel ? ' composing' : ''}`} style={{ '--c': dest.color } as CSSProperties} data-reply-to={quote.id}>
      <div className="central-quote-body">
        <span className="central-quote-who"><CentralWho label={dest} /></span>
        <span className="central-quote-text">{quote.text}</span>
      </div>
      {onCancel && (
        <button type="button" className="central-quote-x" aria-label="Cancelar resposta" title="Cancelar resposta (Esc)" onClick={onCancel}>
          ×
        </button>
      )}
    </div>
  )
}

/** O menu do botão direito: só "Responder". Fecha com Esc, clique fora ou rolagem. */
export function ReplyMenu({ x, y, onReply, onClose }: { x: number; y: number; onReply: () => void; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const close = (): void => onClose()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div className="central-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onReply()
          onClose()
        }}
      >
        <ReplyIcon />
        Responder
      </button>
    </div>
  )
}
