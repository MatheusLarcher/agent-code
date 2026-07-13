import { useEffect, useState, type RefObject } from 'react'
import type { FileAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { contextLimitFor } from '@shared/ipc'
import type { TurnRecovery, UIMessage } from '../types'
import { MessageList, type TtsControls } from './MessageList'
import { Composer, type RefProject } from './Composer'
import { IconClock, IconClose, IconHelp, IconChevronDown } from './Icons'

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

function RecoveryCard({ recovery, onRetry, onCancel }: { recovery: TurnRecovery; onRetry: () => void; onCancel: () => void }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const stopped = recovery.scheduledAt <= 0
  const remaining = Math.max(0, recovery.scheduledAt - now)
  const when = stopped
    ? `Tentativas automáticas encerradas (${recovery.attempt}/${recovery.maxAttempts})`
    : `Nova tentativa em ${fmtDuration(remaining)} · ${new Date(recovery.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div className="recovery-card" role="status">
      <span className="recovery-clock"><IconClock size={15} /></span>
      <div className="recovery-copy">
        <strong>{recovery.reason === 'limit' ? 'Limite do Claude atingido' : 'Resposta interrompida'}</strong>
        <span>{when}</span>
      </div>
      <button type="button" className="recovery-action" onClick={onRetry}>Tentar agora</button>
      <button type="button" className="recovery-action subtle" onClick={onCancel}>Cancelar</button>
    </div>
  )
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
  /** Persist a conversation's composer draft — called with an explicit convId
   *  (blur / conversation switch / send), not on every keystroke. */
  onDraftChange: (convId: string, text: string) => void
  /** True when the active conversation's project folder no longer exists — the
   *  composer is blocked (read-only) and interacting shows the error. */
  projectMissing: boolean
  /** Error shown when the user interacts with the blocked composer. */
  projectMissingMsg: string
  /** Messages waiting to be sent (agent busy), shown above the composer. */
  queued: { id: string; text: string; thumbs: string[] }[]
  onDeleteQueued: (id: string) => void
  recovery?: TurnRecovery
  onRetryRecovery: () => void
  onCancelRecovery: () => void
  /** True when the agent asked a question (AskUserQuestion) and its modal was
   *  minimized (clicked outside / Esc) — shows a chip to reopen it. */
  pendingQuestion: boolean
  /** Reopens the minimized question modal (chip's onClick). */
  onReopenQuestion: () => void
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
  /** Model picker (mirrored above the composer). Locked only while the agent is
   *  BUSY (mid-turn) — the model is fixed for the life of a session, but an idle
   *  connected session is silently restarted on change so the model takes effect
   *  on the next message, without the user having to stop it by hand. */
  models: { id: string; label: string }[]
  model: string
  modelLocked: boolean
  onModelChange: (id: string) => void
  /** Called when the user clicks the model picker while it's locked (agent busy),
   *  so App can show a "wait for the current task to finish" hint. */
  onModelLockedClick: () => void
  /** Reasoning effort selector — shown beside the model picker. */
  effortLevels: { value: string; label: string }[]
  effort: string
  effortLocked: boolean
  onEffortChange: (level: string) => void
  /** Modo econômico toggle — shown beside the model/effort pickers. */
  economyMode: boolean
  onEconomyModeChange: (on: boolean) => void
}

/** Custom popover replacing the plain <select> for reasoning effort: a button
 *  showing "Esforço <label>" that opens a small panel with a slider between
 *  "Mais rápido" and "Mais inteligente" (dots = available levels). */
function EffortPicker(props: {
  levels: { value: string; label: string }[]
  value: string
  locked: boolean
  onChange: (level: string) => void
  onLockedClick?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const idx = Math.max(
    0,
    props.levels.findIndex((l) => l.value === props.value)
  )
  const current = props.levels[idx] ?? props.levels[0]

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.effort-picker')) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="effort-picker">
      <button
        type="button"
        className={`effort-trigger${props.locked ? ' locked' : ''}`}
        aria-expanded={open}
        title={
          props.locked
            ? 'Espere o Claude terminar a tarefa atual para trocar o esforço.'
            : 'Esforço de raciocínio — quanto maior, mais profundo (e mais lento/caro)'
        }
        onClick={() => {
          if (props.locked) {
            props.onLockedClick?.()
            return
          }
          setOpen((v) => !v)
        }}
      >
        <span>{current?.label ?? ''}</span>
        <IconChevronDown size={12} className="effort-trigger-chevron" />
      </button>
      {open && (
        <div className="effort-popover">
          <div className="effort-popover-head">
            <span>
              Esforço <strong>{current?.label ?? ''}</strong>
            </span>
            <span className="effort-help" title="Controla o quanto o modelo 'pensa' antes de responder: mais esforço tende a ser mais preciso, porém mais lento e mais caro.">
              <IconHelp size={14} />
            </span>
          </div>
          <div className="effort-slider-labels">
            <span>Mais rápido</span>
            <span>Mais inteligente</span>
          </div>
          <input
            type="range"
            className="effort-slider"
            min={0}
            max={Math.max(0, props.levels.length - 1)}
            step={1}
            value={idx}
            onChange={(e) => props.onChange(props.levels[Number(e.target.value)].value)}
          />
        </div>
      )}
    </div>
  )
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
          <span
            className="tok cost"
            title={
              `Custo ESTIMADO com base no preço da API avulsa (pay-as-you-go) — NÃO é uma cobrança real. ` +
              `Como você usa um plano de assinatura, esse uso já está incluído; o valor aqui é só uma referência ` +
              `de quanto custaria se você usasse a API direto, sem plano. ` +
              `Acumulado: $${tokens.cost.toFixed(6)}`
            }
          >
            ~${tokens.cost.toFixed(2)}
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

      {props.recovery && (
        <RecoveryCard recovery={props.recovery} onRetry={props.onRetryRecovery} onCancel={props.onCancelRecovery} />
      )}

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

      {props.pendingQuestion && (
        <button type="button" className="pending-question-chip" onClick={props.onReopenQuestion}>
          <IconHelp size={15} />
          <span>O agente fez uma pergunta — toque para responder</span>
        </button>
      )}

      <div className="composer-bar">
        <select
          className={`model-select${props.modelLocked ? ' locked' : ''}`}
          value={props.model}
          aria-disabled={props.modelLocked}
          title={
            props.modelLocked
              ? 'Espere o Claude terminar a tarefa atual para trocar o modelo.'
              : 'Modelo usado nesta conversa'
          }
          // Locked only while busy: keep it clickable (so we can explain why)
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
        {props.effortLevels.length > 0 && (
          <EffortPicker
            levels={props.effortLevels}
            value={props.effort}
            locked={props.effortLocked}
            onChange={props.onEffortChange}
          />
        )}
        <button
          type="button"
          className={`economy-toggle${props.economyMode ? ' on' : ''}`}
          title={
            props.economyMode
              ? 'Modo econômico ATIVO — tarefas simples pulam validação para economizar tokens. Clique para desativar.'
              : 'Modo econômico — quando ativo, tarefas simples (typo, CSS, texto) pulam typecheck/build/test para economizar tokens.'
          }
          onClick={() => props.onEconomyModeChange(!props.economyMode)}
        >
          <span className="economy-icon">{props.economyMode ? '⚡' : '💰'}</span>
          <span className="economy-label">Econômico</span>
        </button>
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
