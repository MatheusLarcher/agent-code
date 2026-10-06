import { readableMediaText } from '@shared/inlineMedia'
import { IconClock, IconClose } from './Icons'

export interface QueueStripItem {
  id: string
  text: string
  thumbs: string[]
}

interface QueueStripProps {
  queued: QueueStripItem[]
  onDelete: (id: string) => void
  /** Sem ele, some o botão "agora". */
  onSendNow?: (id: string) => void
}

/** A fila da conversa, acima do campo de digitar: no chat e na tela do monitor do Escritório. */
export function QueueStrip({ queued, onDelete, onSendNow }: QueueStripProps): JSX.Element | null {
  if (queued.length === 0) return null
  return (
    <div className="queue">
      <div className="queue-label"><IconClock size={13} /> Na fila ({queued.length}) — enviadas quando a tarefa atual terminar, ou já com "agora"</div>
      {queued.map((q) => (
        <div className="queue-item" key={q.id}>
          {q.thumbs.length > 0 && (
            <span className="queue-thumbs">
              {q.thumbs.map((t, i) => (
                <img key={i} src={t} alt="anexo" />
              ))}
            </span>
          )}
          <span className="queue-text">{readableMediaText(q.text).trim() || '(imagem)'}</span>
          {onSendNow && (
            <button
              type="button"
              className="queue-now"
              onClick={() => onSendNow(q.id)}
              title="Mandar agora: entra na tarefa em andamento como ajuste, sem interromper nem cancelar o pedido anterior"
            >
              agora
            </button>
          )}
          <button className="queue-x" onClick={() => onDelete(q.id)} title="Remover da fila">
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
