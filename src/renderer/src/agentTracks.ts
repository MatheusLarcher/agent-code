import type { AgentTaskStatus, ChatEvent } from '@shared/ipc'

/**
 * Live view of WHO is working inside a conversation — the agents panel's data.
 *
 * The chat feed only ever shows the main agent. Every call a subagent makes
 * arrives tagged with the `Task` tool-use that spawned it (`parentToolUseId`),
 * and instead of being dropped (as it used to be) it lands here, in a store
 * that is completely separate from `Conversation.messages`. That separation is
 * the whole point: the panel gains the detail without the chat gaining noise.
 *
 * This module is pure — no React, no IPC — so the routing rules are unit
 * testable on their own.
 */

/** One call made inside a track, with its result once it lands. */
export interface TrackStep {
  /** The tool-use id (also how the matching tool-result finds it back). */
  id: string
  name: string
  input: unknown
  startedAt: number
  endedAt?: number
  isError?: boolean
  /** Result text, trimmed — the panel shows a preview, not the whole payload. */
  result?: string
  /** Model id that made this call (from the response), when the event says. */
  model?: string
}

export interface AgentTrack {
  /** The `Task` tool-use id that spawned this subagent — the track's identity. */
  id: string
  /** Human label ("Explore: onde o plano é montado"), never a raw tool id. */
  label: string
  /** Subagent kind reported by the SDK (`Explore`, `general-purpose`, …). */
  subagentType?: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  /** Total calls made by this subagent (steps may be trimmed; this is not). */
  stepCount: number
  steps: TrackStep[]
  /** Em segundo plano: o tool_result de lançamento já voltou e a trilha segue
   *  rodando até o `task_notification` (evento `agent-task`). */
  background?: boolean
  /** A tarefa do SDK por trás da trilha, quando o ciclo dela chegou. */
  task?: TrackTask
}

/** O que o ciclo da tarefa do SDK (`agent-task`) disse por último. */
export interface TrackTask {
  id: string
  status: AgentTaskStatus
  lastToolName?: string
  summary?: string
  toolUses?: number
}

/** Tracks of one conversation, most recently started first. */
export type TrackMap = Record<string, AgentTrack>

/**
 * Tools that spawn a subagent. The SDK renamed this over time (`Task` in older
 * builds, `Agent` in the current one) and both still show up depending on the
 * bundled CLI — confirmed live: a real run emitted `Agent`, so keying only on
 * `Task` left the panel permanently empty.
 */
const SPAWN_TOOLS = new Set(['Task', 'Agent'])

/** Steps kept per track. A long-running subagent can make hundreds of calls and
 *  the panel only ever shows the tail — the rest stays in the CLI transcript. */
export const MAX_STEPS = 60
/** Finished tracks kept per conversation (running ones are never dropped). */
export const MAX_FINISHED_TRACKS = 12
const RESULT_PREVIEW = 2000

