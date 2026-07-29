import { useEffect, useMemo, useState } from 'react'
import type { BackgroundTask, PermissionRequest, ProjectNode } from '@shared/ipc'
import type { AgentTrack, TrackMap } from '../agentTracks'
import { sortTracks } from '../agentTracks'
import type { Touch } from '../projectActivity'
import type { TodoItem } from '../types'
import { AgentFlow } from './AgentFlow'
import { ProjectGraph } from './ProjectGraph'
import {
  IconChevronDown,
  IconClock,
  IconCollapseRight,
  IconExpand,
  IconSparkStar,
  IconSpinner,
  IconUsers
} from './Icons'

/**
 * The supervisor view: who is working inside this conversation right now, what
 * each one is doing, and what is waiting on the user. Lives in the right-hand
 * panel (next to the browser) precisely so the chat feed stays clean.
 */

interface Props {
  /** Tracks of the ACTIVE conversation (main agent's subagents). */
  tracks: TrackMap
  /** Whether the main agent itself is running a turn. */
  busy: boolean
  /** How long the current turn has been running (epoch ms), if any. */
  busySince: number | null
  backgroundTasks: BackgroundTask[]
  /** Permission/question waiting for an answer, per conversation. */
  pendingPermissions: { convId: string; title: string; request: PermissionRequest }[]
  onFocusPermission: (convId: string) => void
  /** True while the app is still loading its data — shows the skeleton. */
  loading: boolean
  onClose: () => void
  /** Opens the flow FULL SCREEN (the panel already shows it inline). */
  onOpenFlow: () => void
  /** Active conversation's title — the root node of the flow. */
  conversationTitle: string
  /** Project tree of the active conversation's folder (the "Projeto" map). */
  projectEntries: ProjectNode[]
  /** True when the project scan hit its cap, so the map says it's partial. */
  projectTruncated: boolean
  /** Paths confirmed deleted from disk — the map plays their destruction. */
  projectMissing: string[]
  /** The agent's plan, shown as a strip above the map. */
  projectSteps: TodoItem[]
  /** Every tool call of the conversation, resolved onto the tree. */
  touches: Touch[]
  /** Project folder name — the root node of the map. */
  projectName: string
  width: number
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`
}

/** Ticks every second so every "há X" on screen stays honest. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** Short, readable summary of what a tool call is touching. */
function describeStep(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  const path = pick('file_path', 'path', 'notebook_path')
  if (path) return path.split(/[\\/]/).slice(-2).join('/')
  const detail = pick('command', 'pattern', 'query', 'url', 'description', 'prompt')
  if (!detail) return name
  const oneLine = detail.replace(/\s+/g, ' ')
  return oneLine.length > 64 ? `${oneLine.slice(0, 63)}…` : oneLine
}

function TrackRow({ track, now }: { track: AgentTrack; now: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = track.status === 'running'
  const elapsed = (track.endedAt ?? now) - track.startedAt
  const last = track.steps[track.steps.length - 1]

  return (
    <article className={`agent-track ${track.status}${open ? ' open' : ''}`}>
      <button type="button" className="agent-track-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="agent-track-mark" aria-hidden="true">
          {running ? <IconSpinner className="spinner" size={15} /> : <IconSparkStar size={15} />}
        </span>
        <span className="agent-track-body">
          <span className="agent-track-label">{track.label}</span>
          <span className="agent-track-sub">
            {running ? (
              last ? (
                <>
                  <span className="agent-track-tool">{last.name}</span>
                  <span className="agent-track-detail">{describeStep(last.name, last.input)}</span>
                </>
              ) : (
                // Já delegado, mas o subagente ainda não chamou nada: dizer
                // "concluído" aqui seria mentira (foi o que apareceu no 1º teste).
                <span className="agent-track-detail">iniciando…</span>
              )
            ) : (
              <span className="agent-track-detail">
                {track.status === 'error' ? 'terminou com erro' : 'concluído'}
              </span>
            )}
          </span>
        </span>
        <span className="agent-track-meta">
          <span className="agent-track-time">{fmtElapsed(elapsed)}</span>
          <span className="agent-track-steps">{track.stepCount} ações</span>
        </span>
        <IconChevronDown size={13} className="agent-track-caret" />
      </button>
      {running && <span className="agent-track-progress" aria-hidden="true" />}
      {open && (
        <ol className="agent-track-steps-list">
          {track.steps.length === 0 && <li className="agent-step empty">Ainda não executou nada.</li>}
          {track.steps.map((step) => (
            <li key={step.id} className={`agent-step${step.isError ? ' error' : ''}${step.endedAt ? '' : ' running'}`}>
              <span className="agent-step-name">{step.name}</span>
              <span className="agent-step-detail">{describeStep(step.name, step.input)}</span>
              {step.result && <span className="agent-step-result">{step.result.slice(0, 160)}</span>}
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

function Skeleton(): JSX.Element {
  return (
    <div className="agents-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="sk-track" key={i}>
          <div className="sk-dot sk" />
          <div className="sk-lines">
            <div className="sk sk-line lg" />
            <div className="sk sk-line sm" />
          </div>
          <div className="sk sk-pill" />
        </div>
      ))}
    </div>
  )
}

export function AgentsPanel({
  tracks,
  busy,
  busySince,
  backgroundTasks,
  pendingPermissions,
  onFocusPermission,
  loading,
  onClose,
  onOpenFlow,
  conversationTitle,
  projectEntries,
  projectTruncated,
  projectMissing,
  projectSteps,
  touches,
  projectName,
  width
}: Props): JSX.Element {
  const [view, setView] = useState<'list' | 'flow' | 'project'>('list')
  const list = useMemo(() => sortTracks(tracks), [tracks])
  const running = list.filter((t) => t.status === 'running')
  const finished = list.filter((t) => t.status !== 'running')
  // Only tick while something is actually moving.
  const now = useNow(busy || running.length > 0)

  return (
    <section className="agents-panel" style={{ flex: `0 0 ${width}px` }}>
      <header className="agents-head">
        <span className="agents-title">
          <IconUsers size={15} />
          Agentes
        </span>
        <span className="agents-counts">
          {/* Alterna a MESMA informação entre lista e mapa, aqui dentro do painel —
              o chat continua acessível (um overlay tomaria a tela inteira). */}
          <span className="agents-view-switch" role="group" aria-label="Modo de visualização">
            <button
              type="button"
              className={view === 'list' ? 'on' : ''}
              onClick={() => setView('list')}
              title="Ver como lista"
            >
              Lista
            </button>
            <button
              type="button"
              className={view === 'flow' ? 'on' : ''}
              onClick={() => setView('flow')}
              title="Ver como fluxo"
            >
              Fluxo
            </button>
            <button
              type="button"
              className={view === 'project' ? 'on' : ''}
              onClick={() => setView('project')}
              title="Ver o mapa do projeto"
            >
              Projeto
            </button>
          </span>
          {view === 'flow' && (
            <button type="button" className="agents-expand" onClick={onOpenFlow} title="Expandir o fluxo">
              <IconExpand size={14} />
            </button>
          )}
          {running.length > 0 && <span className="agents-chip live">{running.length} trabalhando</span>}
          {backgroundTasks.length > 0 && <span className="agents-chip">{backgroundTasks.length} em 2º plano</span>}
          {pendingPermissions.length > 0 && (
            <span className="agents-chip warn">{pendingPermissions.length} esperando você</span>
          )}
        </span>
        <button type="button" className="nav-btn" onClick={onClose} title="Fechar painel">
          <IconCollapseRight />
        </button>
      </header>

      <div className={`agents-body${view !== 'list' && !loading ? ' flow' : ''}`}>
        {loading ? (
          <Skeleton />
        ) : view === 'project' ? (
          <ProjectGraph
            entries={projectEntries}
            touches={touches}
            rootName={projectName}
            truncated={projectTruncated}
            missing={projectMissing}
            steps={projectSteps}
            embedded
          />
        ) : view === 'flow' ? (
          <AgentFlow
            tracks={tracks}
            busy={busy}
            busySince={busySince}
            title={conversationTitle}
            onClose={onClose}
            embedded
          />
        ) : (
          <>
            <section className="agents-section">
              <h3 className="agents-section-title">Agente principal</h3>
              <article className={`agent-track main ${busy ? 'running' : 'idle'}`}>
                <div className="agent-track-head static">
                  <span className="agent-track-mark" aria-hidden="true">
                    {busy ? <IconSpinner className="spinner" size={15} /> : <IconSparkStar size={15} />}
                  </span>
                  <span className="agent-track-body">
                    <span className="agent-track-label">{busy ? 'Trabalhando na sua tarefa' : 'Ocioso'}</span>
                    <span className="agent-track-sub">
                      <span className="agent-track-detail">
                        {busy
                          ? running.length > 0
                            ? `coordenando ${running.length} subagente${running.length > 1 ? 's' : ''}`
                            : 'executando sozinho'
                          : 'esperando seu próximo pedido'}
                      </span>
                    </span>
                  </span>
                  {busy && busySince != null && (
                    <span className="agent-track-meta">
                      <span className="agent-track-time">
                        <IconClock size={12} /> {fmtElapsed(now - busySince)}
                      </span>
                    </span>
                  )}
                </div>
                {busy && <span className="agent-track-progress" aria-hidden="true" />}
              </article>
            </section>

            {pendingPermissions.length > 0 && (
              <section className="agents-section">
                <h3 className="agents-section-title warn">Esperando você</h3>
                {pendingPermissions.map((p) => (
                  <button
                    key={p.convId}
                    type="button"
                    className="agent-pending"
                    onClick={() => onFocusPermission(p.convId)}
                  >
                    <span className="agent-pending-conv">{p.title}</span>
                    <span className="agent-pending-tool">{p.request.questions ? 'pergunta' : p.request.toolName}</span>
                  </button>
                ))}
              </section>
            )}

            <section className="agents-section">
              <h3 className="agents-section-title">
                Subagentes
                {running.length > 0 && <span className="agents-section-badge">{running.length}</span>}
              </h3>
              {list.length === 0 ? (
                <p className="agents-empty">
                  Nenhum subagente foi disparado nesta conversa ainda. Quando o agente delegar uma
                  tarefa, ela aparece aqui com o que está executando.
                </p>
              ) : (
                <div className="agents-tracks">
                  {running.map((t) => (
                    <TrackRow key={t.id} track={t} now={now} />
                  ))}
                  {finished.map((t) => (
                    <TrackRow key={t.id} track={t} now={now} />
                  ))}
                </div>
              )}
            </section>

            {backgroundTasks.length > 0 && (
              <section className="agents-section">
                <h3 className="agents-section-title">Em segundo plano</h3>
                <div className="agents-tracks">
                  {backgroundTasks.map((task) => (
                    <article className="agent-track bg" key={task.id} title={task.id}>
                      <div className="agent-track-head static">
                        <span className="agent-track-mark" aria-hidden="true">
                          <span className="agent-bg-pulse" />
                        </span>
                        <span className="agent-track-body">
                          <span className="agent-track-label">{task.description || task.id}</span>
                          <span className="agent-track-sub">
                            <span className="agent-track-tool">{task.type}</span>
                          </span>
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  )
}
