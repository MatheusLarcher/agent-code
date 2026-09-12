import type {
  TaskBoard,
  TaskBoardDeliverable,
  TaskBoardDetail,
  TaskBoardEvent,
  TaskBoardItem,
  TaskBoardStatus,
  TaskBoardStep
} from '../../shared/ipc'
import { TASK_BOARD_LIMIT } from '../../shared/ipc'
import type { Task, TaskDeliverable, TaskEvent, TaskStep } from '../persistence/types'
import type { TaskLedger } from './taskLedger'
import { resolveProjectCwds } from './projectScope'

/**
 * Read-only projection of the task ledger for the agents panel.
 *
 * It lives here, and not in the renderer, for the same reason the ledger lives
 * in the main process: the repository types are Node-side. What crosses the IPC
 * is a flat, already-ordered view — the panel renders it, it does not decide
 * what "next" means.
 */

/** Statuses the board shows by default: the ones somebody still has to act on. */
export const OPEN_TASK_STATUSES: TaskBoardStatus[] = ['review', 'running', 'blocked', 'pending']

/** Everything else — shown only when the user asks for the finished ones. */
export const CLOSED_TASK_STATUSES: TaskBoardStatus[] = ['done', 'failed', 'cancelled']

/**
 * Triage order: whoever is waiting on a human comes first, then live work, then
 * the queue. Sorting here (and not in the panel) keeps the two views of the
 * same data — desktop and any future one — from drifting apart.
 */
const STATUS_RANK: Record<TaskBoardStatus, number> = {
  review: 0,
  running: 1,
  blocked: 2,
  pending: 3,
  failed: 4,
  done: 5,
  cancelled: 6
}

/**
 * Evidence is counted only where its absence is actionable. A `review` task
 * with no deliverable is a "done" that would be pure assertion; a `pending` one
 * has nothing to show yet, and counting it would cost one query per task to
 * report a zero nobody acts on.
 */
const COUNT_EVIDENCE_FOR: TaskBoardStatus[] = ['review', 'done']

export interface TaskBoardQuery {
  /** Restrict to one project — the panel defaults to the conversation's folder. */
  projectCwd?: string
  includeFinished?: boolean
  limit?: number
}

function firstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** One readable line out of a free-form JSON blob, never a stack trace. */
export function summarizeData(data: Record<string, unknown> | null, fallback: string): string {
  if (!data) return fallback
  const direct = firstString(data, ['reason', 'message', 'summary', 'note', 'detail', 'error'])
  if (direct) return direct.length > 160 ? `${direct.slice(0, 159)}…` : direct
  const keys = Object.keys(data)
  return keys.length ? keys.slice(0, 4).join(', ') : fallback
}

export function toBoardItem(task: Task, deliverables: number | null): TaskBoardItem {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    acceptance: task.acceptance,
    ownerAgent: task.ownerAgent,
    writeScopeAllow: task.writeScope.allow,
    writeScopeDeny: task.writeScope.deny,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    // Soltar o lease (`review`/`blocked` e terminais) NÃO limpa o token: o
    // repositório grava `lease_expires_at = agora`, ou seja, expira na hora. Por
    // isso o painel decide "vivo" comparando a data com o relógio dele, e não
    // pela presença do token — que só distingue "nunca foi reivindicada".
    leaseExpiresAt: task.leaseToken ? task.leaseExpiresAt : null,
    conversationId: task.conversationId,
    projectCwd: task.projectCwd,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    deliverables
  }
}

export function sortBoardItems(items: TaskBoardItem[]): TaskBoardItem[] {
  return [...items].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (rank !== 0) return rank
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

function toStep(step: TaskStep): TaskBoardStep {
  return {
    id: step.id,
    seq: step.seq,
    kind: step.kind,
    status: step.status,
    agent: step.agent,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    error: step.error ? summarizeData(step.error, 'falhou') : null
  }
}

function toDeliverable(item: TaskDeliverable): TaskBoardDeliverable {
  return {
    id: item.id,
    kind: item.kind,
    summary: item.summary,
    verified: item.verified,
    createdAt: item.createdAt
  }
}

function toEvent(event: TaskEvent): TaskBoardEvent {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    summary: summarizeData(event.data, event.kind)
  }
}

export async function buildTaskBoard(
  ledger: TaskLedger | null,
  query: TaskBoardQuery = {}
): Promise<TaskBoard> {
  // No authoritative repository is not an empty queue, and the panel says so.
  if (!ledger) return { available: false, items: [] }

  const status = query.includeFinished
    ? [...OPEN_TASK_STATUSES, ...CLOSED_TASK_STATUSES]
    : OPEN_TASK_STATUSES
  // Filtra pelos caminhos equivalentes, não pelo caminho local: o mesmo projeto
  // em outro PC tem outro `project_cwd`, e o painel mostraria meia fila.
  const projectCwds = query.projectCwd
    ? await resolveProjectCwds(ledger, query.projectCwd)
    : undefined
  const tasks = await ledger.listTasks({
    status,
    ...(projectCwds ? { projectCwds } : {}),
    limit: query.limit ?? TASK_BOARD_LIMIT
  })

  const items = await Promise.all(
    tasks.map(async (task) => {
      if (!COUNT_EVIDENCE_FOR.includes(task.status)) return toBoardItem(task, null)
      // One extra query only for the handful of tasks where "no evidence" is
      // the thing the user needs to see.
      const deliverables = await ledger.listDeliverables(task.id)
      return toBoardItem(task, deliverables.length)
    })
  )

  return { available: true, items: sortBoardItems(items) }
}

export async function buildTaskDetail(
  ledger: TaskLedger | null,
  taskId: string
): Promise<TaskBoardDetail | null> {
  if (!ledger) return null
  const [steps, deliverables, events] = await Promise.all([
    ledger.listSteps(taskId),
    ledger.listDeliverables(taskId),
    ledger.listEvents(taskId)
  ])
  return {
    steps: steps.map(toStep),
    deliverables: deliverables.map(toDeliverable),
    events: events.map(toEvent)
  }
}
