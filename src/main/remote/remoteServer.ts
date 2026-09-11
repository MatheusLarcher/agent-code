import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize, sep } from 'node:path'
import { canonicalPath, downloadablesFromEvent, downloadablesFromMessages } from '../downloadAllowlist'
import type {
  ChatEvent,
  FileAttachment,
  ImageAttachment,
  PermissionResponse,
  RemoteConversation,
  RemoteConversationAction,
  RemoteInfo,
  RemotePairedDevice,
  RemoteStatePayload
} from '../../shared/ipc'

/**
 * LAN bridge that lets a phone drive the same Claude Code sessions running on
 * the PC: the phone POSTs commands (forwarded to the renderer, which dispatches
 * them into the matching conversation) and receives live agent events over SSE.
 *
 * Network-only for now (same Wi‑Fi). The transport is deliberately plain HTTP +
 * Server‑Sent Events (no native deps) so a broker/relay can replace it later
 * without touching the rest of the app.
 */

export interface RemoteServerDeps {
  /** A phone sent a command — dispatch it into its conversation (phone → PC → agent). */
  onInbound: (convId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => void
  /** A phone asked to stop the running turn of a conversation. */
  onInterrupt?: (convId: string) => void
  /** A phone toggled a per-conversation mode (economy / loop / fast). */
  onSetMode?: (convId: string, mode: 'economy' | 'loop' | 'fast', on: boolean) => void
  /** A phone managed conversations: create in a project, rename, delete. */
  onConversationAction?: (action: RemoteConversationAction) => void
  /** Read / persist the single paired phone (per installation, never synced). */
  loadPairedDevice?: () => RemotePairedDevice | null
  savePairedDevice?: (device: RemotePairedDevice | null) => void
  /** Absolute path to the built APK served at /download (may not exist yet). */
  apkPath: () => string
  /** Absolute path to the bundled web client served at /app (browser fallback). */
  wwwDir: () => string
  /** Called whenever the connected‑phone count changes (for the PC UI). */
  onClientsChanged?: (info: RemoteInfo) => void
  /** Read the persisted pairing token (empty if none yet — one is generated and saved). */
  loadToken?: () => string
  /** Persist a freshly generated pairing token so it stays fixed across sessions. */
  saveToken?: (token: string) => void | Promise<void>
  /** Transcribe phone audio on the PC (OpenAI). Throws Error('no-key') if unset. */
  transcribe?: (audioBase64: string, mimeType: string) => Promise<string>
  /** Synthesize speech on the PC (OpenAI). Throws Error('no-key') if unset. */
  tts?: (text: string) => Promise<{ base64: string; mimeType: string }>
  /** Whether an OpenAI key is configured (gates the phone's voice buttons). */
  voiceReady?: () => boolean
  /** A phone toggled the global "Permitir tudo" switch — apply it on the PC. */
  onSetSkipPerms?: (on: boolean) => void
  /** A phone asked to change a conversation's model/effort — apply it on the PC. */
  onSetModel?: (convId: string, model?: string, effort?: string) => void
  /** A phone asked to retry or cancel a suspended turn. */
  onRecoveryAction?: (convId: string, action: 'retry' | 'cancel') => void
  /** A phone answered a pending permission/AskUserQuestion request — resolve it
   *  the same way the desktop IPC handler does. */
  onPermissionResponse?: (convId: string, res: PermissionResponse) => void
}

const DEFAULT_PORT = 8765
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const PRIVATE_IPV4 = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/
/** Virtual/host‑only adapters (emulador, WSL, Hyper‑V, VirtualBox, VMware, Docker…). */
const VIRTUAL_IFACE = /(vethernet|virtualbox|vmware|hyper-v|loopback|wsl|docker|vethernet \(default switch\)|vmnet|nat|tunnel|tap|tailscale|zerotier|radmin|hamachi)/i

/** Source IPv4 the OS would use to reach the internet — picks the iface with the default route. */
function routedLanIp(): Promise<string> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    const done = (ip: string): void => {
      try {
        sock.close()
      } catch {
        /* already closed */
      }
      resolve(ip)
    }
    sock.once('error', () => done(''))
    // No packet is actually sent — connect() just makes the kernel resolve the source address.
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          done(sock.address().address || '')
        } catch {
          done('')
        }
      })
    } catch {
      done('')
    }
    setTimeout(() => done(''), 500)
  })
}

