/**
 * A fileira de chips "↳ trecho" no campo de mensagem: um por bloco comentado,
 * na ordem em que entraram, cada um com o × para tirar. O texto inteiro do
 * trecho fica no title (o chip mostra só o começo).
 */
import { IconClose } from '../Icons'
import { chipLabel } from './quoteFormat'
import type { QuoteChip } from './useQuoteComments'
import './quoteComment.css'

export function QuoteChips({
  chips,
  onRemove
}: {
  chips: readonly QuoteChip[]
  onRemove: (key: string) => void
}): JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <div className="chips qc-chips" role="list" aria-label="Trechos citados">
      {chips.map((c) => {
        const label = chipLabel(c.text)
        return (
          <span className="chip qc-chip" role="listitem" key={c.key} title={c.text}>
            <span className="qc-chip-mark" aria-hidden="true">
              ↳
            </span>
            <span className="qc-chip-text">{label}</span>
            <button
              type="button"
              className="chip-x"
              aria-label={`Remover o trecho citado: ${label}`}
              title="Remover este trecho"
              onClick={() => onRemove(c.key)}
            >
              <IconClose size={12} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
