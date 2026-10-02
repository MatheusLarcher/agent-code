/**
 * Tela focada do monitor (clique no agente): o turno atual da conversa dele
 * como o chat mostra — balão do pedido, narração e resposta em Markdown e cada
 * ferramenta no ToolCard recolhido, que abre ao clicar —, só leitura, com o
 * cabeçalho do agente e rolagem própria. Fica presa ao fim enquanto o usuário
 * não rola para cima; a rolagem é só do corpo (scrollTop direto, nunca
 * scrollIntoView: o palco 3D não se mexe).
 *
 * Acompanha o feed (o pai re-renderiza a cada feed) e, no principal, o código
 * ao vivo do liveInput — o cartão que ainda vai chegar, no fim —, assinado só
 * enquanto esta tela existe.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { liveInput, type ToolInputDelta } from '../office/liveInput'
import { liveToolMessage, lookupOf, turnHead, turnMessages } from './chatPage'
import { TurnHeader, TurnRows } from './ChatTurn'
import './screens.css'

/** A tela mostra no máximo isto do turno (o resto, um aviso no topo). */
export const SCREEN_MESSAGES = 60
/** Até aqui do fim conta como "no fim" (segue as mensagens novas). */
const END_SLACK_PX = 48

export interface ChatScreenProps {
  feed: OfficeFeed | null
  model: OfficeCharacterModel
  /** Fecha a tela (o mesmo do Esc). */
  onClose?: () => void
}

export function ChatScreen({ feed, model, onClose }: ChatScreenProps): JSX.Element {
  const isMain = model.role === 'principal' && !model.trackId
  const convId = model.convId
  const [live, setLive] = useState<ToolInputDelta | undefined>(() => (isMain ? liveInput.latest(convId, null) : undefined))

  useEffect(() => {
    if (!isMain) return
    setLive(liveInput.latest(convId, null))
    return liveInput.subscribe(convId, null, (ev) => setLive(ev.done ? undefined : ev))
  }, [isMain, convId])

  const messages = useMemo(() => turnMessages(feed, lookupOf(model)), [feed, model])
  const head = turnHead(feed, model)
  // O cartão ao vivo some quando o tool-use dele chega no chat.
  const liveMsg = live && !messages.some((m) => m.kind === 'tool-use' && m.id === live.toolUseId) ? liveToolMessage(live) : null

  const bodyRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  })
  const onScroll = (): void => {
    const el = bodyRef.current
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= END_SLACK_PX
  }

  return (
    <div className="o3d-chat-screen" data-testid="office-screen" data-kind={messages.length > 0 || liveMsg ? 'chat' : 'empty'}>
      <TurnHeader head={head} seed={model.seed}>
        {onClose && (
          <button type="button" className="o3d-turn-close" onClick={onClose} aria-label="Fechar a tela" title="Fechar (Esc)">
            ×
          </button>
        )}
      </TurnHeader>
      <div className="message-list o3d-chat-screen-body" ref={bodyRef} onScroll={onScroll}>
        <TurnRows messages={messages} busy={head.busy} live={liveMsg} limit={SCREEN_MESSAGES} />
      </div>
    </div>
  )
}
