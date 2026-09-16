import { useMemo, useState } from 'react'
import type { BackgroundTask, PermissionRequest, ProjectNode } from '@shared/ipc'
import type { TrackMap } from '../agentTracks'
import { sortTracks } from '../agentTracks'
import type { CrewMember } from '../crew'
import type { Touch, Turn } from '../projectActivity'
import type { TodoItem } from '../types'
import { AgentCrew } from './AgentCrew'
import { ProjectGraph } from './ProjectGraph'
import { IconCollapseRight, IconUsers } from './Icons'

/**
 * The supervisor view: who is working inside this conversation right now, what
 * each one is doing, and what is waiting on the user. Lives in the right-hand
 * panel (next to the browser) precisely so the chat feed stays clean.
 *
 * A visão principal é o ELENCO (`AgentCrew`): um cartão por papel, sempre
 * presente. A lista de trilhas que existia aqui mostrava eventos — e uma lista
 * que só cresce não tem transição para o usuário notar quando alguém começa.
 */

interface Props {
  /** Tracks of the ACTIVE conversation (main agent's subagents). */
  tracks: TrackMap
  /** O elenco já montado pelo App (papéis + observadores). */
  crew: CrewMember[]
  backgroundTasks: BackgroundTask[]
  /** Permission/question waiting for an answer, per conversation. */
  pendingPermissions: { convId: string; title: string; request: PermissionRequest }[]
  onFocusPermission: (convId: string) => void
  /** True while the app is still loading its data — shows the skeleton. */
  loading: boolean
  onClose: () => void
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
  /** The user's messages that produced work — the map filters by one of them. */
  turns: Turn[]
  /** Project folder name — the root node of the map. */
  projectName: string
  /** Leva para a aba Quadro — o lugar para onde as tarefas se mudaram. */
  onOpenBoard: () => void
  /** Fixed width when the panel sits directly in the workspace row. Omit when a
   *  parent (`.right-pane`) already sizes it. */
  width?: number
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
  crew,
  backgroundTasks,
  pendingPermissions,
  onFocusPermission,
  loading,
  onClose,
  projectEntries,
  projectTruncated,
  projectMissing,
  projectSteps,
  touches,
  turns,
  projectName,
  onOpenBoard,
  width
}: Props): JSX.Element {
  const [view, setView] = useState<'crew' | 'tasks' | 'project'>('crew')
  const list = useMemo(() => sortTracks(tracks), [tracks])
  const running = list.filter((t) => t.status === 'running')
  const working = crew.filter((m) => m.state === 'working')

  return (
    <section className="agents-panel" style={width !== undefined ? { flex: `0 0 ${width}px` } : undefined}>
      <header className="agents-head">
        <span className="agents-title">
          <IconUsers size={15} />
          Agentes
        </span>
        <span className="agents-counts">
          {/* Alterna a MESMA informação entre elenco e mapa, aqui dentro do painel —
              o chat continua acessível (um overlay tomaria a tela inteira). */}
          <span className="agents-view-switch" role="group" aria-label="Modo de visualização">
            <button
              type="button"
              className={view === 'crew' ? 'on' : ''}
              onClick={() => setView('crew')}
              title="Ver a equipe"
            >
              Equipe
            </button>
            <button
              type="button"
              className={view === 'tasks' ? 'on' : ''}
              onClick={() => setView('tasks')}
              title="Ver a fila do registro de tarefas"
            >
              Tarefas
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
          {working.length > 0 && <span className="agents-chip live">{working.length} trabalhando</span>}
          {backgroundTasks.length > 0 && <span className="agents-chip">{backgroundTasks.length} em 2º plano</span>}
          {pendingPermissions.length > 0 && (
            <span className="agents-chip warn">{pendingPermissions.length} esperando você</span>
          )}
        </span>
        <button type="button" className="nav-btn" onClick={onClose} title="Fechar painel">
          <IconCollapseRight />
        </button>
      </header>

      {/* As tarefas saíram daqui para a aba Quadro (painel próprio, por projeto).
          O lugar antigo virou o atalho — tirar o botão sem deixar rastro faria
          quem já usava a visão concluir que o recurso sumiu. */}
      {view === 'tasks' && !loading ? (
        <div className="agents-body flow">
          <div className="board-shortcut">
            <p className="board-shortcut-title">As tarefas agora vivem no Quadro</p>
            <p className="board-shortcut-sub">
              Quadro por projeto, atualizado sozinho enquanto o agente trabalha.
            </p>
            <button type="button" className="board-shortcut-btn" onClick={onOpenBoard}>
              Abrir o Quadro →
            </button>
          </div>
        </div>
      ) : (
        <div className={`agents-body${view !== 'crew' && !loading ? ' flow' : ''}`}>
          {loading ? (
            <Skeleton />
          ) : view === 'project' ? (
            <ProjectGraph
              entries={projectEntries}
              touches={touches}
              turns={turns}
              rootName={projectName}
              truncated={projectTruncated}
              missing={projectMissing}
              steps={projectSteps}
              embedded
            />
          ) : (
            <>
              <AgentCrew crew={crew} />

              {/* Fora do elenco de propósito: não são papéis, são pendências.
                  Só aparecem quando existem. */}
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
                      <span className="agent-pending-tool">
                        {p.request.questions ? 'pergunta' : p.request.toolName}
                      </span>
                    </button>
                  ))}
                </section>
              )}

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

              {running.length === 0 && list.length === 0 && (
                <p className="agents-hint">
                  Cada papel fica aqui mesmo parado. Quando o agente delegar, o cartão acende.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
