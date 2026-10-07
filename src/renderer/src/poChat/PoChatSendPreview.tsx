import { useEffect, useRef } from 'react'
import type { PoChatOption } from '@shared/poChat'

/**
 * A PRÉVIA do "Mandar fazer": o texto EXATO que vai ao agente (montado pelo
 * código a partir dos cards, com a nota curta do PO), para onde vai, e os dois
 * botões. Nada sai sem o "Mandar". Conversa dona que não está neste PC (apagada
 * ou de outro PC): vai numa conversa nova de implementação no projeto.
 */
export function PoChatSendPreview(props: {
  option: Extract<PoChatOption, { kind: 'mandar' }>
  /** A conversa dona está neste PC? */
  ownerHere: boolean
  onConfirm(): void
  onCancel(): void
}): JSX.Element {
  const { option } = props
  const ref = useRef<HTMLDivElement>(null)
  // Abre no fim do feed: rola até ela, para os botões não ficarem cortados.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])
  return (
    <div ref={ref} className="po-chat-preview" role="group" aria-label="Prévia do pedido">
      <div className="po-chat-preview-to">
        {props.ownerHere ? (
          <>
            Vai para a conversa <strong>'{option.conversationTitle}'</strong>, pela fila do projeto (um plano por vez; se o projeto estiver livre, sai na hora):
          </>
        ) : (
          <>
            A conversa <strong>'{option.conversationTitle}'</strong> não está neste PC: o pedido vai numa <strong>conversa nova de implementação</strong> neste projeto, pela fila:
          </>
        )}
      </div>
      <pre className="po-chat-preview-text">{option.text}</pre>
      <div className="central-opts">
        <button type="button" className="central-opt best" onClick={props.onConfirm}>
          Mandar
        </button>
        <button type="button" className="central-opt" onClick={props.onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
