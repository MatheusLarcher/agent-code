// Claude Code authentication state. We ask the CLI itself — `claude auth status
// --json` — instead of reading ~/.claude/.credentials.json, because that file is
// NOT the source of truth: on Windows the OAuth token lives in the Credential
// Manager (keychain), so the file can be absent/stale even when the user is logged
// in. `auth status` reads whichever store the platform uses, so it's authoritative
// and cross-platform. Token refresh is the CLI's job — a logged-in answer is enough.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { claudeCliPath } from './claudeCli'

/** True when a Claude OAuth login exists (per the CLI's own status check). */
export function isAuthenticated(): Promise<boolean> {
  return new Promise((resolve) => {
    let cli: string
    try {
      cli = claudeCliPath()
    } catch {
      resolve(false)
      return
    }
    execFile(
      cli,
      ['auth', 'status', '--json'],
      { cwd: homedir(), windowsHide: true, timeout: 15_000 },
      (_err, stdout) => {
        try {
          const data = JSON.parse(String(stdout)) as { loggedIn?: boolean }
          resolve(data.loggedIn === true)
        } catch {
          resolve(false)
        }
      }
    )
  })
}