/** Fallback scan: first non‑internal private IPv4, skipping known virtual adapters. */
function scanLanIp(): string {
  const ifaces = networkInterfaces()
  const real: string[] = []
  const virt: string[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    const isVirtual = VIRTUAL_IFACE.test(name)
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      ;(isVirtual ? virt : real).push(ni.address)
    }
  }
  const pick = (arr: string[]): string | undefined => arr.find((a) => PRIVATE_IPV4.test(a))
  return pick(real) ?? real[0] ?? pick(virt) ?? virt[0] ?? ''
}

/** Best‑effort LAN IPv4: route‑based first (most reliable with virtual adapters), then iface scan. */
async function lanIp(): Promise<string> {
  const routed = await routedLanIp()
  if (routed && !routed.startsWith('127.')) return routed
  return scanLanIp()
}

export class RemoteServer {
  private server: Server | null = null
  private port = DEFAULT_PORT
  private token = ''
  private ip = ''
  private state: RemoteStatePayload = { conversations: [] }
  private clients = new Set<ServerResponse>()
  private keepAlive: ReturnType<typeof setInterval> | null = null
  /** Whether the PC is connected to the VPS broker (set by the RelayClient). */
  private relayConnected = false
  private relayState: RemoteInfo['relayState'] = 'off'
  /** The one phone paired with this PC (null = none yet; first phone to call pairs). */
  private pairedDevice: RemotePairedDevice | null = null
  /** Phone id explicitly unpaired from the PC UI; barred from implicit re-pairing. */
  private unpairedId: string | null = null
  /** Downloadable paths seen live via `broadcast()`, independent of `setState()`.
   *  `setState()` comes from the renderer (a round-trip after it processes the
   *  same event), so a phone that taps "Baixar" the instant the button appears
   *  could 403 before that round-trip lands — this set closes that race by
   *  authorizing the path the moment the event is teed to the phone, in main,
   *  with no renderer dependency. Additive across the server's lifetime (never
   *  cleared): once a file is offered, it stays downloadable. */
  private liveDownloadable = new Set<string>()

  constructor(private readonly deps: RemoteServerDeps) {}

  info(): RemoteInfo {
    const running = this.server !== null
    return {
      running,
      ip: this.ip,
      port: this.port,
      token: this.token,
      clients: this.clients.size,
      relayConnected: this.relayConnected,
      relayState: this.relayState,
      pairedDevice: this.pairedDevice ?? undefined,
      url: running && this.ip ? `http://${this.ip}:${this.port}/?token=${this.token}` : ''
    }
  }

  /** Update broker-connection status (from the RelayClient) and notify the UI. */
  setRelayConnected(connected: boolean, state?: RemoteInfo['relayState']): void {
    const nextState = state ?? (connected ? 'connected' : 'connecting')
    if (this.relayConnected === connected && this.relayState === nextState) return
    this.relayConnected = connected
    this.relayState = nextState
    this.deps.onClientsChanged?.(this.info())
  }

  /** Forget the paired phone: the next phone to scan the QR becomes the one.
   *  The old phone keeps polling every few seconds, so it would silently
   *  re-pair itself through the implicit first-caller rule — remember its id and
   *  refuse it until an explicit `/api/pair` (a new QR scan) happens. */
  unpair(): void {
    this.unpairedId = this.pairedDevice?.id ?? null
    this.setPaired(null)
    for (const c of this.clients) c.end()
    this.clients.clear()
    this.notifyClients()
  }

  private setPaired(device: RemotePairedDevice | null): void {
    this.pairedDevice = device
    this.deps.savePairedDevice?.(device)
  }

