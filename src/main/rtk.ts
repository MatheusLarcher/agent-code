import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The `rtk` proxy used by the economy mode is a native binary, not an npm dep.
 * It is normally installed per-user (and put on the user PATH), but a PATH
 * change only reaches processes started AFTER it — the running app would need a
 * restart to see it. So the session resolves the install directory itself and
 * prepends it to the subprocess PATH.
 *
 * Returns null when the binary is not installed; the caller then leaves PATH
 * untouched and the `rtk` skill degrades on its own (it tells the model to run
 * commands normally and warn the user).
 */
export function rtkBinDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
  const candidates: string[] = []
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'rtk'))
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, 'rtk'))
  } else {
    if (env.HOME) candidates.push(join(env.HOME, '.local', 'bin'))
    candidates.push('/usr/local/bin', '/opt/homebrew/bin')
  }
  // A directory already on PATH is still worth returning: prepending it is a
  // no-op, and it keeps a custom install location working.
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(dir)
  }
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, exe))) return dir
    } catch {
      // Unreadable candidate (permissions, dead drive letter) — just skip it.
    }
  }
  return null
}

/**
 * PATH with the rtk directory in front, or null when nothing should change
 * (binary missing, or already the first entry).
 */
export function pathWithRtk(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = rtkBinDir(env)
  if (!dir) return null
  const current = env.PATH ?? ''
  const entries = current.split(delimiter)
  if (entries[0] === dir) return null
  return [dir, ...entries.filter((entry) => entry !== dir)].join(delimiter)
}
