/**
 * A sugestão do próximo prompt acima do composer (o `prompt_suggestion` do SDK que
 * o PC publica em `conv.suggestion`), só com a conversa parada. O toque põe o
 * texto no campo — nunca envia — e o chip some; enviar ou começar um turno também.
 */
import { useEffect, useState } from 'react'
import type { ConvSummary } from '../core/types'
import { Icon } from '../ui/icons'

export function PromptSuggestionChip({ conv, onUse }: { conv: ConvSummary; onUse: (text: string) => void }): JSX.Element | null {
  // A que já foi usada some daqui; o PC só a tira quando começa um turno.
  const [used, setUsed] = useState<string | null>(null)
  // Turno novo: a mesma sugestão pode voltar depois dele e vale de novo.
  useEffect(() => {
    if (conv.busy) setUsed(null)
  }, [conv.busy])
  const text = conv.suggestion
  const key = `${conv.id}\u0000${text}`
  if (!text || conv.busy || used === key) return null
  return (
    <button
      type="button"
      className="prompt-suggestion"
      data-tip="Põe no campo, sem enviar"
      aria-label={`Usar a sugestão: ${text}`}
      onClick={() => {
        setUsed(key)
        onUse(text)
      }}
    >
      <Icon name="followup" size={15} />
      <span className="prompt-suggestion-label">Sugestão</span>
      <span className="prompt-suggestion-text">{text}</span>
    </button>
  )
}
