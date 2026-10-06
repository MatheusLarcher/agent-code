/**
 * O Chat da tela focada do monitor (codeScreen/CodeMonitor, à direita do
 * editor): o turno atual da conversa do agente como o chat mostra — balão do
 * pedido, narração e resposta em Markdown e cada ferramenta no ToolCard
 * recolhido, que abre ao clicar —, com o cabeçalho do agente (ou o `header` de
 * quem monta) e rolagem própria. Os ganchos do chat são de quem monta: com
 * `tts`, "Ouvir"; com `quote`, "Comentar" (e, com os dois, "Ler daqui") — sem
 * eles, só leitura. Fica presa ao fim enquanto o usuário não rola para cima, e volta ao
 * fim quando `endSignal` muda; a rolagem é só do corpo (scrollTop direto, nunca
 * scrollIntoView: o palco 3D não se mexe).
 *
 * Quem monta (o MonitorChat do CodeMonitor) passa as mensagens do turno, o
 * cartão do código ao vivo (o tool-use que ainda vai chegar), já assinado por
 * ele, e os ganchos.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { TtsControls } from '../components/ChatRows'
import type { QuoteListApi } from '../components/quoteComment/quoteBlocks'
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
  /** Cabeçalho próprio no lugar do TurnHeader (o do Chat no Código). */
  header?: ReactNode
  /** Muda para ir ao fim (o "Abrir o chat" do Contexto). */
  endSignal?: number
  /** O TTS do App: "Ouvir" na resposta final (e "Ler daqui" nos blocos, com `quote`). */
  tts?: TtsControls | null
  /** "Comentar" nos blocos da resposta (só com o campo na tela). */
  quote?: QuoteListApi
}

export function ChatPanel({ head, seed, content, header, endSignal = 0, tts = null, quote }: ChatPanelProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  })
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || endSignal === 0) return
    atEnd.current = true
    el.scrollTop = el.scrollHeight
  }, [endSignal])
  const onScroll = (): void => {
    const el = bodyRef.current
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= END_SLACK_PX
  }

  return (
    <div className="o3d-chat-screen">
      {header === undefined ? <TurnHeader head={head} seed={seed} /> : header}
      <div className="message-list o3d-chat-screen-body" ref={bodyRef} onScroll={onScroll}>
        <TurnRows messages={content.messages} busy={head.busy} live={content.live} limit={SCREEN_MESSAGES} tts={tts} quote={quote} />
      </div>
    </div>
  )
}
