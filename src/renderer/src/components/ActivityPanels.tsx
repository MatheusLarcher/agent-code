import { useState } from 'react'
import type { BackgroundTask, QueuedAfterInterrupt } from '@shared/ipc'
import { IconStopSmall } from './Icons'
import './activityPanels.css'

/**
 * As tarefas em segundo plano da conversa. Com `onStop`, cada linha ganha o
 * botão de parar SÓ aquela tarefa (o turno e as outras seguem); a linha some
 * quando o SDK manda a lista nova — até lá o botão fica esperando.
 */
export function BackgroundTasksCard({
  tasks,
  onStop
}: {
  tasks: BackgroundTask[]
  onStop?: (taskId: string) => Promise<unknown> | void
}): JSX.Element | null {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  if (tasks.length === 0) return null
  const stop = (taskId: string): void => {
    if (!onStop || stopping.has(taskId)) return
    setStopping((prev) => new Set(prev).add(taskId))
    void Promise.resolve(onStop(taskId)).finally(() =>
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    )
  }
  return (
    <section className="background-tasks-card" aria-label="Tarefas em segundo plano">
      <div className="background-tasks-title">
        <span className="background-task-pulse" />
        Tarefas em segundo plano ({tasks.length})
      </div>
      {tasks.map((task) => (
        <div className="background-task-row" key={task.id} title={task.id}>
          <span className="background-task-type">{task.type}</span>
          <span className="background-task-description">{task.description || task.id}</span>
          {onStop && (
            <button
              type="button"
              className="background-task-stop"
              data-tip="Parar esta tarefa"
              aria-label={`Parar a tarefa ${task.description || task.id}`}
              disabled={stopping.has(task.id)}
              onClick={() => stop(task.id)}
            >
              <IconStopSmall size={12} />
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

export function InterruptQueueWarning({
  messages
}: {
  messages: QueuedAfterInterrupt[]
}): JSX.Element | null {
  if (messages.length === 0) return null
  return (
    <section className="interrupt-queue-warning" role="status">
      <strong>O Stop não cancelou tudo.</strong>
      <span>Estas mensagens ainda serão processadas:</span>
      <ul>
        {messages.map((message) => (
          <li key={message.messageId}>{message.text?.trim() || `Mensagem interna ${message.messageId}`}</li>
        ))}
      </ul>
    </section>
  )
}
