import { useRef, useState, type KeyboardEvent } from 'react'
import { BOARD_AUTHORIZE_MESSAGE, boardItemAwaitingBadge, type BoardItem } from '@shared/ipc'

/**
 * A resposta do usuário direto no cartão "Aguardando você", no controle que o PO
 * escolheu (`BoardItem.poReplyKind`): 'authorize' = botão "Pode fazer"; 'answer' =
 * campo de texto. A mensagem vai para a conversa DONA do cartão (`conversationId`)
 * pelo mesmo despachante do composer — o App decide como (fila, sessão parada).
 *
 * Mora FORA do <button> do cartão (nada de botão dentro de botão), como irmão
 * dentro do `board-card-wrap`; o clique e o arrasto param aqui para não abrir o
 * detalhe nem mover o cartão.
 */

/** O que o App devolve: enviada, conversa não existe mais aqui, ou o envio falhou. */
export type BoardReplyOutcome = 'sent' | 'missing' | 'failed'
export type BoardCardReplyHandler = (conversationId: string, text: string) => Promise<BoardReplyOutcome>

const PLACEHOLDER_MAX = 60

const ERRORS: Record<Exclude<BoardReplyOutcome, 'sent'>, string> = {
  missing: 'A conversa deste cartão não está mais aqui.',
  failed: 'Não deu para enviar. Tente de novo.'
}

/** O que o PO pediu, encurtado para caber no placeholder. */
function placeholderFor(item: BoardItem): string {
  const action = item.poUserAction?.trim()
  if (!action) return 'Responder ao agente…'
  return action.length > PLACEHOLDER_MAX ? `${action.slice(0, PLACEHOLDER_MAX - 1)}…` : action
}

export function BoardCardReply({
  item,
  onReply,
  className
}: {
  item: BoardItem
  onReply?: BoardCardReplyHandler
  className?: string
}): JSX.Element | null {
  const [text, setText] = useState('')
  // A versão do cartão no envio: "Enviado" vale até o cartão mudar (revisão ou
  // updatedAt), quando o controle volta — ou some junto com o selo.
  const [sentVersion, setSentVersion] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // O estado só chega no próximo render: dois cliques no mesmo tique passariam.
  const inFlight = useRef(false)

  const kind = boardItemAwaitingBadge(item) ? item.poReplyKind : null
  if (!kind || !onReply) return null

  const version = `${item.revision}|${item.updatedAt}`
  const sent = sentVersion === version
  const disabled = sent || sending

  const send = async (message: string): Promise<void> => {
    const body = message.trim()
    if (!body || inFlight.current || sent) return
    inFlight.current = true
    setSending(true)
    setError(null)
    let outcome: BoardReplyOutcome
    try {
      outcome = await onReply(item.conversationId, body)
    } catch {
      outcome = 'failed'
    }
    inFlight.current = false
    setSending(false)
    if (outcome === 'sent') {
      setSentVersion(version)
      setText('')
    } else {
      setError(ERRORS[outcome])
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    void send(text)
  }

  return (
    <div
      className={`board-card-reply${className ? ` ${className}` : ''}`}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {kind === 'authorize' ? (
        <button
          type="button"
          className="board-reply-btn primary"
          disabled={disabled}
          onClick={() => void send(BOARD_AUTHORIZE_MESSAGE)}
        >
          {sent ? 'Enviado' : 'Pode fazer'}
        </button>
      ) : (
        <>
          <textarea
            className="board-reply-input"
            rows={2}
            value={text}
            placeholder={placeholderFor(item)}
            aria-label="Resposta ao agente"
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="board-reply-btn"
            disabled={disabled || !text.trim()}
            onClick={() => void send(text)}
          >
            {sent ? 'Enviado' : 'Enviar'}
          </button>
        </>
      )}
      {error && (
        <span className="board-reply-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
