/**
 * O turno de um agente com os componentes REAIS do chat (ChatRow: balão do
 * usuário, Markdown do assistente, ToolCard que expande ao clicar), em modo só
 * leitura — a base da tela focada (ChatScreen) e da prévia do hover
 * (ChatPreview). `TurnHeader` é o cabeçalho das duas: o ponto na cor da camisa
 * do agente, o título da conversa, quem é e o estado.
 */
import type { CSSProperties, ReactNode } from 'react'
import { ChatRow, lastAnswerTsId, rowKey, type ChatRowContext } from '../components/ChatRows'
import { useChatDisplay } from '../components/chatDisplay'
import { ToolCard } from '../components/ToolCard'
import type { UIMessage } from '../types'
import { seedCss } from './appearance'
import type { ToolUseMessage, TurnHead } from './chatPage'

export interface TurnRowsProps {
  messages: readonly UIMessage[]
  /** Trabalhando: o "digitando" do chat no fim. */
  busy: boolean
  /** O código ao vivo (o cartão que ainda vai chegar), no fim. */
  live?: ToolUseMessage | null
  /** Só as últimas `limit` mensagens (0 = todas), com o aviso das de cima. */
  limit?: number
}

export function TurnRows({ messages, busy, live = null, limit = 0 }: TurnRowsProps): JSX.Element {
  const { planDir } = useChatDisplay()
  const start = limit > 0 ? Math.max(0, messages.length - limit) : 0
  const ctx: ChatRowContext = { resolveRef: null, planDir, lastTsId: lastAnswerTsId(messages) }
  return (
    <>
      {start > 0 && <div className="load-more-hint">↑ {start === 1 ? '1 anterior' : `${start} anteriores`} neste turno</div>}
      {messages.slice(start).map((m, i) => (
        <ChatRow key={rowKey(m, start + i)} m={m} ctx={ctx} />
      ))}
      {live && <ToolCard m={live} />}
      {busy && !live && (
        <div className="msg assistant">
          <div className="bubble typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
      {messages.length === 0 && !live && !busy && <div className="msg system-note">Nada neste turno ainda.</div>}
    </>
  )
}

export function TurnHeader({ head, seed, children }: { head: TurnHead; seed: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="o3d-turn-head" style={{ '--o3d-agent': seedCss(seed) } as CSSProperties}>
      <span className="o3d-chat-dot" aria-hidden="true" />
      <span className="o3d-turn-title" title={head.title}>
        {head.title || 'Conversa'}
      </span>
      {head.who && <span className="o3d-chat-project">{head.who}</span>}
      <span className={`tool-badge ${head.busy ? 'run' : 'ok'}`}>{head.busy ? 'trabalhando…' : 'parado'}</span>
      {children}
    </div>
  )
}
