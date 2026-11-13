/**
 * O Stop do usuário para TUDO da conversa, não só o turno principal.
 *
 * Duas coisas faziam o trabalho seguir depois do Stop:
 * - a fila durável de entrada (agent_input_queue): o Stop termina o turno com
 *   `result` de erro (`error_during_execution`) e a fila tratava isso como falha
 *   — devolvia a mensagem para `pending` e a reenviava. O agente recomeçava a
 *   tarefa e chamava o próximo subagente. A mensagem parada agora sai da fila.
 * - subagentes e tarefas de fundo: o `interrupt()` do CLI já os encerra, mas o
 *   Stop também os pede ao `stopTask`, um por um, por segurança.
 */
export class UserStopFence {
  /** Tarefas do ciclo `task_*` (subagentes, foreground ou não) ainda rodando. */
  private readonly tasks = new Set<string>()
  /** O último snapshot do `background_tasks_changed`. */
  private background = new Set<string>()
  /** Item da fila durável que o usuário parou: não volta para a fila. */
  private canceledInput: number | null = null

  /** Ciclo de uma tarefa (o fim dela tira da lista). */
  noteTask(taskId: string, running: boolean): void {
    if (running) this.tasks.add(taskId)
    else this.tasks.delete(taskId)
  }

  /** Snapshot completo das tarefas de background. */
  noteBackground(ids: readonly string[]): void {
    this.background = new Set(ids)
  }

  /** O Stop: as tarefas vivas, para o `stopTask`. */
  liveTasks(): string[] {
    return [...new Set([...this.tasks, ...this.background])]
  }

  /** O Stop pegou este item da fila durável em processamento (`reset`: desfaz a marca). */
  cancelInput(inputId: number | null, reset = false): void {
    if (reset) this.canceledInput = null
    else if (inputId !== null) this.canceledInput = inputId
  }

  /** O `result` deste item chegou: `true` = foi parado pelo usuário, sai da fila. */
  takeCanceledInput(inputId: number): boolean {
    if (this.canceledInput !== inputId) return false
    this.canceledInput = null
    return true
  }
}
