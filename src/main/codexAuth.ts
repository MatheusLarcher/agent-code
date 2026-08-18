// OpenAI Codex OAuth login — lets the app charge model calls to the user's
// ChatGPT Plus/Pro/Team SUBSCRIPTION instead of a pay-per-use API key. This
// mirrors exactly what the official Codex CLI does when you run `codex login`:
// same fixed client_id, same loopback redirect URI/port, same PKCE flow. The
// token this produces is NOT a normal OpenAI API key — it only works against
// the Codex backend (see codexProxy.ts), and OpenAI can revoke/break this at
// any time since it's an undocumented, reverse-engineered surface (accepted
// risk — see the "OpenAI (Codex)" section of docs/ARQUITETURA.md).
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { safeStorage } from 'electron'
import { kvGet, kvSet } from './store'

// Same client_id the official Rust Codex CLI uses — the backend's `originator`
// allowlist (see codexProxy.ts) is keyed off the traffic looking like that
// client, so this can't be swapped for an app-specific id.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CALLBACK_PORT = 1455
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`
const SCOPES = 'openid profile email offline_access'
const KV_KEY = 'codexAuth'
const LOGIN_TIMEOUT_MS = 180_000
// Refresh this long before actual expiry so an in-flight request never races
// a token that dies mid-call.
const REFRESH_SKEW_MS = 5 * 60_000

export interface CodexTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  /** `chatgpt-account-id` claim — required header on every Codex backend call. */
  accountId: string
  email?: string
  planType?: string
  /** Epoch ms. */
  expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function requiredString(value: unknown, field: string): string {
  if (!nonEmptyString(value)) throw new Error(`Invalid Codex OAuth ${field}`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!nonEmptyString(value)) throw new Error(`Invalid Codex OAuth ${field}`)
  return value
}

function validateStoredTokens(value: unknown): CodexTokens | null {
  if (!isRecord(value)) return null
  if (
    !nonEmptyString(value.accessToken) ||
    !nonEmptyString(value.refreshToken) ||
    !nonEmptyString(value.idToken) ||
    !nonEmptyString(value.accountId) ||
    !positiveFiniteNumber(value.expiresAt)
  ) {
    return null
  }
  if (value.email !== undefined && !nonEmptyString(value.email)) return null
  if (value.planType !== undefined && !nonEmptyString(value.planType)) return null
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    idToken: value.idToken,
    accountId: value.accountId,
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
    ...(typeof value.planType === 'string' ? { planType: value.planType } : {}),
    expiresAt: value.expiresAt
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function genPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1] ?? ''
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Pulls the ChatGPT account id + plan out of the id_token's custom claim —
 *  the same one the official CLI reads to build the `chatgpt-account-id` header. */
function claimsFromIdToken(idToken: string): { accountId: string; email?: string; planType?: string } {
  const claims = decodeJwt(idToken)
  const rawAuth = claims['https://api.openai.com/auth']
  const auth = isRecord(rawAuth) ? rawAuth : undefined
  const rawAccountId = auth?.['chatgpt_account_id']
  const accountId = nonEmptyString(rawAccountId) ? rawAccountId : ''
  const rawPlanType = auth?.['chatgpt_plan_type']
  const planType = nonEmptyString(rawPlanType) ? rawPlanType : undefined
  const rawEmail = claims['email']
  const email = nonEmptyString(rawEmail) ? rawEmail : undefined
  return { accountId, email, planType }
}

// ---- storage: encrypted at rest via Electron's safeStorage (Windows: DPAPI,
// same OS-level protection Credential Manager relies on). Fail closed: an
// unavailable/broken secure store must never downgrade OAuth tokens to plaintext.

function persist(tokens: CodexTokens): void {
  if (!validateStoredTokens(tokens)) throw new Error('Refusing to persist invalid Codex OAuth tokens')
  const json = JSON.stringify(tokens)
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure token storage is unavailable on this system')
  }
  const encrypted = safeStorage.encryptString(json)
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error('Secure token storage returned an invalid encrypted payload')
  }
  kvSet(KV_KEY, JSON.stringify({ enc: encrypted.toString('base64') }))
}

function loadTokens(): CodexTokens | null {
  const raw = kvGet(KV_KEY)
  if (!raw) return null
  try {
    const wrapper: unknown = JSON.parse(raw)
    if (!isRecord(wrapper) || !nonEmptyString(wrapper.enc)) return null
    const json = safeStorage.decryptString(Buffer.from(wrapper.enc, 'base64'))
    return validateStoredTokens(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}

/** Erases the saved Codex login. */
export function codexLogout(): void {
  invalidateRefreshes()
  kvSet(KV_KEY, JSON.stringify(null))
}

/** Status for the Settings screen — never exposes the tokens themselves. */
export function codexStatus(): { connected: boolean; accountId?: string; email?: string; planType?: string } {
  const cur = loadTokens()
  if (!cur) return { connected: false }
  return { connected: true, accountId: cur.accountId, email: cur.email, planType: cur.planType }
}

/** Cheap sync check used to decide whether to even try starting a GPT session. */
export function isCodexConnected(): boolean {
  return loadTokens() !== null
}

// ---- token exchange / refresh ----------------------------------------------

async function exchangeCode(code: string, verifier: string): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier
    })
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => '')}`)
  const data: unknown = await res.json()
  if (!isRecord(data)) throw new Error('Invalid Codex OAuth token response')
  const accessToken = requiredString(data.access_token, 'access_token')
  const refreshToken = requiredString(data.refresh_token, 'refresh_token')
  const idToken = requiredString(data.id_token, 'id_token')
  if (!positiveFiniteNumber(data.expires_in)) throw new Error('Invalid Codex OAuth expires_in')
  const { accountId, email, planType } = claimsFromIdToken(idToken)
  if (!accountId) throw new Error('Codex OAuth token is missing chatgpt_account_id')
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    email,
    planType,
    expiresAt: Date.now() + data.expires_in * 1000
  }
}

