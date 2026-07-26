import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TaskItem } from '../shared/ipc'

/**
 * The agent's task list, read straight from the Claude Code CLI's own storage
 * (`~/.claude/tasks/<sessionId>/<taskId>.json`, one file per task).
 *
 * The renderer builds its plan card from the live TaskCreate/TaskUpdate events,
 * which only describe CHANGES — so anything that happens while the app isn't
 * listening (it was closed, the machine restarted, the session was resumed
 * later) leaves the card frozen at an old snapshot while the agent keeps
 * working. The CLI's folder is the actual source of truth, so we read it and
 * watch it: the card then reflects the real progress no matter what was missed.
 */

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed'])

/** Root of the CLI's config folder — honours CLAUDE_CONFIG_DIR like the CLI does. */
function claudeHome(): string {
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim()
  return custom ? custom : join(homedir(), '.claude')
}

export function sessionTasksDir(sessionId: string, root = claudeHome()): string {
  return join(root, 'tasks', sessionId)
}

/** Numeric-aware ordering: the CLI names tasks "1", "2", … "10" — plain string
 *  sort would put 10 before 2 and scramble the plan. */
function byTaskId(a: TaskItem, b: TaskItem): number {
  const na = Number(a.id)
  const nb = Number(b.id)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.id.localeCompare(b.id)
}

/**
 * Read every task of a session. Returns `null` when the folder doesn't exist —
 * "this session never used tasks", which must NOT be confused with "the plan is
 * empty now" (that would wipe a plan built from the legacy TodoWrite path).
 * Individual files that are missing/half-written/invalid are skipped: the CLI
 * writes them while we may be reading.
 */
export function readSessionTasks(sessionId: string, root = claudeHome()): TaskItem[] | null {
  const dir = sessionTasksDir(sessionId, root)
  if (!sessionId || !existsSync(dir)) return null
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    return null
  }
  const items: TaskItem[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
      const id = typeof raw.id === 'string' ? raw.id : file.replace(/\.json$/i, '')
      const subject = raw.subject
      const status = raw.status
      if (typeof subject !== 'string' || typeof status !== 'string' || !VALID_STATUS.has(status)) continue
      items.push({
        id,
        content: subject,
        status: status as TaskItem['status'],
        activeForm: typeof raw.activeForm === 'string' && raw.activeForm ? raw.activeForm : subject
      })
    } catch {
      /* half-written or corrupt file — skip it, the watcher fires again on the next write */
    }
  }
  return items.sort(byTaskId)
}

/**
 * Watch a session's task folder and call `onChange` with the full list on every
 * change (debounced — the CLI rewrites several files in a burst). Returns a
 * disposer; safe to call even when the folder doesn't exist yet, in which case
 * the parent `tasks/` folder is watched until the session's folder appears.
 */
export function watchSessionTasks(
  sessionId: string,
  onChange: (items: TaskItem[]) => void,
  root = claudeHome()
): () => void {
  if (!sessionId) return () => {}
  const dir = sessionTasksDir(sessionId, root)
  const parent = join(root, 'tasks')
  let watcher: FSWatcher | null = null
  let parentWatcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      const items = readSessionTasks(sessionId, root)
      if (items) onChange(items)
    }, 250)
  }

  const watchDir = (): boolean => {
    if (watcher || !existsSync(dir)) return false
    try {
      watcher = watch(dir, fire)
      watcher.on('error', () => {})
      return true
    } catch {
      return false
    }
  }

  if (!watchDir() && existsSync(parent)) {
    // The folder is only created on the session's first TaskCreate — wait for it.
    try {
      parentWatcher = watch(parent, () => {
        if (watchDir()) {
          parentWatcher?.close()
          parentWatcher = null
          fire()
        }
      })
      parentWatcher.on('error', () => {})
    } catch {
      /* no watcher — the per-turn snapshot still keeps the card in sync */
    }
  }

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    watcher?.close()
    parentWatcher?.close()
  }
}
