import { randomUUID } from 'node:crypto'
import {
  StorageError,
  type DeliverableKind,
  type LeaseFence,
  type StepKind,
  type Task,
  type TaskCreate,
  type TaskDeliverable,
  type TaskEvent,
  type TaskStatus,
  type TaskStep,
  type WriteScope
} from '../persistence/types'

/**
 * Rules shared by the SQLite and PostgreSQL task ledgers: the state machine,
 * the lease fence and input normalisation. Everything here is pure so both
 * backends enforce exactly the same contract inside their own transactions.
 */

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled'
]
export const STEP_KINDS: readonly StepKind[] = ['analyze', 'implement', 'verify', 'review', 'handoff']
export const DELIVERABLE_KINDS: readonly DeliverableKind[] = ['diff', 'test_run', 'note', 'file', 'screenshot']

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running'],
  running: ['blocked', 'review', 'failed', 'cancelled'],
  blocked: ['running', 'cancelled'],
  review: ['done', 'running', 'failed'],
  failed: ['pending'],
  done: [],
  cancelled: []
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled'])

export const TASK_LEASE_TTL_MS = 60_000
export const DEFAULT_MAX_ATTEMPTS = 3

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

type TransitionSubject = Pick<Task, 'id' | 'status' | 'attempts' | 'maxAttempts'>

/** Throws `TASK_INVALID_TRANSITION` unless `from → to` is allowed for this task right now. */
export function assertTaskTransition(task: TransitionSubject, from: TaskStatus, to: TaskStatus): void {
  if (!isTaskStatus(from) || !isTaskStatus(to)) {
    throw new StorageError('TASK_INVALID_TRANSITION', `Estado de tarefa desconhecido: ${from} → ${to}.`)
  }
  if (task.status !== from) {
    throw new StorageError(
      'TASK_INVALID_TRANSITION',
      `Tarefa ${task.id} está em '${task.status}', não em '${from}'.`
    )
  }
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new StorageError('TASK_INVALID_TRANSITION', `Transição inválida para a tarefa ${task.id}: ${from} → ${to}.`)
  }
  if (from === 'failed' && to === 'pending' && task.attempts >= task.maxAttempts) {
    throw new StorageError(
      'TASK_INVALID_TRANSITION',
      `Tarefa ${task.id} esgotou as tentativas (${task.attempts}/${task.maxAttempts}).`
    )
  }
}

type FenceSubject = Pick<Task, 'id' | 'leaseToken' | 'fencingEpoch'>

/**
 * A task has a single writer at a time. With a live lease only the holder's
 * fence (token + epoch) may write; without a live lease unfenced writes are
 * allowed (resume, cancel from the UI) but a stale fence is still rejected.
 * `leaseLive` is computed by the caller against the backend's clock.
 */
export function assertTaskFence(task: FenceSubject, fence: LeaseFence | undefined, leaseLive: boolean): void {
  if (!fence) {
    if (leaseLive) {
      throw new StorageError('TASK_FENCE_STALE', `Tarefa ${task.id} possui um writer ativo; informe o fence do lease.`)
    }
    return
  }
  if (!leaseLive || task.leaseToken !== fence.token || task.fencingEpoch !== fence.fencingEpoch) {
    throw new StorageError('TASK_FENCE_STALE', `Lease da tarefa ${task.id} expirou ou pertence a outro writer.`)
  }
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new StorageError('INVALID_PERSISTED_DATA', `${label} deve ser uma lista de strings.`)
  }
  return value as string[]
}

export function normalizeWriteScope(value: Partial<WriteScope> | undefined): WriteScope {
  return {
    allow: stringList(value?.allow, 'write_scope.allow'),
    deny: stringList(value?.deny, 'write_scope.deny')
  }
}

export function parseWriteScope(raw: unknown): WriteScope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'write_scope persistido inválido.')
  }
  return normalizeWriteScope(raw as Partial<WriteScope>)
}

export interface NormalizedTaskCreate {
  id: string
  conversationId: string | null
  projectCwd: string
  title: string
  goal: string
  acceptance: string[]
  writeScope: WriteScope
  parentTaskId: string | null
  maxAttempts: number
}

export function normalizeTaskCreate(input: TaskCreate): NormalizedTaskCreate {
  const title = input.title?.trim() ?? ''
  const goal = input.goal?.trim() ?? ''
  if (!title) throw new StorageError('INVALID_PERSISTED_DATA', 'Tarefa precisa de título.')
  if (!goal) throw new StorageError('INVALID_PERSISTED_DATA', 'Tarefa precisa de objetivo.')
  if (typeof input.projectCwd !== 'string' || !input.projectCwd.trim()) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Tarefa precisa de project_cwd.')
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'max_attempts deve ser um inteiro positivo.')
  }
  return {
    id: input.id?.trim() || randomUUID(),
    conversationId: input.conversationId ?? null,
    projectCwd: input.projectCwd,
    title,
    goal,
    acceptance: stringList(input.acceptance, 'acceptance'),
    writeScope: normalizeWriteScope(input.writeScope),
    parentTaskId: input.parentTaskId ?? null,
    maxAttempts
  }
}

