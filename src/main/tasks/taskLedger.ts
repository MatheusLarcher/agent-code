import type {
  LeaseFence,
  PersistenceRepository,
  Task,
  TaskClaim,
  TaskClaimFilter,
  TaskCreate,
  TaskBoardLinkWrite,
  TaskDeliverable,
  TaskDeliverableAdd,
  TaskEvent,
  TaskEventAppend,
  TaskQuery,
  TaskRepository,
  TaskStatus,
  TaskStep,
  TaskStepAppend,
  TaskStepFinish,
  TaskTransition
} from '../persistence/types'
import { createBoardCardForTask, syncBoardCardOnTransition, type TaskBoardPort } from './taskBoardSync'

export {
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  LEASE_RELEASING_STATUSES,
  TASK_LEASE_TTL_MS,
  assertTaskTransition,
  assertTaskFence
} from './taskModel'

/**
 * Durable record of tasks, steps and deliverables — the main process's entry
 * point to the ledger. Storage and the transactional rules (state machine,
 * lease fencing, one `task_events` row per change) live in the repository so
 * they hold on both backends; this class is the stable API the rest of main
 * programs against and follows the active repository across storage
 * transitions via `bind()`.
 */
export class TaskLedger {
  private repository: TaskRepository
  private board: TaskBoardPort | null = null

  constructor(repository: PersistenceRepository | TaskRepository) {
    this.repository = repository
  }

  /** Swap the backing repository (SQLite ↔ PostgreSQL) without re-wiring callers. */
  bind(repository: PersistenceRepository | TaskRepository): void {
    this.repository = repository
  }

  /** Quadro onde as tarefas aparecem como cartões (`taskBoardSync.ts`); `null` desliga. */
  attachBoard(board: TaskBoardPort | null): void {
    this.board = board
  }

  createTask(input: TaskCreate): Promise<Task> {
    return this.repository.createTask(input)
  }

  /** Cria e vincula o cartão da tarefa no Quadro. `null` sem quadro ou se falhar. */
  async createBoardCard(task: Task): Promise<string | null> {
    return this.board ? createBoardCardForTask(this.board, this, task) : null
  }

  /** Oldest claimable `pending` task, leased to `agentId`; `null` when there is none. */
  claimTask(agentId: string, filter?: TaskClaimFilter): Promise<TaskClaim | null> {
    return this.repository.claimTask(agentId, filter)
  }

  renewTaskLease(taskId: string, fence: LeaseFence): Promise<TaskClaim> {
    return this.repository.renewTaskLease(taskId, fence)
  }

  async transitionTask(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    fence?: LeaseFence,
    details?: Pick<TaskTransition, 'agent' | 'reason'>
  ): Promise<Task> {
    const task = await this.repository.transitionTask({ taskId, from, to, fence, ...details })
    // Aqui, e não na ferramenta: o reaper também transiciona, e o cartão tem de acompanhar.
    if (this.board) await syncBoardCardOnTransition(this.board, this, task, details?.reason)
    return task
  }

  appendStep(input: TaskStepAppend): Promise<TaskStep> {
    return this.repository.appendTaskStep(input)
  }

  finishStep(input: TaskStepFinish): Promise<TaskStep> {
    return this.repository.finishTaskStep(input)
  }

  addDeliverable(input: TaskDeliverableAdd): Promise<TaskDeliverable> {
    return this.repository.addTaskDeliverable(input)
  }

  appendEvent(input: TaskEventAppend): Promise<TaskEvent> {
    return this.repository.appendTaskEvent(input)
  }

  /** Registra o caminho local deste PC sob a identidade estável do projeto. */
  recordProjectIdentity(row: { projectCwd: string; projectId: string; signature: string }): Promise<void> {
    return this.repository.recordProjectIdentity(row)
  }

  /** Caminhos equivalentes do mesmo projeto, de todos os PCs que já registraram. */
  projectCwdsForIdentity(projectId: string): Promise<string[]> {
    return this.repository.projectCwdsForIdentity(projectId)
  }

  /** Vincula (upsert) uma tarefa do ledger a um cartão do quadro. */
  linkTaskToBoardItem(input: TaskBoardLinkWrite): Promise<void> {
    return this.repository.linkTaskToBoardItem(input)
  }

  /** `task_id -> board_item_id` das tarefas informadas que têm vínculo. */
  boardItemIdsForTasks(taskIds: string[]): Promise<Map<string, string>> {
    return this.repository.boardItemIdsForTasks(taskIds)
  }

  getTask(taskId: string): Promise<Task | null> {
    return this.repository.getTask(taskId)
  }

  listTasks(query?: TaskQuery): Promise<Task[]> {
    return this.repository.listTasks(query)
  }

  listSteps(taskId: string): Promise<TaskStep[]> {
    return this.repository.listTaskSteps(taskId)
  }

  listDeliverables(taskId: string): Promise<TaskDeliverable[]> {
    return this.repository.listTaskDeliverables(taskId)
  }

  listEvents(taskId: string): Promise<TaskEvent[]> {
    return this.repository.listTaskEvents(taskId)
  }
}
