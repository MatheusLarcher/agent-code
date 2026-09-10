import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppRestartCoordinator } from './appRestart'

/** Name is part of the contract with `scripts/relaunch-agent-code.ps1`. */
export const RESTART_GUARD_FILENAME = 'restart-guard.json'
/** How often the snapshot is refreshed. The script treats an older file as unknown. */
export const RESTART_GUARD_INTERVAL_MS = 2_000

/**
 * Publishes "is any agent busy right now?" to disk so a restarter script can
 * check it without guessing. The app is the only authority on that question —
 * a script can see processes, never conversations.
 *
 * Written on a timer (not only on change) because the file doubles as a
 * heartbeat: if the app dies or hangs, the timestamp stops advancing and the
 * script refuses to act on a stale answer instead of assuming "idle".
 */
export function startRestartGuardFile(
  coordinator: Pick<AppRestartCoordinator, 'status'>,
  directory: string,
  intervalMs = RESTART_GUARD_INTERVAL_MS
): () => void {
  const path = join(directory, RESTART_GUARD_FILENAME)
  const write = (): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      // Temp + rename: the script must never read a half-written snapshot.
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify(coordinator.status()), 'utf8')
      renameSync(temporary, path)
    } catch {
      /* Diagnostic file only: never break the app over it. */
    }
  }
  write()
  const timer = setInterval(write, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    // Remove on shutdown: a leftover "idle" snapshot from a dead app would be
    // the exact stale answer this file exists to avoid.
    try { unlinkSync(path) } catch { /* already gone */ }
  }
}
