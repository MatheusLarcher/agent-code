import type { BackgroundTask, QueuedAfterInterrupt } from '@shared/ipc'

export function BackgroundTasksCard({ tasks }: { tasks: BackgroundTask[] }): JSX.Element | null {
  if (tasks.length === 0) return null
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
