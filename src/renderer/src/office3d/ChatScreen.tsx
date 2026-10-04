/**
 * O modo Chat da tela focada do monitor (codeScreen/CodeMonitor): o turno atual
 * da conversa do agente como o chat mostra — balão do pedido, narração e
 * resposta em Markdown e cada ferramenta no ToolCard recolhido, que abre ao
 * clicar —, só leitura, com o cabeçalho do agente e rolagem própria. Fica presa
 * ao fim enquanto o usuário não rola para cima; a rolagem é só do corpo
 * (scrollTop direto, nunca scrollIntoView: o palco 3D não se mexe).
 *
 * Quem monta (o CodeMonitor) passa as mensagens do turno e o cartão do código
 * ao vivo (o tool-use que ainda vai chegar), já assinado por ele.
 */
import { useLayoutEffect, useRef } from 'react'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { ToolInputDelta } from '../office/liveInput'
import type { UIMessage } from '../types'
import { liveToolMessage, lookupOf, turnMessages, type ToolUseMessage, type TurnHead } from './chatPage'
import { TurnHeader, TurnRows } from './ChatTurn'
import './screens.css'

/** A tela mostra no máximo isto do turno (o resto, um aviso no topo). */
export const SCREEN_MESSAGES = 60
/** Até aqui do fim conta como "no fim" (segue as mensagens novas). */
const END_SLACK_PX = 48

export interface ChatContent {
  messages: UIMessage[]
  /** O cartão do código ao vivo; some quando o tool-use dele chega no chat. */
  live: ToolUseMessage | null
}

/** O que o modo Chat mostra do personagem. */
export function chatContent(feed: OfficeFeed | null, model: OfficeCharacterModel, live: ToolInputDelta | undefined): ChatContent {
  const messages = turnMessages(feed, lookupOf(model))
  const shown = live && !messages.some((m) => m.kind === 'tool-use' && m.id === live.toolUseId)
  return { messages, live: shown ? liveToolMessage(live) : null }
}

export interface ChatPanelProps {
  head: TurnHead
  seed: string
  content: ChatContent
}

export function ChatPanel({ head, seed, content }: ChatPanelProps): JSX.Element {
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
    <div className="o3d-chat-screen">
      <TurnHeader head={head} seed={seed} />
      <div className="message-list o3d-chat-screen-body" ref={bodyRef} onScroll={onScroll}>
        <TurnRows messages={content.messages} busy={head.busy} live={content.live} limit={SCREEN_MESSAGES} />
      </div>
    </div>
  )
}