/** Refreshes against the saved refresh_token. Returns null if there's nothing
 *  to refresh or the refresh itself was rejected (caller should treat that as
 *  "logged out" and prompt the user to log in again). */
let refreshInFlight: Promise<CodexTokens | null> | null = null
let authGeneration = 0

/** A logout or successful interactive login creates a new credential boundary.
 * Refreshes started on the previous boundary may still finish at the network
 * layer, but must neither mutate storage nor return those stale credentials. */
function invalidateRefreshes(): void {
  authGeneration += 1
  refreshInFlight = null
}

function refreshStillOwnsCredentials(generation: number, original: CodexTokens): boolean {
  if (generation !== authGeneration) return false
  const current = loadTokens()
  return current?.accountId === original.accountId && current.refreshToken === original.refreshToken
}

async function doRefreshCodexTokens(): Promise<CodexTokens | null> {
  const generation = authGeneration
  const cur = loadTokens()
  if (!cur?.refreshToken) return null
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: cur.refreshToken,
      client_id: CLIENT_ID
    })
  })
  if (!refreshStillOwnsCredentials(generation, cur)) return null
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) codexLogout()
    return null
  }
  const data: unknown = await res.json()
  if (!refreshStillOwnsCredentials(generation, cur)) return null
  if (!isRecord(data)) throw new Error('Invalid Codex OAuth refresh response')
  const accessToken = requiredString(data.access_token, 'access_token')
  const refreshToken = optionalString(data.refresh_token, 'refresh_token') ?? cur.refreshToken
  const idToken = optionalString(data.id_token, 'id_token') ?? cur.idToken
  if (!positiveFiniteNumber(data.expires_in)) throw new Error('Invalid Codex OAuth expires_in')
  const claims = data.id_token === undefined ? undefined : claimsFromIdToken(idToken)
  if (claims && !claims.accountId) throw new Error('Refreshed Codex OAuth token is missing chatgpt_account_id')
  if (claims?.accountId && claims.accountId !== cur.accountId) {
    throw new Error('Refreshed Codex OAuth token belongs to a different ChatGPT account')
  }
  const next: CodexTokens = {
    accessToken,
    refreshToken,
    idToken,
    accountId: claims?.accountId ?? cur.accountId,
    email: claims?.email ?? cur.email,
    planType: claims?.planType ?? cur.planType,
    expiresAt: Date.now() + data.expires_in * 1000
  }
  if (!refreshStillOwnsCredentials(generation, cur)) return null
  persist(next)
  return next
}

