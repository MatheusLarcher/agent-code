import { chatQueueNotice } from './nextPrompts'
import { useNextPrompts, type NextPromptsApi } from './useNextPrompts'
import './nextPrompts.css'

/**
 * O aviso no chat da implantação, acima do composer: "2 prompts esperando no
 * quadro — ver" (com o motivo, se o próximo parou ou o PO o segurou). Os
 * prompts 2..N não aparecem mais na fila do chat — sem este aviso eles
 * "sumiriam" de onde o usuário está acostumado a vê-los. "ver" abre a faixa.
 */
export function ChatQueueNotice(props: {
  projectCwd: string
  conversationId: string
  onOpen(): void
  api?: NextPromptsApi | null
}): JSX.Element | null {
  const api = props.api === undefined ? ((window as unknown as { api?: NextPromptsApi }).api ?? null) : props.api
  const { items } = useNextPrompts(props.projectCwd, api)
  const notice = chatQueueNotice(items, props.conversationId)
  if (!notice) return null
  return (
    <div className={`chat-queue-notice${notice.stopped ? ' stopped' : ''}`} role="status" aria-label="Prompts esperando no quadro">
      <span>{notice.text}</span>
      <button type="button" className="next-btn" onClick={props.onOpen}>
        ver
      </button>
    </div>
  )
}
