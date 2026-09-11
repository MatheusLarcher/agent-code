import type {
  LeaseFence,
  PersistenceRepository,
  Task,
  TaskClaim,
  TaskClaimFilter,
  TaskCreate,
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

  constructor(repository: PersistenceRepository | TaskRepository) {
    this.repository = repository
  }

  /** Swap the backing repository (SQLite ↔ PostgreSQL) without re-wiring callers. */
  bind(repository: PersistenceRepository | TaskRepository): void {
    this.repository = repository
  }

  createTask(input: TaskCreate): Promise<Task> {
    return this.repository.createTask(input)
  }

  /** Oldest claimable `pending` task, leased to `agentId`; `null` when there is none. */
  claimTask(agentId: string, filter?: TaskClaimFilter): Promise<TaskClaim | null> {
    return this.repository.claimTask(agentId, filter)
  }

  renewTaskLease(taskId: string, fence: LeaseFence): Promise<TaskClaim> {
    return this.repository.renewTaskLease(taskId, fence)
  }

  transitionTask(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    fence?: LeaseFence,
    details?: Pick<TaskTransition, 'agent' | 'reason'>
  ): Promise<Task> {
    return this.repository.transitionTask({ taskId, from, to, fence, ...details })
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