  /** Start listening (idempotent — returns current info if already running). */
  async start(): Promise<RemoteInfo> {
    if (this.server) return this.info()
    this.ip = await lanIp()
    // Fixed token: reuse the persisted one so a paired phone stays paired across
    // restarts; generate + save once on first ever start.
    const saved = this.deps.loadToken?.() ?? ''
    if (saved) {
      this.token = saved
    } else {
      this.token = randomBytes(16).toString('hex')
      await this.deps.saveToken?.(this.token)
    }
    this.pairedDevice = this.deps.loadPairedDevice?.() ?? null
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(`internal error: ${String(err)}`)
      })
    })
    await listenWithFallback(server, DEFAULT_PORT, 20).then((p) => (this.port = p))
    this.server = server
    // Comment pings keep proxies/Android from dropping idle SSE connections.
    this.keepAlive = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n')
    }, 25_000)
    this.notifyClients() // flips the PC UI to "ligada"
    return this.info()
  }

  async stop(): Promise<RemoteInfo> {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    for (const c of this.clients) c.end()
    this.clients.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((r) => server.close(() => r()))
    this.notifyClients()
    return this.info()
  }

  /** Push a live agent event to every connected phone (tee from the main process). */
  broadcast(convId: string, event: ChatEvent): void {
    this.trackDownloadable(event)
    if (!this.clients.size) return
    const line = `data: ${JSON.stringify({ convId, event })}\n\n`
    for (const c of this.clients) c.write(line)
  }

  /** Mirrors `downloadablePaths()`'s two sources, but runs synchronously as each
   *  event is teed to the phone — no renderer round-trip in the loop. */
  private trackDownloadable(event: ChatEvent): void {
    for (const p of downloadablesFromEvent(event)) this.liveDownloadable.add(canonicalPath(p))
  }

  /** Replace the served conversation snapshot (renderer is the source of truth). */
  setState(state: RemoteStatePayload): void {
    this.state = state
  }

  // ---- internals ----

  private notifyClients(): void {
    this.deps.onClientsChanged?.(this.info())
  }

  private authed(_req: IncomingMessage, url: URL): boolean {
    return url.searchParams.get('token') === this.token && this.token !== ''
  }

  /**
   * One phone per PC. Every /api call carries the phone's device id (`dev`).
   *  - no phone paired yet → the first one to call becomes the paired phone;
   *  - same id → ok;
   *  - different id → 409 (`another-device`), except `POST /api/pair`, which is
   *    the explicit act of scanning the QR / typing the address and TAKES OVER.
   * Calls without `dev` (older clients, tests) are still accepted.
   */
  private deviceAllowed(url: URL, path: string, method: string | undefined): 'ok' | 'another-device' {
    const dev = (url.searchParams.get('dev') ?? '').trim()
    if (!dev) return 'ok'
    if (path === '/api/pair' && method === 'POST') return 'ok'
    if (!this.pairedDevice) {
      if (dev === this.unpairedId) return 'another-device'
      this.setPaired({ id: dev, name: (url.searchParams.get('devname') ?? '').trim() || 'celular', pairedAt: Date.now() })
      this.notifyClients()
      return 'ok'
    }
    return this.pairedDevice.id === dev ? 'ok' : 'another-device'
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Permissive CORS so the Capacitor WebView (custom scheme origin) can call us.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Public (no token) — reachable straight from a scanned QR / browser.
    if (path === '/' || path === '') return this.serveLanding(res)
    if (path === '/download') return this.serveApk(res)
    if (path === '/app' || path.startsWith('/app/')) return this.serveWww(path, res)

    // API (token required).
    if (path.startsWith('/api/')) {
      if (!this.authed(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'token inválido' }))
        return
      }
      if (this.deviceAllowed(url, path, req.method) === 'another-device') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'another-device', pairedName: this.pairedDevice?.name ?? 'outro celular' }))
        return
      }
      if (path === '/api/state') return this.serveState(res)
      if (path === '/api/pair' && req.method === 'POST') return this.servePair(req, url, res)
      if (path === '/api/interrupt' && req.method === 'POST') return this.serveInterrupt(req, res)
      if (path === '/api/set-mode' && req.method === 'POST') return this.serveSetMode(req, res)
      if (path === '/api/conversation' && req.method === 'POST') return this.serveConversationAction(req, res)
      if (path === '/api/skip-perms' && req.method === 'POST') return this.serveSetSkipPerms(req, res)
      if (path === '/api/set-model' && req.method === 'POST') return this.serveSetModel(req, res)
      if (path === '/api/recovery' && req.method === 'POST') return this.serveRecovery(req, res)
      if (path === '/api/permission-respond' && req.method === 'POST') return this.servePermissionRespond(req, res)
      if (path === '/api/search') return this.serveSearch(url, res)
      if (path === '/api/history') return this.serveHistory(url, res)
      if (path === '/api/history-window') return this.serveHistoryWindow(url, res)
      if (path === '/api/events') return this.serveEvents(req, res)
      if (path === '/api/send' && req.method === 'POST') return this.serveSend(req, res)
      if (path === '/api/transcribe' && req.method === 'POST') return this.serveTranscribe(req, res)
      if (path === '/api/tts' && req.method === 'POST') return this.serveTts(req, res)
      if (path === '/api/file') return this.serveFile(url, res)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rota desconhecida' }))
      return
    }

    res.writeHead(404)
    res.end('not found')
  }

  private serveLanding(res: ServerResponse): void {
    const i = this.info()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(landingHtml(i))
  }

  private async serveApk(res: ServerResponse): Promise<void> {
    const apk = this.deps.apkPath()
    try {
      const s = await stat(apk)
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': String(s.size),
        'Content-Disposition': 'attachment; filename="agent-remote.apk"'
      })
      createReadStream(apk).pipe(res)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<h1>APK ainda não gerado</h1><p>No PC, abra o painel "📱 Android" e clique em ' +
          '"Gerar APK". Enquanto isso, você pode usar o cliente web em <a href="/app/">/app</a>.</p>'
      )
    }
  }

  private async serveWww(path: string, res: ServerResponse): Promise<void> {
    const rel = path === '/app' || path === '/app/' ? 'index.html' : path.slice('/app/'.length)
    const dir = this.deps.wwwDir()
    const target = normalize(join(dir, rel))
    // Path‑traversal guard: resolved file must stay inside wwwDir.
    if (!target.startsWith(normalize(dir) + sep) && target !== normalize(join(dir, 'index.html'))) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const body = await readFile(target)
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }

  /**
   * Stream a file the agent created so a phone can download it. Only paths that
   * actually appear as a written file in the current conversation snapshot are
   * allowed — this is the path‑traversal guard (no arbitrary disk reads).
   */
  private async serveFile(url: URL, res: ServerResponse): Promise<void> {
    const requested = url.searchParams.get('path') ?? ''
    if (!requested || !this.downloadablePaths().has(canonicalPath(requested))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('arquivo não disponível para download')
      return
    }
    try {
      const s = await stat(requested)
      if (!s.isFile()) throw new Error('not a file')
      const name = requested.split(/[\\/]+/).pop() || 'arquivo'
      res.writeHead(200, {
        'Content-Type': MIME[extname(requested).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(s.size),
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`
      })
      createReadStream(requested).pipe(res)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('arquivo não encontrado')
    }
  }

  /**
   * Allowlist of downloadable files:
   *  - paths tracked live via `broadcast()` (see `liveDownloadable` — covers a
   *    phone tapping "Baixar" the instant the button appears, before the
   *    renderer's `setState()` round-trip lands), plus
   *  - deliverables the agent *created* via `Write` (APK/zip/PDF/image…), and
   *  - any file the agent explicitly exposed with a `[[download:PATH]]` marker
   *    in its text (e.g. a built APK located after a Gradle build) — both from
   *    the renderer's conversation snapshot, which also covers files from
   *    conversations resumed/reloaded without going through `broadcast()` here.
   * Everything else (source/config edits) stays non‑downloadable.
   */
  private downloadablePaths(): Set<string> {
    const out = new Set<string>(this.liveDownloadable)
    for (const conv of this.state.conversations) {
      for (const p of downloadablesFromMessages(conv.messages)) out.add(canonicalPath(p))
    }
    return out
  }

  private serveState(res: ServerResponse): void {
    const conversations = this.state.conversations.map((c) => summarize(c))
    // `voiceReady` tells the phone whether to show the mic/listen buttons (the
    // actual STT/TTS runs on the PC, where the OpenAI key lives).
    const voiceReady = this.deps.voiceReady ? this.deps.voiceReady() : false
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        conversations,
        voiceReady,
        skipPerms: this.state.skipPerms ?? false,
        models: this.state.models ?? [],
        modelEffort: this.state.modelEffort ?? {},
        effortLabels: this.state.effortLabels ?? {},
        usage: this.state.usage ?? {},
        projects: this.state.projects ?? [],
        pairedDevice: this.pairedDevice ?? null,
        relayState: this.relayState
      })
    )
  }

  /** Phone → PC: explicit pairing (QR scan / manual connect). Takes over from any
   *  previously paired phone — the scan is the user's intent. */
  private async servePair(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let deviceId = ''
    let name = ''
    try {
      const j = JSON.parse(body || '{}') as { deviceId?: string; name?: string }
      deviceId = String(j.deviceId ?? '').trim()
      name = String(j.name ?? '').trim()
    } catch {
      /* fall through */
    }
    deviceId = deviceId || (url.searchParams.get('dev') ?? '').trim()
    if (!deviceId) return sendJson(res, 400, { ok: false, error: 'deviceId obrigatório' })
    const replaced = this.pairedDevice && this.pairedDevice.id !== deviceId ? this.pairedDevice.name : null
    this.unpairedId = null
    this.setPaired({ id: deviceId, name: name || 'celular', pairedAt: Date.now() })
    if (replaced) {
      // The old phone's event stream is closed so it notices right away (its next
      // call gets 409 and it shows "another phone paired").
      for (const c of this.clients) c.end()
      this.clients.clear()
    }
    this.notifyClients()
    sendJson(res, 200, { ok: true, replaced })
  }

  private async serveInterrupt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let convId = ''
    try {
      convId = String((JSON.parse(body ?? '') as { convId?: string }).convId ?? '').trim()
    } catch {
      /* fall through */
    }
    if (!convId) return sendJson(res, 400, { ok: false, error: 'convId obrigatório' })
    this.deps.onInterrupt?.(convId)
    sendJson(res, 200, { ok: true })
  }

  private async serveSetMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let convId = ''
    let mode: 'economy' | 'loop' | 'fast' | null = null
    let on = false
    try {
      const j = JSON.parse(body ?? '') as { convId?: string; mode?: string; on?: boolean }
      convId = String(j.convId ?? '').trim()
      mode = j.mode === 'economy' || j.mode === 'loop' || j.mode === 'fast' ? j.mode : null
      on = !!j.on
    } catch {
      /* fall through */
    }
    if (!convId || !mode) return sendJson(res, 400, { ok: false, error: 'convId e mode (economy|loop|fast) são obrigatórios' })
    this.deps.onSetMode?.(convId, mode, on)
    // Optimistic echo (same idea as set-model); the renderer's publish confirms.
    const key = mode === 'economy' ? 'economyMode' : mode === 'loop' ? 'loopEnabled' : 'fastMode'
    this.state = {
      ...this.state,
      conversations: this.state.conversations.map((c) => (c.id === convId ? { ...c, [key]: on } : c))
    }
    sendJson(res, 200, { ok: true })
  }

  private async serveConversationAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let j: { type?: string; cwd?: string; convId?: string; title?: string } = {}
    try {
      j = (JSON.parse(body ?? 'null') as typeof j | null) ?? {}
    } catch {
      return sendJson(res, 400, { ok: false, error: 'JSON inválido' })
    }
    const convId = String(j.convId ?? '').trim()
    let action: RemoteConversationAction | null = null
    if (j.type === 'create') {
      const cwd = String(j.cwd ?? '').trim()
      if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd obrigatório' })
      // Only folders the desktop already knows: the phone can't pick arbitrary paths.
      const known = new Set<string>([...(this.state.projects ?? []), ...this.state.conversations.map((c) => c.cwd)])
      if (!known.has(cwd)) return sendJson(res, 400, { ok: false, error: 'projeto desconhecido' })
      action = { type: 'create', cwd, convId: `c-${randomBytes(6).toString('hex')}` }
    } else if (j.type === 'rename') {
      const title = String(j.title ?? '').trim()
      if (!convId || !title) return sendJson(res, 400, { ok: false, error: 'convId e title são obrigatórios' })
      action = { type: 'rename', convId, title }
    } else if (j.type === 'delete') {
      if (!convId) return sendJson(res, 400, { ok: false, error: 'convId obrigatório' })
      action = { type: 'delete', convId }
    }
    if (!action) return sendJson(res, 400, { ok: false, error: 'type inválido' })
    this.deps.onConversationAction?.(action)
    sendJson(res, 200, { ok: true, convId: action.type === 'create' ? action.convId : convId })
  }

  /** Phone → PC: change a conversation's model and/or reasoning effort. */
  private async serveSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let convId = ''
    let model: string | undefined
    let effort: string | undefined
    try {
      const j = JSON.parse(body ?? '') as { convId?: string; model?: string; effort?: string }
      convId = (j.convId ?? '').trim()
      model = typeof j.model === 'string' && j.model.trim() ? j.model.trim() : undefined
      effort = typeof j.effort === 'string' && j.effort.trim() ? j.effort.trim() : undefined
    } catch {
      /* fall through to validation */
    }
    if (!convId || (!model && !effort)) {
      return sendJson(res, 400, { ok: false, error: 'convId e (model ou effort) são obrigatórios' })
    }
    this.deps.onSetModel?.(convId, model, effort)
    // Optimistic echo on the snapshot so the phone's next /api/state already
    // reflects the change (the renderer's own publish will confirm it).
    this.state = {
      ...this.state,
      conversations: this.state.conversations.map((c) =>
        c.id === convId ? { ...c, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : c
      )
    }
    sendJson(res, 200, { ok: true })
  }

  private async serveRecovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    try {
      const data = JSON.parse(body ?? '') as { convId?: string; action?: string }
      const convId = String(data.convId ?? '').trim()
      const action = data.action === 'retry' || data.action === 'cancel' ? data.action : null
      if (!convId || !action) return sendJson(res, 400, { ok: false, error: 'convId/action inválidos' })
      this.deps.onRecoveryAction?.(convId, action)
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 400, { ok: false, error: 'JSON inválido' })
    }
  }

  /** Phone → PC: answer a pending permission/AskUserQuestion request (the one
   *  published on the conversation snapshot as `permission`). Resolves the SAME
   *  way the desktop's IPC handler does — the agent can't tell who answered. */
  private async servePermissionRespond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    try {
      const data = JSON.parse(body ?? '') as {
        convId?: string
        id?: string
        behavior?: string
        always?: boolean
        message?: string
        answers?: PermissionResponse['answers']
      }
      const convId = String(data.convId ?? '').trim()
      const id = String(data.id ?? '').trim()
      const behavior = data.behavior === 'allow' || data.behavior === 'deny' ? data.behavior : null
      if (!convId || !id || !behavior) {
        return sendJson(res, 400, { ok: false, error: 'convId/id/behavior inválidos' })
      }
      this.deps.onPermissionResponse?.(convId, {
        id,
        behavior,
        always: !!data.always,
        message: typeof data.message === 'string' ? data.message : undefined,
        answers: Array.isArray(data.answers) ? data.answers : undefined
      })
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 400, { ok: false, error: 'JSON inválido' })
    }
  }

  /** Phone → PC: flip the global "Permitir tudo" (skip permissions) switch. */
  private async serveSetSkipPerms(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let on = false
    try {
      on = !!(JSON.parse(body ?? '') as { on?: boolean }).on
    } catch {
      /* fall through to default */
    }
    this.deps.onSetSkipPerms?.(on)
    // Reflect it immediately so the phone's UI doesn't wait for the next publish.
    this.state = { ...this.state, skipPerms: on }
    sendJson(res, 200, { ok: true, skipPerms: on })
  }

  /** Phone → PC speech-to-text: receives recorded audio, returns the transcript.
   *  The phone records; the PC (with the OpenAI key) transcribes. */
  private async serveTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.transcribe) return sendJson(res, 503, { ok: false, error: 'voice-unavailable' })
    const body = await readBody(req)
    let audioBase64 = ''
    let mimeType = ''
    try {
      const j = JSON.parse(body ?? '') as { audioBase64?: string; mimeType?: string }
      audioBase64 = String(j.audioBase64 ?? '')
      mimeType = String(j.mimeType ?? '')
    } catch {
      /* fall through to validation */
    }
    if (!audioBase64) return sendJson(res, 400, { ok: false, error: 'áudio vazio' })
    try {
      const text = await this.deps.transcribe(audioBase64, mimeType)
      sendJson(res, 200, { ok: true, text })
    } catch (err) {
      // 200 with an error field so the phone can show a friendly message.
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 200, { ok: false, error: msg === 'no-key' ? 'no-key' : msg })
    }
  }

  /** Phone → PC text-to-speech: receives text, returns base64 MP3 to play. */
  private async serveTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.tts) return sendJson(res, 503, { ok: false, error: 'voice-unavailable' })
    const body = await readBody(req)
    let text = ''
    try {
      text = String((JSON.parse(body ?? '') as { text?: string }).text ?? '').trim()
    } catch {
      /* fall through */
    }
    if (!text) return sendJson(res, 400, { ok: false, error: 'texto vazio' })
    try {
      const { base64, mimeType } = await this.deps.tts(text)
      sendJson(res, 200, { ok: true, audioBase64: base64, mimeType })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 200, { ok: false, error: msg === 'no-key' ? 'no-key' : msg })
    }
  }

  /** Only the most recent messages of ONE conversation go to the phone — never
   *  the whole thing. Long conversations (lots of tool output) are heavy over a
   *  mobile connection; the phone doesn't need older history to keep chatting. */
  private static readonly HISTORY_LIMIT = 30

  private serveHistory(url: URL, res: ServerResponse): void {
    const id = url.searchParams.get('conv') ?? ''
    const conv = this.state.conversations.find((c) => c.id === id)
    const messages = (conv?.messages ?? []).slice(-RemoteServer.HISTORY_LIMIT)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ messages }))
  }

  /** Small history slice centered on a selected question from the lightweight index. */
  private serveHistoryWindow(url: URL, res: ServerResponse): void {
    const convId = url.searchParams.get('conv') ?? ''
    const messageId = url.searchParams.get('message') ?? ''
    const conv = this.state.conversations.find((c) => c.id === convId)
    const messages = conv?.messages ?? []
    const center = messages.findIndex((m) => !!m && typeof m === 'object' && (m as { id?: string }).id === messageId)
    if (center < 0) return sendJson(res, 404, { messages: [], error: 'mensagem não encontrada' })
    const start = Math.max(0, center - 12)
    return sendJson(res, 200, { messages: messages.slice(start, center + 18), targetId: messageId })
  }

  /** Full-text search over the USER's own prompts across every conversation.
   *  Reuses the in-memory snapshot the renderer publishes (which carries the full
   *  message list), so no extra DB query is needed. Returns the matching convs with
   *  a short snippet around the hit, most-recent first. */
  private serveSearch(url: URL, res: ServerResponse): void {
    const q = (url.searchParams.get('q') ?? '').trim()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    if (!q) {
      res.end(JSON.stringify({ results: [] }))
      return
    }
    const fq = fold(q)
    const results: Array<{ id: string; title: string; cwd: string; snippet: string; messageId: string | null; updatedAt: number }> = []
    for (const c of this.state.conversations) {
      let snippet: string | null = null
      let messageId: string | null = null
      for (const m of c.messages as Array<{ kind?: string; text?: string; id?: string }>) {
        if (m && m.kind === 'user' && typeof m.text === 'string' && fold(m.text).includes(fq)) {
          snippet = makeSnippet(m.text, q)
          messageId = typeof m.id === 'string' ? m.id : null
          break
        }
      }
      if (snippet == null && fold(c.title).includes(fq)) snippet = makeSnippet(c.title, q)
      if (snippet != null) results.push({ id: c.id, title: c.title, cwd: c.cwd, snippet, messageId, updatedAt: c.updatedAt })
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt)
    res.end(JSON.stringify({ results }))
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    res.write('retry: 3000\n\n')
    this.clients.add(res)
    this.notifyClients()
    req.on('close', () => {
      this.clients.delete(res)
      this.notifyClients()
    })
  }

  private async serveSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let convId = ''
    let text = ''
    let images: ImageAttachment[] = []
    let files: FileAttachment[] = []
    if (body === null) return sendJson(res, 413, { error: 'mensagem grande demais (limite de 24 MB)' })
    try {
      const j = JSON.parse(body ?? '') as { convId?: string; text?: string; images?: ImageAttachment[]; files?: FileAttachment[] }
      convId = (j.convId ?? '').trim()
      text = (j.text ?? '').trim()
      images = sanitizeImages(j.images)
      files = sanitizeFiles(j.files)
    } catch {
      /* fall through to validation */
    }
    if (!convId || (!text && images.length === 0 && files.length === 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'convId e (text, imagem ou arquivo) são obrigatórios' }))
      return
    }
    this.deps.onInbound(convId, text, images, files)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }
}

/** Conversation summary for /api/state (drops the heavy message list). */
function summarize(c: RemoteConversation): Omit<RemoteConversation, 'messages'> & { messageCount: number } {
  const { messages, ...rest } = c
  return { ...rest, queued: c.queued ?? [], messageCount: messages.length }
}

/** Lowercase + strip accents, so "selênio" matches "selenio" (accent-insensitive).
 *  Drops Unicode combining marks (U+0300–U+036F) by code point — no literal regex. */
function fold(s: string): string {
  const n = s.toLowerCase().normalize('NFD')
  let out = ''
  for (let i = 0; i < n.length; i++) {
    const code = n.charCodeAt(i)
    if (code >= 0x300 && code <= 0x36f) continue
    out += n[i]
  }
  return out
}

/** A short, single-line excerpt of `text` centered on the (case-insensitive) hit. */
function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  const at = i >= 0 ? i : 0
  const start = Math.max(0, at - 28)
  let s = text.slice(start, at + q.length + 52).replace(/\s+/g, ' ').trim()
  if (start > 0) s = '… ' + s
  if (at + q.length + 52 < text.length) s = s + ' …'
  return s
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read at most ~24MB of a request body as a string (images travel as base64).
 *  Resolves `null` when the cap is hit — a truncated JSON would otherwise fail
 *  as a confusing 400 instead of a clear 413. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = ''
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      data += chunk.toString()
      if (data.length > 25_165_824) {
        // Keep draining (don't destroy the socket) so the 413 the caller writes
        // can actually reach the client — destroying would kill the response too.
        overflow = true
        data = ''
        resolve(null)
      }
    })
    req.on('end', () => resolve(overflow ? null : data))
    req.on('error', () => resolve(overflow ? null : data))
  })
}

/** Validate/limit non-image attachments from a phone (name + base64 payload). */
function sanitizeFiles(input: unknown): FileAttachment[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (x): x is FileAttachment =>
        !!x &&
        typeof (x as FileAttachment).name === 'string' &&
        typeof (x as FileAttachment).mediaType === 'string' &&
        typeof (x as FileAttachment).data === 'string' &&
        (x as FileAttachment).data.length > 0
    )
    .slice(0, 8)
    .map((x) => ({
      name: x.name,
      mediaType: x.mediaType,
      data: x.data,
      size: Number.isFinite(x.size) && x.size > 0 ? x.size : Math.floor((x.data.length * 3) / 4)
    }))
}

/** Validate/limit attachments from a phone: keep well-formed image blocks only. */
function sanitizeImages(input: unknown): ImageAttachment[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (x): x is ImageAttachment =>
        !!x &&
        typeof (x as ImageAttachment).mediaType === 'string' &&
        /^image\//.test((x as ImageAttachment).mediaType) &&
        typeof (x as ImageAttachment).data === 'string' &&
        (x as ImageAttachment).data.length > 0
    )
    .slice(0, 8)
    .map((x) => ({ mediaType: x.mediaType, data: x.data }))
}

/** Try `start`, then start+1, … up to `attempts` times. */
function listenWithFallback(server: Server, start: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start
    let tries = 0
    const tryListen = (): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && tries < attempts) {
          tries++
          port++
          setImmediate(tryListen)
        } else reject(err)
      })
      server.listen(port, '0.0.0.0', () => resolve(port))
    }
    tryListen()
  })
}

function landingHtml(i: RemoteInfo): string {
  const conn = i.ip ? `${i.ip}:${i.port}` : `(rede não detectada):${i.port}`
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Code · Remoto</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1f1e1d; color: #e8e6e3;
    margin: 0; padding: 24px; line-height: 1.5; }
  .card { max-width: 460px; margin: 0 auto; background: #262624; border: 1px solid #3a3835;
    border-radius: 14px; padding: 22px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #b9b6b1; font-size: 14px; }
  code { background: #1a1917; padding: 2px 7px; border-radius: 6px; color: #e8e6e3; }
  .btn { display: block; text-align: center; text-decoration: none; background: #c96442;
    color: #fff; padding: 13px; border-radius: 10px; font-weight: 600; margin: 16px 0 10px; }
  .alt { display:block; text-align:center; color:#c96442; text-decoration:none; font-size:14px; }
  .kv { background:#1a1917; border-radius:10px; padding:12px; margin-top:14px; font-size:13px; }
</style></head>
<body><div class="card">
  <h1>📱 Agent Code — Controle remoto</h1>
  <p>Instale o app para enviar comandos ao Claude Code rodando no seu PC.</p>
  <a class="btn" href="/download">⬇️ Baixar APK</a>
  <a class="alt" href="/app/?token=${i.token}">ou abrir o cliente web agora →</a>
  <div class="kv">
    <div>Endereço: <code>${conn}</code></div>
    <div>Token: <code>${i.token}</code></div>
  </div>
  <p style="margin-top:14px">Depois de instalar, abra o app e cole o endereço e o token acima
  (ou escaneie o QR exibido no PC). O celular precisa estar na <b>mesma rede Wi‑Fi</b>.</p>
</div></body></html>`
}
