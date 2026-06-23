import { useEffect, useState, type RefObject } from 'react'
import type { ImageAttachment, PickedElement } from '@shared/ipc'
import type { UIMessage } from '../types'
import { MessageList } from './MessageList'
import { Composer, type RefProject } from './Composer'
import { IconClock, IconClose } from './Icons'

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Live elapsed time of the running task; when idle, the last task's duration. */
function RunTimer({ since, lastMs }: { since: number | null; lastMs: number | null }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])

  if (since != null) {
    return (
      <span className="tok time running" title="Tempo da tarefa em execução">
        ⏱ {fmtDuration(Math.max(0, now - since))}
      </span>
    )
  }
  if (lastMs != null) {
    return (
      <span className="tok time" title="Duração da última tarefa">
        ⏱ {fmtDuration(lastMs)}
      </span>
    )
  }
  return null
}

interface Props {
  messages: UIMessage[]
  /** Whether a conversation is selected (composer enabled). */
  hasActive: boolean
  busy: boolean
  tokens: { context: number; output: number; cost: number }
  chips: PickedElement[]
  onRemoveChip: (i: number) => void
  onSend: (text: string, images: ImageAttachment[]) => void
  onInterrupt: () => void
  composerRef: RefObject<HTMLTextAreaElement | null>
  /** Projects from history, offered in the composer's @ reference menu. */
  projects: RefProject[]
  /** Active conversation id — resets the message window when it changes. */
  convId: string | null
  /** Messages waiting to be sent (agent busy), shown above the composer. */
  queued: { id: string; text: string; thumbs: string[] }[]
  onDeleteQueued: (id: string) => void
  /** When the active conversation's task started (ms epoch), or null if idle. */
  runningSince: number | null
  /** Duration (ms) of the last finished task, shown when idle. */
  lastDurationMs: number | null
}

const fmt = (n: number): string => {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}t` // trilhão
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b` // bilhão
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m` // milhão
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k` // mil
  return String(n)
}

export function ChatPanel(props: Props): JSX.Element {
  const { messages, hasActive, busy, tokens } = props
  return (
    <section className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <div className="token-meter" title="Tempo da tarefa e uso de tokens">
          <RunTimer since={props.runningSince} lastMs={props.lastDurationMs} />
          <span
            className="tok ctx"
            title={`Tokens de contexto na última resposta: ${tokens.context.toLocaleString('pt-BR')}`}
          >
            ⬚ {fmt(tokens.context)} ctx
          </span>
          <span
            className="tok out"
            title={`Tokens de saída acumulados: ${tokens.output.toLocaleString('pt-BR')}`}
          >
            ↓ {fmt(tokens.output)} out
          </span>
          <span className="tok cost" title={`Custo estimado acumulado: $${tokens.cost.toFixed(6)}`}>
            ${tokens.cost.toFixed(2)}
          </span>
        </div>
      </div>

      {busy && (
        <div className="working-banner" role="status" aria-live="polite">
          <span className="working-ring" />
          <span className="working-text">
            Claude está trabalhando<span className="working-dots" />
          </span>
        </div>
      )}

      {messages.length === 0 && (
        <div className="empty-state">
          <div className="empty-logo">✦</div>
          <h2>Claude Code</h2>
          <p>
            {hasActive
              ? 'Peça ao Claude para construir, editar ou pesquisar. Ele abre o navegador embutido à direita quando precisar.'
              : 'Crie uma conversa na barra à esquerda para começar.'}
          </p>
        </div>
      )}

      <MessageList key={props.convId ?? 'none'} messages={messages} busy={busy} />

      {props.queued.length > 0 && (
        <div className="queue">
          <div className="queue-label"><IconClock size={13} /> Na fila ({props.queued.length}) — enviadas quando a tarefa atual terminar</div>
          {props.queued.map((q) => (
            <div className="queue-item" key={q.id}>
              {q.thumbs.length > 0 && (
                <span className="queue-thumbs">
                  {q.thumbs.map((t, i) => (
                    <img key={i} src={t} alt="anexo" />
                  ))}
                </span>
              )}
              <span className="queue-text">{q.text.trim() || '(imagem)'}</span>
              <button className="queue-x" onClick={() => props.onDeleteQueued(q.id)} title="Remover da fila">
                <IconClose size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Composer
        disabled={!hasActive}
        busy={busy}
        chips={props.chips}
        onRemoveChip={props.onRemoveChip}
        onSend={props.onSend}
        onInterrupt={props.onInterrupt}
        textareaRef={props.composerRef}
        projects={props.projects}
      />
    </section>
  )
}
