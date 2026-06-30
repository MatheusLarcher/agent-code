import { useEffect, useState, type RefObject } from 'react'
import type { FileAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { contextLimitFor } from '@shared/ipc'
import type { UIMessage } from '../types'
import { MessageList, type TtsControls } from './MessageList'
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
  onSend: (text: string, images: ImageAttachment[], files: FileAttachment[]) => void
  onInterrupt: () => void
  /** Resend a user message whose turn failed (its bubble shows a retry button). */
  onRetry: (msgId: string) => void
  composerRef: RefObject<HTMLTextAreaElement | null>
  /** Projects from history, offered in the composer's @ reference menu. */
  projects: RefProject[]
  /** Active conversation's project root — searched by the "@" autocomplete. */
  projectRoot: string | null
  /** Active conversation id — resets the message window when it changes. */
  convId: string | null
  /** Id of a message to scroll to (from a search hit), or null. */
  scrollToId?: string | null
  /** Bumped on each search-hit navigation so repeats re-trigger the scroll. */
  scrollSeq?: number
  /** Saved draft for the active conversation (restored into the composer). */
  draft: string
  /** Persist the composer draft for the active conversation as it's typed. */
  onDraftChange: (text: string) => void
  /** True when the active conversation's project folder no longer exists — the
   *  composer is blocked (read-only) and interacting shows the error. */
  projectMissing: boolean
  /** Error shown when the user interacts with the blocked composer. */
  projectMissingMsg: string
  /** Messages waiting to be sent (agent busy), shown above the composer. */
  queued: { id: string; text: string; thumbs: string[] }[]
  onDeleteQueued: (id: string) => void
  /** When the active conversation's task started (ms epoch), or null if idle. */
  runningSince: number | null
  /** Duration (ms) of the last finished task, shown when idle. */
  lastDurationMs: number | null
  /** First-run "Conectar": pick a folder, open the first chat and connect. */
  onStart?: () => void
  /** Whether an OpenAI key is set (enables mic + read-aloud). */
  voiceReady: boolean
  /** Open Settings on the OpenAI key when voice is used without a key. */
  onNeedVoiceKey: () => void
  /** Read-aloud state/handler (TTS lives in App). */
  tts: TtsControls
  /** Model picker (mirrored above the composer). Locked while connected — the
   *  model is fixed when the session starts; stop the session to change it. */
  models: { id: string; label: string }[]
  model: string
  modelLocked: boolean
  onModelChange: (id: string) => void
  /** Called when the user clicks the model picker while it's locked (in session),
   *  so App can show a "stop the session to change the model" hint. */
  onModelLockedClick: () => void
}

const fmt = (n: number): string => {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}t` // trilhão
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b` // bilhão
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m` // milhão
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k` // mil
  return String(n)
}

/** The model's context limit, formatted compactly (1_000_000 → "1M", 200_000 → "200K"). */
const fmtLimit = (n: number): string => {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** Context-window usage bar: how much of the model's input window the last
 *  request filled. `context` is the real input size (input + cache tokens) of
 *  the last model request; the denominator is the model's own context limit. */
function ContextBar({ context, model }: { context: number; model: string }): JSX.Element {
  const limit = contextLimitFor(model)
  const pct = Math.min(100, limit > 0 ? (context / limit) * 100 : 0)
  const level = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : 'ok'
  return (
    <div
      className={`ctx-bar ${level}`}
      title={
        `Contexto de entrada — o que está sendo enviado ao modelo (a janela que ele recebe): ` +
        `${context.toLocaleString('pt-BR')} de ${limit.toLocaleString('pt-BR')} tokens (${pct.toFixed(1)}%)`
      }
    >
      <span className="ctx-bar-cap">entrada</span>
      <span className="ctx-bar-track">
        <span className="ctx-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="ctx-bar-val">
        {fmt(context)} / {fmtLimit(limit)}
      </span>
    </div>
  )
}

export function ChatPanel(props: Props): JSX.Element {
  const { messages, hasActive, busy, tokens } = props
  return (
    <section className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <div className="token-meter" title="Tempo da tarefa, uso de contexto e custo">
          <RunTimer since={props.runningSince} lastMs={props.lastDurationMs} />
          <ContextBar context={tokens.context} model={props.model} />
          <span
            className="tok out"
            title={
              `Contexto de saída — total de tokens que o modelo gerou nesta conversa ` +
              `(acumulado, não é a janela de contexto): ${tokens.output.toLocaleString('pt-BR')}`
            }
          >
            ↑ {fmt(tokens.output)} saída
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
              : 'Conecte na sua conta do Claude Code para começar. Você escolhe a pasta do projeto e o app cria a primeira conversa.'}
          </p>
          {!hasActive && props.onStart && (
            <button className="btn primary empty-connect" onClick={props.onStart}>
              Conectar
            </button>
          )}
        </div>
      )}

      <MessageList
        key={props.convId ?? 'none'}
        messages={messages}
        scrollToId={props.scrollToId}
        scrollSeq={props.scrollSeq}
        busy={busy}
        tts={props.tts}
        onRetry={props.onRetry}
      />

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

      <div className="composer-bar">
        <select
          className={`model-select${props.modelLocked ? ' locked' : ''}`}
          value={props.model}
          aria-disabled={props.modelLocked}
          title={
            props.modelLocked
              ? 'Para trocar o modelo, pare a sessão (botão no topo).'
              : 'Modelo usado nesta conversa'
          }
          // Locked while connected: keep it clickable (so we can explain why)
          // but block the dropdown from opening and show a hint instead.
          onMouseDown={(e) => {
            if (props.modelLocked) {
              e.preventDefault()
              e.currentTarget.blur()
              props.onModelLockedClick()
            }
          }}
          onKeyDown={(e) => {
            if (props.modelLocked) {
              e.preventDefault()
              props.onModelLockedClick()
            }
          }}
          onChange={(e) => {
            if (!props.modelLocked) props.onModelChange(e.target.value)
          }}
        >
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <Composer
        disabled={!hasActive}
        busy={busy}
        chips={props.chips}
        onRemoveChip={props.onRemoveChip}
        onSend={props.onSend}
        onInterrupt={props.onInterrupt}
        textareaRef={props.composerRef}
        projects={props.projects}
        voiceReady={props.voiceReady}
        onNeedVoiceKey={props.onNeedVoiceKey}
        convId={props.convId}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        projectMissing={props.projectMissing}
        projectMissingMsg={props.projectMissingMsg}
        projectRoot={props.projectRoot}
      />
    </section>
  )
}
