import type { UIMessage } from './types'

/**
 * What the agent is doing, expressed as points ON THE PROJECT TREE — the data
 * behind the "Projeto" graph view.
 *
 * This module invents no state. It reads the SAME `Conversation.messages` the
 * chat renders (each `tool-use` already carries its result, see App.tsx) and
 * turns every call into "which file it touched + a short human label". That is
 * the whole reason the graph can show everything the chat shows without a
 * second store to keep in sync.
 *
 * Pure — no React, no IPC — so the labelling rules are unit testable.
 */

/** One tool call, resolved against the project tree. */
export interface Touch {
  /** The tool-use id — also how the graph knows a call is NEW (worth animating). */
  id: string
  /** Id of the user message that started the turn this call belongs to — how the
   *  map filters "show me only what my 3rd message made the agent do". Calls that
   *  arrive before any user message (a resumed session) get `PRE_TURN`. */
  turnId: string
  /** Tool name as the SDK reports it (`Read`, `Edit`, `Bash`, …). */
  tool: string
  /** Path relative to the project root, or null when the call targets no file
   *  (a bare `Bash`, a web search…) — those land on the project root node. */
  path: string | null
  /** Short human text for the balloon (the command, the pattern, the file…). */
  detail: string
  /** Lines added/removed by an Edit — drawn colored, like the chat's tool card. */
  added?: number
  removed?: number
  /** True once the call came back with an error. */
  isError: boolean
}

/**
 * Colour per KIND of action, so the map reads as "what happened here", not just
 * "something happened here" — everything used to be the same green. An error
 * always wins over the tool's own colour: a failed call is the one thing you
 * want to spot without decoding the palette.
 */
export const ACTION_COLORS = {
  read: '#6fa8d9',
  edit: '#e0a458',
  write: '#7fae6f',
  run: '#b087e0',
  search: '#55b9a6',
  web: '#d9c96f',
  agent: '#e07fb0',
  other: '#9a938c',
  error: '#d97070'
} as const

export type ActionKind = keyof typeof ACTION_COLORS

const TOOL_KIND: Record<string, ActionKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  NotebookEdit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebSearch: 'web',
  WebFetch: 'web',
  Task: 'agent',
  Agent: 'agent'
}

/** Which family a tool belongs to (MCP tools fall back by prefix). */
export function actionKind(tool: string): ActionKind {
  const known = TOOL_KIND[tool]
  if (known) return known
  if (tool.startsWith('mcp__browser__')) return 'web'
  if (tool.startsWith('mcp__')) return 'other'
  return 'other'
}

/** Colour of a call on the map: the tool's family, or red when it failed. */
export function actionColor(tool: string, isError?: boolean): string {
  return isError ? ACTION_COLORS.error : ACTION_COLORS[actionKind(tool)]
}

/** Human name of each family, for the map's legend. */
export const ACTION_LABELS: Record<ActionKind, string> = {
  read: 'leu',
  edit: 'editou',
  write: 'criou',
  run: 'rodou',
  search: 'procurou',
  web: 'web',
  agent: 'subagente',
  other: 'outros',
  error: 'erro'
}

/**
 * File type used by the map's filter: the extension in lowercase (`ts`, `tsx`,
 * `md`…), or the file name itself when it has none (`Dockerfile`), so turning a
 * type off is predictable instead of hiding "everything without a dot".
 */