/** True for an event that belongs to a subagent rather than the main agent. */
export function isSubagentEvent(e: ChatEvent): boolean {
  if (e.kind === 'tool-use') return e.parentToolUseId != null
  if (e.kind === 'tool-result') return e.parentToolUseId != null
  return false
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** Build a readable label from whatever the SDK gave us, in order of quality. */
function labelFor(input: unknown, subagentType?: string, taskDescription?: string): string {
  const i = (input ?? {}) as Record<string, unknown>
  const text =
    firstString(taskDescription, i.description, i.subject, i.prompt) ?? 'Subagente'
  const short = text.length > 80 ? `${text.slice(0, 79)}…` : text
  return subagentType ? `${subagentType}: ${short}` : short
}

function trimSteps(steps: TrackStep[]): TrackStep[] {
  return steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps
}

/** Drop the oldest FINISHED tracks once there are too many; running ones stay. */
function trimTracks(map: TrackMap): TrackMap {
  const finished = Object.values(map)
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  if (finished.length <= MAX_FINISHED_TRACKS) return map
  const drop = new Set(finished.slice(MAX_FINISHED_TRACKS).map((t) => t.id))
  const next: TrackMap = {}
  for (const [id, track] of Object.entries(map)) if (!drop.has(id)) next[id] = track
  return next
}

/**
 * Fold one agent event into a conversation's tracks. Returns the SAME map when
 * the event doesn't concern the panel, so callers can skip the state update.
 */
export function reduceTracks(map: TrackMap, e: ChatEvent, now = Date.now()): TrackMap {
  if (e.kind === 'tool-use') {
    // Main agent delegating (`Task`): opens a track, still "running".
    if (e.parentToolUseId == null) {
      if (!SPAWN_TOOLS.has(e.name)) return map
      const track: AgentTrack = {
        id: e.id,
        label: labelFor(e.input, e.subagentType, e.taskDescription),
        ...(e.subagentType ? { subagentType: e.subagentType } : {}),
        status: 'running',
        startedAt: now,
        stepCount: 0,
        steps: []
      }
      return trimTracks({ ...map, [e.id]: track })
    }

    // A subagent whose opening Task we never saw (app reconnected mid-flight):
    // adopt it instead of dropping its work on the floor.
    const existing: AgentTrack = map[e.parentToolUseId] ?? {
      id: e.parentToolUseId,
      label: labelFor(undefined, e.subagentType, e.taskDescription),
      ...(e.subagentType ? { subagentType: e.subagentType } : {}),
      status: 'running',
      startedAt: now,
      stepCount: 0,
      steps: []
    }
    const step: TrackStep = {
      id: e.id,
      name: e.name,
      input: e.input,
      startedAt: now,
      ...(typeof e.model === 'string' && e.model.trim() ? { model: e.model } : {})
    }
    return {
      ...map,
      [existing.id]: {
        ...existing,
        // A late label beats the placeholder one.
        label: e.taskDescription
          ? labelFor(undefined, e.subagentType ?? existing.subagentType, e.taskDescription)
          : existing.label,
        stepCount: existing.stepCount + 1,
        steps: trimSteps([...existing.steps, step])
      }
    }
  }

  if (e.kind === 'tool-result') {
    // The Task call coming back closes the track it opened — except the launch of
    // a BACKGROUND subagent: that result is only "launched", the work goes on
    // until the task's notification (`agent-task`) closes the track.
    if (e.parentToolUseId == null) {
      const track = map[e.toolUseId]
      if (!track) return map
      if (!e.isError && track.status === 'running' && (track.background || isBackgroundLaunch(e.text))) {
        return track.background ? map : { ...map, [track.id]: { ...track, background: true } }
      }
      return trimTracks({
        ...map,
        [track.id]: { ...track, status: e.isError ? 'error' : 'done', endedAt: now }
      })
    }
    const track = map[e.parentToolUseId]
    if (!track) return map
    const i = track.steps.findIndex((s) => s.id === e.toolUseId)
    if (i < 0) return map
    const steps = [...track.steps]
    steps[i] = {
      ...steps[i],
      endedAt: now,
      isError: e.isError,
      result: e.text.length > RESULT_PREVIEW ? `${e.text.slice(0, RESULT_PREVIEW)}…` : e.text
    }
    return { ...map, [track.id]: { ...track, steps } }
  }

  if (e.kind === 'agent-task') return applyAgentTask(map, e, now)
  if (e.kind === 'background-tasks') return settleBackground(map, new Set(e.tasks.map((t) => t.id)), now)

  return map
}

/** O texto do tool_result de um Agent lançado em segundo plano (o CLI o devolve na hora). */
const BACKGROUND_LAUNCH = /^\s*Async agent launched successfully|running in the background/i

export function isBackgroundLaunch(text: string): boolean {
  return BACKGROUND_LAUNCH.test(text)
}

const TASK_DONE: Record<Exclude<AgentTaskStatus, 'running'>, AgentTrack['status']> = {
  completed: 'done',
  failed: 'error',
  stopped: 'done'
}

/**
 * O ciclo da tarefa do SDK sobre a trilha do Agent que a lançou (`toolUseId`):
 * `started`/`progress` marcam o segundo plano e a última ferramenta; o fim
 * (`completed`/`failed`/`stopped`) fecha a trilha. Tarefa sem trilha (shell em
 * segundo plano, Agent nunca visto) não abre nada.
 */
function applyAgentTask(map: TrackMap, e: Extract<ChatEvent, { kind: 'agent-task' }>, now: number): TrackMap {
  const track = e.toolUseId ? map[e.toolUseId] : undefined
  if (!track) return map
  const prev = track.task
  const lastToolName = e.lastToolName ?? prev?.lastToolName
  const summary = e.summary ?? prev?.summary
  const toolUses = e.toolUses ?? prev?.toolUses
  const task: TrackTask = {
    id: e.taskId,
    status: e.status,
    ...(lastToolName ? { lastToolName } : {}),
    ...(summary ? { summary } : {}),
    ...(toolUses !== undefined ? { toolUses } : {})
  }
  const background = e.backgrounded ?? track.background
  const next: AgentTrack = {
    ...track,
    task,
    ...(background ? { background: true } : {}),
    ...(!track.subagentType && e.subagentType ? { subagentType: e.subagentType } : {})
  }
  if (e.status !== 'running') {
    // Fim repetido (o hook fechou, o SDK corrige o status): a hora do fim é a primeira.
    const endedAt = prev && prev.status !== 'running' && track.endedAt !== undefined ? track.endedAt : now
    return trimTracks({ ...map, [track.id]: { ...next, status: TASK_DONE[e.status], endedAt } })
  }
  // Ainda rodando: uma trilha fechada antes da hora (o fim do turno, um erro) e
  // cuja tarefa não terminou volta a rodar.
  const settled = prev !== undefined && prev.status !== 'running'
  if (track.status !== 'running' && !settled) {
    const reopened: AgentTrack = { ...next, status: 'running' }
    delete reopened.endedAt
    return { ...map, [track.id]: reopened }
  }
  return { ...map, [track.id]: next }
}

/**
 * O snapshot `background-tasks` é o nível autoritativo do SDK: trilha em segundo
 * plano rodando cuja tarefa saiu dele acabou (o `task_notification` que vier
 * depois só corrige o status). Cobre o fim que se perdeu.
 */
function settleBackground(map: TrackMap, live: ReadonlySet<string>, now: number): TrackMap {
  let next: TrackMap | null = null
  for (const [id, track] of Object.entries(map)) {
    if (track.status !== 'running' || !track.background || !track.task || live.has(track.task.id)) continue
    next ??= { ...map }
    next[id] = { ...track, status: 'done', endedAt: now }
  }
  return next ? trimTracks(next) : map
}

/** Panel ordering: running first, then most recent. */
export function sortTracks(map: TrackMap): AgentTrack[] {
  return Object.values(map).sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return b.startedAt - a.startedAt
  })
}

/** Close every still-running track — the turn ended, nothing is working now.
 *  `keepBackground`: the main turn's `result` does not end a subagent running in
 *  the background; its own notification (or the snapshot) does. */
export function closeRunningTracks(map: TrackMap, now = Date.now(), keepBackground = false): TrackMap {
  let changed = false
  const next: TrackMap = {}
  for (const [id, track] of Object.entries(map)) {
    if (track.status === 'running' && !(keepBackground && track.background)) {
      changed = true
      next[id] = { ...track, status: 'done', endedAt: now }
    } else {
      next[id] = track
    }
  }
  return changed ? next : map
}
