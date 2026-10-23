/**
 * As faixas do trabalho paralelo da conversa aberta, acima do composer:
 * - os subagentes rodando — o papel, o resumo ao vivo do SDK
 *   (`agentProgressSummaries`) e há quanto tempo;
 * - as tarefas em segundo plano, cada uma com o próprio parar (o turno segue).
 * Vêm no estado publicado pelo PC (`conv.subagents`, `conv.backgroundTasks`),
 * então reconectar não perde nada; cada faixa some quando fica vazia.
 */
import { useState } from 'react'
import { client, toast } from '../app/runtime'
import { fmtElapsed } from '../core/format'
import type { ConvSummary } from '../core/types'
import { Icon } from '../ui/icons'
import { useTick } from './ChatBars'

export function SubagentStrip({ conv }: { conv: ConvSummary }): JSX.Element | null {
  const list = conv.subagents ?? []
  const now = useTick(list.length > 0)
  if (list.length === 0) return null
  return (
    <div className="subagent-strip">
      {list.map((s) => (
        <div key={s.id} className="subagent-row">
          <span className="subagent-dot" aria-hidden="true" />
          <span className="subagent-text">
            <b>{s.label}</b>
            {s.summary ? ` · ${s.summary}` : null}
          </span>
          <span className="subagent-t">{fmtElapsed(s.startedAt, now)}</span>
        </div>
      ))}
    </div>
  )
}

const STOP_FAILED = 'Não consegui parar a tarefa em segundo plano.'

/** As tarefas de fundo com o parar de cada uma; a linha some quando o PC publica a lista nova. */
export function BackgroundTasksCard({ conv }: { conv: ConvSummary }): JSX.Element | null {
  const tasks = conv.backgroundTasks ?? []
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  if (tasks.length === 0) return null
  const stop = (taskId: string): void => {
    if (stopping.has(taskId)) return
    setStopping((prev) => new Set(prev).add(taskId))
    client
      .stopTask(taskId)
      .then((ok) => {
        if (!ok) toast(STOP_FAILED, 'erro')
      })
      .catch(() => toast(STOP_FAILED, 'erro'))
      .finally(() =>
        setStopping((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      )
  }
  return (
    <div className="bg-tasks">
      <div className="bg-tasks-title">Tarefas em segundo plano ({tasks.length})</div>
      {tasks.map((task) => (
        <div key={task.id} className="bg-task-row">
          <span className="bg-task-type">{task.type}</span>
          <span className="bg-task-desc">{task.description || task.id}</span>
          <button
            type="button"
            className="bg-task-stop"
            data-tip="Parar esta tarefa"
            aria-label={`Parar a tarefa ${task.description || task.id}`}
            disabled={stopping.has(task.id)}
            onClick={() => stop(task.id)}
          >
            <Icon name="stop" size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
