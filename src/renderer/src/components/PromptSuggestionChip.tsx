/**
 * A sugestão do próximo prompt, acima do composer — só sem turno rodando (quem
 * monta decide). O clique põe o texto no campo, nunca envia, e o chip some;
 * enviar ou começar um turno também o esconde (o main manda `null` no início).
 */
import { IconCornerDownRight } from './Icons'
import './promptSuggestionChip.css'

export function PromptSuggestionChip({ text, onUse }: { text?: string; onUse: (text: string) => void }): JSX.Element | null {
  if (!text) return null
  return (
    <button
      type="button"
      className="prompt-suggestion-chip"
      data-tip="Põe no campo, sem enviar"
      aria-label={`Usar a sugestão: ${text}`}
      onClick={() => onUse(text)}
    >
      <IconCornerDownRight size={13} className="prompt-suggestion-icon" aria-hidden="true" />
      <span className="prompt-suggestion-label">Sugestão</span>
      <span className="prompt-suggestion-text">{text}</span>
    </button>
  )
}
