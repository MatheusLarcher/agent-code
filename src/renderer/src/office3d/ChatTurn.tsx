/**
 * O turno de um agente com os componentes REAIS do chat (ChatRow: balão do
 * usuário, Markdown do assistente, ToolCard que expande ao clicar) — a base da
 * tela focada (ChatScreen) e da prévia do hover (ChatPreview). Sem `tts` e
 * `quote` é só leitura (a prévia); a tela do monitor passa os dois: "Ouvir",
 * "Ler daqui" e "Comentar", como na aba Conversa. `TurnHeader` é o cabeçalho
 * das duas: o ponto na cor da camisa do agente, o título da conversa, quem é e
 * o estado.
 */
import type { CSSProperties, ReactNode } from 'react'
import { AUTO_MODEL } from '@shared/ipc'
import { modelDisplayName } from '@shared/modelLabel'
import { ChatRow, lastAnswerTsId, rowKey, type ChatRowContext, type TtsControls } from '../components/ChatRows'
import { useChatDisplay } from '../components/chatDisplay'
import type { QuoteListApi } from '../components/quoteComment/quoteBlocks'
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
  /** O TTS do App: "Ouvir" na resposta final (e o "Ler daqui" dos blocos, com `quote`). */
  tts?: TtsControls | null
  /** "Comentar" nos blocos da resposta (o trecho vai para o campo de quem monta). */
  quote?: QuoteListApi
}

export function TurnRows({ messages, busy, live = null, limit = 0, tts = null, quote }: TurnRowsProps): JSX.Element {
  const { planDir } = useChatDisplay()
  const start = limit > 0 ? Math.max(0, messages.length - limit) : 0
  const ctx: ChatRowContext = { resolveRef: null, planDir, lastTsId: lastAnswerTsId(messages), tts, quote }
  return (
    <>
      {start > 0 && <div className="load-more-hint">↑ {start === 1 ? '1 anterior' : `${start} anteriores`} neste turno</div>}
      {messages.slice(start).map((m, i) =>
        m.kind === 'provider-switch' && m.fromModel !== AUTO_MODEL ? (
          <ModelSwitchNote key={rowKey(m, start + i)} from={m.fromModel} to={m.model} why={m.text} />
        ) : (
          <ChatRow key={rowKey(m, start + i)} m={m} ctx={ctx} />
        )
      )}
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

/**
 * A troca de modelo no meio da tarefa (troca automática por cota), no ponto em
 * que aconteceu: "Trocou de modelo: Opus 5.5 → GPT-6.1 Sol" e o motivo. O
 * anúncio do Automático (fromModel = sentinela) continua a nota de sempre.
 */
function ModelSwitchNote({ from, to, why }: { from: string; to: string; why: string }): JSX.Element {
  return (
    <div className="msg o3d-model-switch" role="status">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 3.5c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7zM19 15.5v5M16.5 18h5" />
      </svg>
      <span>
        Trocou de modelo: <b>{modelDisplayName(from) || from}</b> → <b>{modelDisplayName(to) || to}</b>
        <small>{why}</small>
      </span>
    </div>
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
