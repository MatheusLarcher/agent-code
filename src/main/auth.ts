// Claude Code authentication state. We ask the CLI itself — `claude auth status
// --json` — instead of reading ~/.claude/.credentials.json, because that file is
// NOT the source of truth: on Windows the OAuth token lives in the Credential
// Manager (keychain), so the file can be absent/stale even when the user is logged
// in. `auth status` reads whichever store the platform uses, so it's authoritative
// and cross-platform. Token refresh is the CLI's job — a logged-in answer is enough.
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCliPath } from './claudeCli'

/** What `claude auth status --json` reports about the saved login. */
export interface ClaudeAuthStatus {
  loggedIn: boolean
  authMethod: string
  /** E-mail e plano da conta logada, quando o CLI informa. Nunca o token. */
  email?: string
  subscriptionType?: string
}

/** Env do CLI para uma pasta de login específica (conta Claude), ou o herdado. */
export function envForConfigDir(configDir?: string): NodeJS.ProcessEnv {
  return configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env }
}

/**
 * Ask the CLI for the saved login. Any failure (CLI missing, invalid JSON) is
 * reported as logged-out with `authMethod: 'none'` — the same shape the CLI uses.
 * `configDir` asks about one account's login folder instead of the machine's.
 */
export function claudeAuthStatus(configDir?: string): Promise<ClaudeAuthStatus> {
  return claudeAuthProbe(configDir).then((r) => r ?? { loggedIn: false, authMethod: 'none' })
}

/**
 * Como `claudeAuthStatus`, mas sem achatar a dúvida: `null` quando nenhuma
 * tentativa respondeu um JSON válido (checagem indeterminada, não "deslogado").
 */
export function claudeAuthProbe(configDir?: string): Promise<ClaudeAuthStatus | null> {
  // Uma falha de execução (timeout no 1º uso de um claude.exe recém-instalado,
  // enquanto o antivírus o examina) não é "deslogado": tenta de novo, com folga.
  return queryAuthStatus(configDir, 15_000).then((r) => r ?? queryAuthStatus(configDir, 45_000))
}

/** Uma consulta ao CLI; `null` quando ela não respondeu um JSON válido. */
function queryAuthStatus(configDir: string | undefined, timeout: number): Promise<ClaudeAuthStatus | null> {
  return new Promise((resolve) => {
    let cli: string
    try {
      cli = claudeCliPath()
    } catch {
      resolve({ loggedIn: false, authMethod: 'none' })
      return
    }
    execFile(
      cli,
      ['auth', 'status', '--json'],
      { cwd: homedir(), windowsHide: true, timeout, env: envForConfigDir(configDir) },
      (_err, stdout) => {
        try {
          const data = JSON.parse(String(stdout)) as {
            loggedIn?: boolean
            authMethod?: string
            email?: unknown
            subscriptionType?: unknown
          }
          resolve({
            loggedIn: data.loggedIn === true,
            authMethod: typeof data.authMethod === 'string' ? data.authMethod : 'none',
            ...(typeof data.email === 'string' && data.email ? { email: data.email } : {}),
            ...(typeof data.subscriptionType === 'string' && data.subscriptionType
              ? { subscriptionType: data.subscriptionType }
              : {})
          })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** True when a Claude OAuth login exists (per the CLI's own status check). */
export async function isAuthenticated(configDir?: string): Promise<boolean> {
  return (await claudeAuthStatus(configDir)).loggedIn
}

/**
 * Caches that survive `auth logout` and can make the next login reuse the old
 * account/connectors. Cleared on account switch; each is optional, so a missing
 * path is a no-op (`rm` with `force`).
 */
function staleAuthCachePaths(): string[] {
  const paths = [join(homedir(), '.claude', 'cache')]
  const appData = process.env.APPDATA
  if (appData) paths.push(join(appData, 'Claude', 'mcp-needs-auth-cache.json'))
  return paths
}

/**
 * Erase the Claude login: run `auth logout`, delete the stale auth caches, then
 * VERIFY with the CLI. Returns the post-logout status so the caller only offers a
 * new login when the machine is really signed out (`{loggedIn:false, authMethod:'none'}`).
 */
export async function logoutClaude(): Promise<ClaudeAuthStatus> {
  await new Promise<void>((resolve) => {
    let cli: string
    try { cli = claudeCliPath() } catch { resolve(); return }
    execFile(cli, ['auth', 'logout'], { cwd: homedir(), windowsHide: true, timeout: 15_000 }, () => resolve())
  })
  // Best-effort: a locked/undeletable cache must not block the account switch.
  await Promise.all(
    staleAuthCachePaths().map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined))
  )
  return await claudeAuthStatus()
}
