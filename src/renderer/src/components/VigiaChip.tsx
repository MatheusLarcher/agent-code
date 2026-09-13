import { useState } from 'react'
import { IconClose } from './Icons'

/**
 * O aviso do vigia, entre o histórico e o composer — no mesmo lugar e molde do
 * chip de pergunta pendente, em âmbar.
 *
 * Deliberadamente NÃO é modal: o agente continua trabalhando, nada está
 * pausado, e o usuário decide se aquilo importa. As duas ações são "dispensar"
 * e "perguntar ao agente" (que entra na fila como qualquer mensagem, sem
 * interromper o turno em andamento).
 */
export function VigiaChip(props: {
  text: string
  onDismiss: () => void
  onAsk: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button type="button" className="vigia-chip" onClick={() => setOpen(true)}>
        <span className="vigia-mark" aria-hidden="true">!</span>
        <span className="vigia-chip-text">O vigia levantou uma dúvida — toque para ver</span>
      </button>
    )
  }

  return (
    <div className="vigia-card" role="status">
      <div className="vigia-card-head">
        <span className="vigia-mark" aria-hidden="true">!</span>
        <span className="vigia-card-title">Dúvida do vigia</span>
        <button type="button" className="vigia-close" onClick={props.onDismiss} title="Dispensar">
          <IconClose size={14} />
        </button>
      </div>
      <p className="vigia-card-text">{props.text}</p>
      <div className="vigia-card-actions">
        <button type="button" className="vigia-btn" onClick={props.onDismiss}>
          Dispensar
        </button>
        <button type="button" className="vigia-btn primary" onClick={props.onAsk}>
          Perguntar ao agente
        </button>
      </div>
    </div>
  )
}