export function fileType(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Path of a file the tool acted on, as given in the tool input. */
function rawPath(input: Record<string, unknown>): string | undefined {
  return str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
}

/**
 * Lines added/removed by an Edit. Returned as NUMBERS (not a formatted string)
 * so the balloon can paint `+N` green and `−N` red exactly like the chat's tool
 * card does, instead of one grey blob of text.
 */
export function editStats(input: unknown): { added: number; removed: number } | null {
  const i = (input ?? {}) as Record<string, unknown>
  const oldS = i.old_string
  const newS = i.new_string
  if (typeof oldS !== 'string' || typeof newS !== 'string') return null
  return {
    added: newS === '' ? 0 : newS.split('\n').length,
    removed: oldS === '' ? 0 : oldS.split('\n').length
  }
}

/**
 * Turn a project-root-relative or absolute path into a path relative to `cwd`,
 * always with forward slashes so it matches what `projectTree` returns.
 *
 * Windows matters here: the agent reports `C:\Users\...\src\main\index.ts` while
 * the tree speaks `src/main/index.ts`. Comparison is case-insensitive because
 * Windows paths are, and a case mismatch would silently light up no node at all.
 */
export function toRelative(p: string, cwd: string): string {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = norm(p)
  const root = norm(cwd)
  if (root && file.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return file.slice(root.length + 1)
  }
  if (root && file.toLowerCase() === root.toLowerCase()) return ''
  // Already relative (or outside the project — the graph just won't find a node).
  return file.replace(/^\.\//, '')
}

/** Short label describing what this call is doing, per tool. */
export function describeCall(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const file = rawPath(i)
  const base = file ? file.replace(/\\/g, '/').split('/').pop()! : ''

  switch (tool) {
    case 'Edit':
    case 'NotebookEdit':
      // Só o arquivo: a contagem vai à parte, colorida (ver editStats).
      return base
    case 'Write':
      return base
    case 'Read': {
      const off = i.offset
      const lim = i.limit
      return typeof off === 'number' || typeof lim === 'number' ? `${base} (trecho)` : base
    }
    case 'Bash':
      return str(i.command) ?? ''
    case 'Grep':
      return str(i.pattern) ?? ''
    case 'Glob':
      return str(i.pattern) ?? ''
    case 'WebSearch':
      return str(i.query) ?? ''
    case 'WebFetch':
      return str(i.url) ?? ''
    case 'Task':
    case 'Agent':
      return str(i.description) ?? str(i.subagent_type) ?? 'subagente'
    default:
      return (
        base ||
        str(i.command) ||
        str(i.query) ||
        str(i.pattern) ||
        str(i.description) ||
        ''
      )
  }
}

/** Turn id used by calls that happened before the first user message of the
 *  conversation (a session resumed from disk, or history that got compacted). */
export const PRE_TURN = '__antes__'

/**
 * Every tool call in a conversation, resolved onto the project tree, oldest
 * first. Subagent calls are included: on the map "who called it" doesn't
 * matter, only which part of the project moved.
 *
 * Each call also carries the id of the user message that triggered it
 * (`turnId`), which is what lets the map filter the work by "the message I
 * sent". This is DERIVED from the message list rather than stored separately:
 * the tool-use messages are already persisted with the conversation, so a
 * second store would only be one more thing to keep in sync.
 */
export function fileTouches(messages: UIMessage[], cwd: string): Touch[] {
  const out: Touch[] = []
  let turnId = PRE_TURN
  for (const m of messages) {
    if (m.kind === 'user') {
      turnId = m.id
      continue
    }
    if (m.kind !== 'tool-use') continue
    const input = (m.input ?? {}) as Record<string, unknown>
    const raw = rawPath(input)
    // Grep/Glob can be scoped to a folder — that folder is a real node too.
    const scope = raw ?? (m.name === 'Grep' || m.name === 'Glob' ? str(input.path) : undefined)
    const stats = m.name === 'Edit' || m.name === 'NotebookEdit' ? editStats(input) : null
    out.push({
      id: m.id,
      turnId,
      tool: m.name,
      path: scope ? toRelative(scope, cwd) : null,
      detail: describeCall(m.name, input),
      isError: m.result?.isError === true,
      ...(stats ? { added: stats.added, removed: stats.removed } : {})
    })
  }
  return out
}

/** One user message, with what the agent ended up doing because of it. */
export interface Turn {
  /** Same id as the user message (`Touch.turnId`). */
  id: string
  /** 1-based position in the conversation — the map shows it as "#3". */
  index: number
  /** The message text, trimmed to one line for the chip. */
  label: string
  /** How many tool calls this turn made. */
  calls: number
  /** Distinct files it touched (no folders, no root-level calls). */
  files: number
}

const TURN_LABEL_MAX = 90

/**
 * The conversation's user messages, in order, each with the size of the work it
 * produced. Turns that ran no tool call at all are dropped: the map has nothing
 * to show for them and they would only pad the filter bar.
 */
export function turnsOf(messages: UIMessage[], touches: Touch[]): Turn[] {
  const byTurn = new Map<string, { calls: number; files: Set<string> }>()
  for (const t of touches) {
    let agg = byTurn.get(t.turnId)
    if (!agg) byTurn.set(t.turnId, (agg = { calls: 0, files: new Set() }))
    agg.calls++
    if (t.path) agg.files.add(t.path)
  }

  const out: Turn[] = []
  if (byTurn.has(PRE_TURN)) {
    const agg = byTurn.get(PRE_TURN)!
    out.push({ id: PRE_TURN, index: 0, label: 'Antes', calls: agg.calls, files: agg.files.size })
  }
  let index = 0
  for (const m of messages) {
    if (m.kind !== 'user') continue
    index++
    const agg = byTurn.get(m.id)
    if (!agg) continue
    const oneLine = (m.text ?? '').replace(/\s+/g, ' ').trim()
    out.push({
      id: m.id,
      index,
      label:
        oneLine.length > TURN_LABEL_MAX ? `${oneLine.slice(0, TURN_LABEL_MAX - 1)}…` : oneLine || '(sem texto)',
      calls: agg.calls,
      files: agg.files.size
    })
  }
  return out
}
