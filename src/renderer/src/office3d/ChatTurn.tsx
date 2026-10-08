/**
 * O turno de um agente com os componentes REAIS do chat (ChatRow: balão do
 * usuário, Markdown do assistente; ChatStepRow: cada resposta com a sua
 * linha-resumo, que abre os ToolCard dela ao clicar) — a base da
 * tela focada (ChatScreen) e da prévia do hover (ChatPreview). Sem `tts` e
 * `quote` é só leitura (a prévia); a tela do monitor passa os dois: "Ouvir",
 * "Ler daqui" e "Comentar", como na aba Conversa. `TurnHeader` é o cabeçalho
 * das duas: o ponto na cor da camisa do agente, o título da conversa, quem é e
 * o estado.
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { AUTO_MODEL } from '@shared/ipc'
import { modelDisplayName } from '@shared/modelLabel'
import { ChatRow, lastAnswerTsId, type ChatRowContext, type TtsControls } from '../components/ChatRows'
import { AnimGateProvider, useAnimGate } from '../chatAnim'
import { ChatLive } from '../components/ChatLive'
import { ChatStepRow } from '../components/ChatStep'
import { buildChatRows } from '../components/chatSteps'
import { useChatDisplay } from '../components/chatDisplay'
import type { QuoteListApi } from '../components/quoteComment/quoteBlocks'
import { ToolCard } from '../components/ToolCard'
import type { UIMessage } from '../types'
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
  // O mesmo chat resumido da conversa (chatSteps): cada resposta com a sua linha-resumo; o limite conta linhas.
  const rows = useMemo(() => buildChatRows(messages, { busy }), [messages, busy])
  const start = limit > 0 ? Math.max(0, rows.length - limit) : 0
  const lastTsId = lastAnswerTsId(messages)
  // A linha ao vivo só aparece sem o código ao vivo (abaixo); com ela, o passo em andamento não repete o status.
  const liveLine = busy && !live
  const ctx = useMemo<ChatRowContext>(() => ({ resolveRef: null, planDir, lastTsId, tts, quote, liveLine }), [planDir, lastTsId, tts, quote, liveLine])
  // Só o que chega ao vivo anima (chatAnim); abrir a tela com o turno pronto não anima nada.
  const animGate = useAnimGate(messages)
  return (
    <AnimGateProvider gate={animGate}>
      {start > 0 && <div className="load-more-hint">↑ {start === 1 ? '1 anterior' : `${start} anteriores`} neste turno</div>}
      {rows.slice(start).map((r) => {
        if (r.type === 'step') return <ChatStepRow key={r.key} step={r} ctx={ctx} />
        const m = r.msg
        return m.kind === 'provider-switch' && m.fromModel !== AUTO_MODEL ? (
          <ModelSwitchNote key={r.key} from={m.fromModel} to={m.model} why={m.text} />
        ) : (
          <ChatRow key={r.key} m={m} ctx={ctx} />
        )
      })}
      {live && <ToolCard m={live} />}
      {/* A mesma linha "ao vivo" do chat (ponto pulsando, o que faz agora e o tempo). */}
      {liveLine && <ChatLive messages={messages} />}
      {messages.length === 0 && !live && !busy && <div className="msg system-note">Nada neste turno ainda.</div>}
    </AnimGateProvider>
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

/** `color`: a cor (CSS) do agente — a do projeto (projectColor.ts `agentCss`), a mesma da camisa. */
export function TurnHeader({ head, color, children }: { head: TurnHead; color: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="o3d-turn-head" style={{ '--o3d-agent': color } as CSSProperties}>
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
