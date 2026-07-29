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

/**
 * Every tool call in a conversation, resolved onto the project tree, oldest
 * first. Subagent calls are included: on the map "who called it" doesn't
 * matter, only which part of the project moved.
 */
export function fileTouches(messages: UIMessage[], cwd: string): Touch[] {
  const out: Touch[] = []
  for (const m of messages) {
    if (m.kind !== 'tool-use') continue
    const input = (m.input ?? {}) as Record<string, unknown>
    const raw = rawPath(input)
    // Grep/Glob can be scoped to a folder — that folder is a real node too.
    const scope = raw ?? (m.name === 'Grep' || m.name === 'Glob' ? str(input.path) : undefined)
    const stats = m.name === 'Edit' || m.name === 'NotebookEdit' ? editStats(input) : null
    out.push({
      id: m.id,
      tool: m.name,
      path: scope ? toRelative(scope, cwd) : null,
      detail: describeCall(m.name, input),
      isError: m.result?.isError === true,
      ...(stats ? { added: stats.added, removed: stats.removed } : {})
    })
  }
  return out
}
