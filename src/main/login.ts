// Drives the Claude Code OAuth login WITHOUT the user typing /login, by spawning
// the CLI's own `claude auth login` subcommand. (The headless SDK query() loop runs
// in --print mode and can't perform the interactive OAuth flow — that's why the old
// approach never opened a browser.) The CLI opens the system browser and runs a
// localhost loopback to capture the code; we ALSO open the URL we scrape from its
// output, so the browser opens reliably even when the CLI is launched from the GUI.
// Completion is confirmed via `auth status` (creds may land in the keychain, not a
// file), so the chat session then starts already authenticated.
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { envForConfigDir, isAuthenticated } from './auth'
import { claudeCliPath } from './claudeCli'

const URL_RE = /(https?:\/\/[^\s"')]+)/gi
const LOGIN_TIMEOUT_MS = 180_000 // 3 min for the user to authenticate in the browser

// Only one interactive login runs at a time — concurrent "Conectar" clicks (or
// multiple conversations connecting at once) share the same in-flight attempt
// instead of spawning several `auth login` processes.
let inFlight: Promise<boolean> | null = null
// Pasta de login do login em andamento (undefined = a da máquina). Um pedido
// para OUTRA conta não pode "entrar" no login em andamento: ele logaria a pasta errada.
let inFlightDir: string | undefined

/** True while an interactive login runs for a different login folder. */
export function claudeLoginBusyFor(configDir?: string): boolean {
  return inFlight !== null && inFlightDir !== configDir
}

/**
 * Run the login flow. `openUrl` gets the OAuth URL to open in the SYSTEM browser;
 * `log` receives diagnostic lines. Resolves true once the CLI reports a login.
 * `configDir` logs in one Claude account's own folder (CLAUDE_CONFIG_DIR);
 * without it, the machine's login — as before multiple accounts existed.
 */
export function runClaudeLogin(
  openUrl: (url: string) => void,
  log: (line: string) => void,
  configDir?: string
): Promise<boolean> {
  if (inFlight) {
    if (inFlightDir !== configDir) {
      log('another account login is in progress — refusing')
      return Promise.resolve(false)
    }
    log('login already in progress — joining it')
    return inFlight
  }
  inFlightDir = configDir
  inFlight = doLogin(openUrl, log, configDir).finally(() => {
    inFlight = null
    inFlightDir = undefined
  })
  return inFlight
}

async function doLogin(openUrl: (url: string) => void, log: (line: string) => void, configDir?: string): Promise<boolean> {
  const loggedIn = (): Promise<boolean> => isAuthenticated(configDir)
  if (await loggedIn()) return true

  let cli: string
  try {
    cli = claudeCliPath()
  } catch (err) {
    log(`cannot find Claude CLI: ${String(err)}`)
    return false
  }

  log(`spawning: ${cli} auth login --claudeai`)
  return await new Promise<boolean>((resolve) => {
    let child: ChildProcess
    try {
      // stdin 'ignore' => the CLI sees a non-interactive session and relies on the
      // loopback callback (no "paste the code" prompt that we couldn't answer).
      child = spawn(cli, ['auth', 'login', '--claudeai'], {
        cwd: homedir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: envForConfigDir(configDir)
      })
    } catch (err) {
      log(`spawn threw: ${String(err)}`)
      resolve(false)
      return
    }

    let done = false
    let opened = false
    let checking = false

    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already exited */
      }
      resolve(ok)
    }

    // Re-check the CLI's auth status without overlapping spawns; finish on success.
    const checkStatus = (): void => {
      if (checking || done) return
      checking = true
      void loggedIn().then((ok) => {
        checking = false
        if (ok) {
          log('auth status: logged in')
          finish(true)
        }
      })
    }

    const scan = (buf: Buffer): void => {
      const text = buf.toString()
      log(`out: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
      // Open the first claude.ai/anthropic OAuth URL we see in the system browser,
      // guaranteeing the browser opens even if the CLI's own auto-open didn't fire.
      if (!opened) {
        const url = (text.match(URL_RE) ?? []).find((u) => /claude\.ai|anthropic\.com|\/oauth|authorize/i.test(u))
        if (url) {
          opened = true
          log(`opening system browser: ${url}`)
          openUrl(url)
        }
      }
      // The CLI may print "Login successful" then wait for [Enter] (which we can't
      // send headless) — so confirm via status rather than waiting for it to exit.
      if (/login successful/i.test(text)) {
        log('saw "Login successful"')
        checkStatus()
      }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)

    child.on('error', (err) => {
      log(`child error: ${String(err)}`)
      finish(false)
    })
    child.on('exit', (code) => {
      log(`child exit: ${code}`)
      void loggedIn().then((ok) => finish(ok))
    })

    // Backstop poll: the authoritative signal is the CLI's status flipping to
    // logged-in, in case we miss the stdout marker.
    const poll = setInterval(checkStatus, 2500)
    const timer = setTimeout(() => {
      log('timeout (3 min) — giving up')
      void loggedIn().then((ok) => finish(ok))
    }, LOGIN_TIMEOUT_MS)
  })
}