export function refreshCodexTokens(): Promise<CodexTokens | null> {
  if (refreshInFlight) return refreshInFlight
  let task: Promise<CodexTokens | null>
  task = doRefreshCodexTokens().finally(() => {
    // A logout/new login may already have detached this stale promise and let a
    // refresh for the new credentials start. Never clear that newer operation.
    if (refreshInFlight === task) refreshInFlight = null
  })
  refreshInFlight = task
  return task
}

/** Atomically decides whether a 401 still belongs to the stored access token.
 * There is deliberately no await between loadTokens() and joining/starting the
 * refresh mutex, so a staggered request cannot rotate an already-renewed token. */
export function refreshCodexTokensAfter(failedAccessToken: string): Promise<CodexTokens | null> {
  const current = loadTokens()
  if (!current) return Promise.resolve(null)
  if (current.accessToken !== failedAccessToken) return Promise.resolve(current)
  return refreshCodexTokens()
}

/** The access token to use right now — refreshes first if it's about to expire.
 *  Returns null for no login or a rejected refresh; malformed provider data and
 *  transport/storage failures remain explicit errors for the caller to surface. */
export async function getValidCodexTokens(): Promise<CodexTokens | null> {
  const cur = loadTokens()
  if (!cur) return null
  if (Date.now() < cur.expiresAt - REFRESH_SKEW_MS) return cur
  return refreshCodexTokens()
}

// ---- interactive login (PKCE + loopback callback) --------------------------

let inFlight: Promise<{ ok: boolean; message?: string }> | null = null

/** Runs the OAuth login. `openUrl` gets the authorize URL to open in the
 *  SYSTEM browser (same product decision as the Claude login). Resolves once
 *  the callback lands and tokens are exchanged + persisted. */
export function runCodexLogin(
  openUrl: (url: string) => void,
  log: (line: string) => void
): Promise<{ ok: boolean; message?: string }> {
  if (inFlight) {
    log('codex login already in progress — joining it')
    return inFlight
  }
  inFlight = doLogin(openUrl, log).finally(() => {
    inFlight = null
  })
  return inFlight
}

function doLogin(openUrl: (url: string) => void, log: (line: string) => void): Promise<{ ok: boolean; message?: string }> {
  const { verifier, challenge } = genPkce()
  const state = base64url(randomBytes(16))

  return new Promise((resolve) => {
    let server: Server | null = null
    let settled = false
    let callbackStarted = false

    const finish = (ok: boolean, message?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server?.close()
      resolve({ ok, message })
    }

    server = createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/auth/callback')) {
        res.writeHead(404).end()
        return
      }
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)
      const returnedState = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('Callback inválido.')
        return
      }
      if (err) {
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body>Login cancelado. Pode fechar esta aba.</body></html>')
        log(`codex login: provider returned error=${err}`)
        finish(false, err)
        return
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('Callback inválido.')
        return
      }
      if (callbackStarted) {
        res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' }).end('Callback já está sendo processado.')
        return
      }
      callbackStarted = true

      void (async () => {
        try {
          const tokens = await exchangeCode(code, verifier)
          if (settled) return
          persist(tokens)
          invalidateRefreshes()
          res
            .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<html><body>Login com o ChatGPT concluído. Pode fechar esta aba.</body></html>')
          log(`codex login ok — account=${tokens.accountId || '(sem id)'} plan=${tokens.planType ?? '?'}`)
          finish(true)
        } catch (e) {
          if (settled) return
          res
            .writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<html><body>Login com o ChatGPT não foi concluído. Pode fechar esta aba e tentar novamente.</body></html>')
          log(`codex token exchange failed: ${String(e)}`)
          finish(false, String(e))
        }
      })()
    })

    server.on('error', (e) => {
      log(`codex callback server error: ${String(e)}`)
      finish(false, String(e))
    })

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      const authorizeUrl = new URL(AUTHORIZE_URL)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('client_id', CLIENT_ID)
      authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
      authorizeUrl.searchParams.set('scope', SCOPES)
      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      authorizeUrl.searchParams.set('state', state)
      log(`opening system browser: ${authorizeUrl.toString()}`)
      openUrl(authorizeUrl.toString())
    })

    const timer = setTimeout(() => {
      log('codex login timeout (3 min) — giving up')
      finish(false, 'timeout')
    }, LOGIN_TIMEOUT_MS)
  })
}