export function assertStepKind(kind: string): asserts kind is StepKind {
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Tipo de etapa desconhecido: ${kind}.`)
  }
}

export function assertDeliverableKind(kind: string): asserts kind is DeliverableKind {
  if (!(DELIVERABLE_KINDS as readonly string[]).includes(kind)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Tipo de entrega desconhecido: ${kind}.`)
  }
}

export function assertStepFinalStatus(status: TaskStatus): void {
  if (status === 'pending' || status === 'running') {
    throw new StorageError('TASK_INVALID_TRANSITION', `Etapa não pode ser finalizada como '${status}'.`)
  }
}

// ---------------------------------------------------------------------------
// Row mapping. SQLite hands back JSON as text and timestamps as ISO strings;
// PostgreSQL hands back parsed jsonb, Date objects and bigint-as-string.
// ---------------------------------------------------------------------------

type JsonColumn = string | unknown | null
type TimeColumn = Date | string
type IntColumn = number | bigint | string

function parseJsonColumn(raw: JsonColumn, label: string): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', `${label} persistido inválido.`, false, { cause })
  }
}

export function jsonObjectColumn(raw: JsonColumn, label: string): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  const parsed = parseJsonColumn(raw, label)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `${label} persistido inválido.`)
  }
  return parsed as Record<string, unknown>
}

function isoColumn(value: TimeColumn): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function optionalIso(value: TimeColumn | null): string | null {
  return value === null || value === undefined ? null : isoColumn(value)
}

export interface TaskRow {
  id: string
  conversation_id: string | null
  project_cwd: string
  title: string
  goal: string
  acceptance_json: JsonColumn
  status: string
  owner_agent: string | null
  write_scope_json: JsonColumn
  parent_task_id: string | null
  attempts: IntColumn
  max_attempts: IntColumn
  lease_token: string | null
  lease_expires_at: TimeColumn | null
  fencing_epoch: IntColumn
  revision: IntColumn
  created_at: TimeColumn
  updated_at: TimeColumn
}

export interface TaskStepRow {
  id: string
  task_id: string
  seq: IntColumn
  kind: string
  status: string
  agent: string | null
  sdk_session_id: string | null
  started_at: TimeColumn
  finished_at: TimeColumn | null
  error_json: JsonColumn
  revision: IntColumn
  created_at: TimeColumn
  updated_at: TimeColumn
}

export interface TaskDeliverableRow {
  id: string
  task_id: string
  step_id: string | null
  kind: string
  summary: string
  payload_path: string | null
  payload_hash: string | null
  verified: number | boolean
  verified_by: string | null
  revision: IntColumn
  created_at: TimeColumn
  updated_at: TimeColumn
}

export interface TaskEventRow {
  id: string
  task_id: string
  step_id: string | null
  at: TimeColumn
  kind: string
  data_json: JsonColumn
}

export function taskFromRow(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Status de tarefa persistido inválido: ${row.status}.`)
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectCwd: row.project_cwd,
    title: row.title,
    goal: row.goal,
    acceptance: stringList(parseJsonColumn(row.acceptance_json, 'acceptance'), 'acceptance'),
    status: row.status,
    ownerAgent: row.owner_agent,
    writeScope: parseWriteScope(parseJsonColumn(row.write_scope_json, 'write_scope')),
    parentTaskId: row.parent_task_id,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token,
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    fencingEpoch: Number(row.fencing_epoch),
    revision: Number(row.revision),
    createdAt: isoColumn(row.created_at),
    updatedAt: isoColumn(row.updated_at)
  }
}

export function taskStepFromRow(row: TaskStepRow): TaskStep {
  assertStepKind(row.kind)
  if (!isTaskStatus(row.status)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Status de etapa persistido inválido: ${row.status}.`)
  }
  return {
    id: row.id,
    taskId: row.task_id,
    seq: Number(row.seq),
    kind: row.kind,
    status: row.status,
    agent: row.agent,
    sdkSessionId: row.sdk_session_id,
    startedAt: isoColumn(row.started_at),
    finishedAt: optionalIso(row.finished_at),
    error: jsonObjectColumn(row.error_json, 'error'),
    revision: Number(row.revision),
    createdAt: isoColumn(row.created_at),
    updatedAt: isoColumn(row.updated_at)
  }
}

export function taskDeliverableFromRow(row: TaskDeliverableRow): TaskDeliverable {
  assertDeliverableKind(row.kind)
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    kind: row.kind,
    summary: row.summary,
    payloadPath: row.payload_path,
    payloadHash: row.payload_hash,
    verified: row.verified === true || Number(row.verified) === 1,
    verifiedBy: row.verified_by,
    revision: Number(row.revision),
    createdAt: isoColumn(row.created_at),
    updatedAt: isoColumn(row.updated_at)
  }
}

export function taskEventFromRow(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    at: isoColumn(row.at),
    kind: row.kind,
    data: jsonObjectColumn(row.data_json, 'data') ?? {}
  }
}
