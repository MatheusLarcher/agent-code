import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { getSessionInfo, getSessionMessages, importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import {
  stat as fsStat,
  copyFile as fsCopyFile,
  access as fsAccess,
  readdir as fsReaddir,
  readFile as fsReadFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { BrowserController } from './browserController'
import { AgentSession, type MessageOrigin } from './agentSession'
import { RemoteServer } from './remote/remoteServer'
import { RelayClient } from './remote/relayClient'
import { buildRemoteApk } from './remote/buildApk'
import {
  Channels,
  DEFAULT_LOCAL_SPEECH_MODEL,
  LOCAL_SPEECH_MODELS,
  REMOTE_RELAY_WS,
  type SpeechSetupProgress
} from '../shared/ipc'
import { initializeConfigPersistence, loadConfig, updateConfig } from './config'
import { transcribeAudio, synthesizeSpeech, writeTempAudioSegment, deleteTempAudioSegment } from './openai'
import { stopLocalSpeech, transcribeLocal } from './speech'
import { isAuthenticated, logoutClaude } from './auth'
import { runClaudeLogin } from './login'
import { codexStatus, codexLogout, initializeCodexAuthPersistence, runCodexLogin } from './codexAuth'
import { appendFileSync } from 'node:fs'
import { initStore, getCacheInfo, setCacheDir } from './store'
import { storageLifecycle } from './persistence/lifecycle'
import { readPersistedKv, writePersistedKv } from './persistence/kvFacade'
import { StorageError, type ConversationLease, type ConversationRecord, type PersistenceRepository } from './persistence/types'
import { hashJson, normalizeJson } from './persistence/hashes'
import {
  attachProjectIdentity,
  isMissingProjectFolderError,
  preserveProjectIdentityForMissingPersistedWrite
} from './persistence/projectIdentity'
import { exportConversationsParquet } from './conversationParquet'
import { storageErrorForIpc, upsertConversationWithLeaseRecovery } from './persistence/conversationWriteRecovery'
import { saveAttachments, resolvePastedPath, downloadPastedUrl, buildAttachmentNote } from './attachments'
import { startMemoryCuratorScheduler } from './memoryCurator'
import { windowsControl } from './windowsControl/service'
import { discoverSkills } from './skillDiscovery'
import { syncCacheSkills } from './skillManager'
import type {
  AgentMessageKind,
  AppConfig,
  BrowserInput,
  FileAttachment,
  FileBytes,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  ProjectNode,
  ProjectTree,
  ResolvedPastedRef,
  SkillInfo,
  PermissionResponse,
  RemoteStatePayload,
  StartAgentOptions,
  TabKind,
  PostgresConnectionDraft,
  ConversationUpsertDto,
  ConversationDeleteDto
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let stopMemoryCurator: (() => void) | null = null
let closeRequested = false
let closeReady = false
let closeRequestTimer: ReturnType<typeof setInterval> | null = null
let quitRequested = false
let quitReady = false
let storageClosePromise: Promise<void> | null = null
let parquetExportPromise: Promise<unknown> | null = null
let restartAfterStorageTransition = false
const pendingStorageFlushes = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

// One independent agent session per conversation — they run concurrently, so
// switching/sending in one conversation never cancels another's running task.
const sessions = new Map<string, AgentSession>()
const sessionLeases = new Map<
  string,
  { repository: PersistenceRepository; lease: ConversationLease; heartbeat: ReturnType<typeof setInterval> }
>()

async function releaseSessionLease(convId: string): Promise<void> {
  const held = sessionLeases.get(convId)
  if (!held) return
  sessionLeases.delete(convId)
  clearInterval(held.heartbeat)
  await held.repository.releaseConversationLease(held.lease).catch(() => undefined)
}

async function acquireSessionLease(convId: string): Promise<{ repository: PersistenceRepository; lease: ConversationLease }> {
  await releaseSessionLease(convId)
  const repository = storageLifecycle.repository()
  const lease = await repository.acquireConversationLease(convId)
  const heartbeat = setInterval(() => {
    const held = sessionLeases.get(convId)
    if (!held) return
    void held.repository
      .renewConversationLease(held.lease)
      .then((renewed) => { held.lease = renewed })
      .catch((error) => {
        clearInterval(held.heartbeat)
        sessionLeases.delete(convId)
        sessions.get(convId)?.dispose()
        send(Channels.agentEvent, {
          convId,
          event: { kind: 'error', id: randomUUID(), text: `Lease perdido: ${error instanceof Error ? error.message : String(error)}` }
        })
      })
  }, 20_000)
  heartbeat.unref?.()
  sessionLeases.set(convId, { repository, lease, heartbeat })
  return { repository, lease }
}

async function prepareSessionResume(
  repository: PersistenceRepository,
  convId: string,
  cwd: string,
  sessionId: string
): Promise<void> {
  if (await repository.sessionResumeReady(convId, sessionId)) return
  const store = repository.createSessionStore(convId)
  await importSessionToStore(sessionId, store, { dir: cwd, includeSubagents: true }).catch(() => undefined)
  const [info, entries] = await Promise.all([
    getSessionInfo(sessionId, { dir: cwd, sessionStore: store }),
    store.load({ projectKey: convId, sessionId })
  ])
  if (!info || !entries?.length) {
    throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'A sessão não possui transcript íntegro para retomada.')
  }
  await getSessionMessages(sessionId, { dir: cwd, sessionStore: store })
  await repository.markSessionResumeReady(convId, sessionId, true, hashJson(normalizeJson(entries)))
}

// One independent browser per conversation. Only the conversation currently
// shown in the panel (`activeConvId`) streams its frames/state to the renderer;
// the others keep their page alive in the background.
const browsers = new Map<string, BrowserController>()
let activeConvId: string | null = null
// Panel size (CSS px) the renderer last reported; every browser adopts it so the
// visible page always matches the panel the user is looking at.
let desiredViewport = { width: 1280, height: 800 }

const EMPTY_BROWSER_STATE = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  launched: false,
  tabs: []
}

function send(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  try {
    window.webContents.send(channel, payload)
  } catch {
    // Renderer teardown can race a final status/change notification.
  }
}

function requestRendererCloseFlush(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!closeRequested) {
    closeRequested = true
    send(Channels.appCloseRequested, null)
  }
  if (!closeRequestTimer) {
    closeRequestTimer = setInterval(() => send(Channels.appCloseRequested, null), 100)
    closeRequestTimer.unref?.()
  }
}

async function closeStorageForQuit(): Promise<void> {
  storageClosePromise ??= (async () => {
    await Promise.all([...sessionLeases.keys()].map(releaseSessionLease))
    await parquetExportPromise?.catch(() => undefined)
    await storageLifecycle.close()
  })()
  await storageClosePromise
}

function requestStorageFlush(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
  const requestId = randomUUID()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStorageFlushes.delete(requestId)
      reject(new Error('O renderer não confirmou o flush de persistência.'))
    }, 15_000)
    timer.unref?.()
    pendingStorageFlushes.set(requestId, { resolve, reject, timer })
    send(Channels.storageFlushRequested, requestId)
  })
}

const storageTransitionHooks = {
  flushRenderer: requestStorageFlush,
  waitForIdleAgents: async (): Promise<void> => {
    // The caller has already obtained explicit user confirmation. Stop live
    // work now instead of allowing a long-running turn to hold the migration.
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
    await Promise.all([...sessionLeases.keys()].map(releaseSessionLease))
  }
}

async function confirmStorageTransitionStopsAgents(direction: 'postgres' | 'sqlite'): Promise<boolean> {
  const count = sessions.size
  if (!count) return true
  const target = direction === 'postgres' ? 'PostgreSQL' : 'SQLite'
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Parar agents e migrar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: `Migrar para ${target}`,
    message: `${count === 1 ? 'Existe 1 agent em execução' : `Existem ${count} agents em execução`}.`,
    detail: `A migração para ${target} precisa interromper ${count === 1 ? 'esse agent' : 'esses agents'}. O histórico pendente será salvo antes da troca e o aplicativo reiniciará automaticamente.`
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

function relaunchAfterStorageTransition(): void {
  if (restartAfterStorageTransition) return
  restartAfterStorageTransition = true
  setTimeout(() => {
    app.relaunch()
    app.quit()
  }, 300).unref?.()
}

function assertStorageWritable(allowTransitionFlush = false): void {
  if (!storageLifecycle.canMutate()) {
    const status = storageLifecycle.status()
    throw new Error(status.error?.message ?? 'Persistência indisponível para gravação.')
  }
  const state = storageLifecycle.status().state
  if (!allowTransitionFlush && (state === 'activating-postgres' || state === 'deactivating-postgres')) {
    throw new StorageError('TRANSITION_IN_PROGRESS', 'A persistência está em transição.')
  }
}

async function updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  if ('windowsControlEnabled' in patch && typeof patch.windowsControlEnabled !== 'boolean') {
    throw new TypeError('windowsControlEnabled deve ser booleano.')
  }
  const next = await updateConfig(patch)
  if (patch.windowsControlEnabled !== undefined) {
    windowsControl.setEnabled(next.windowsControlEnabled)
    send(Channels.windowsControlChanged, next.windowsControlEnabled)
  }
  return next
}

/** True if a path exists (used to avoid clobbering files in Downloads). */
async function fsExists(p: string): Promise<boolean> {
  try {
    await fsAccess(p)
    return true
  } catch {
    return false
  }
}

// Root of the smartfone-remote project (sibling of out/ → ../../ from out/main).
const REMOTE_ROOT = join(import.meta.dirname, '../../smartfone-remote')

// ---- "@" autocomplete: search project files/folders --------------------------

/** Directories never worth walking for the "@" menu (noise / huge / generated). */
const MENTION_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.gradle', '.vite',
  'coverage', '.next', '.turbo', '.cache', '.idea'
])

/** lowercase + strip accents, so "TÉST" matches "teste" (project filter rule). */
function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Rank a candidate against the folded query; -1 means "no match" (drop it). */
function mentionScore(q: string, name: string, relPath: string, isDir: boolean): number {
  const n = foldText(name)
  const p = foldText(relPath)
  let base: number
  if (n === q) base = 100
  else if (n.startsWith(q)) base = 80
  else if (n.includes(q)) base = 60
  else if (p.includes(q)) base = 30
  else return -1
  return base + (isDir ? 3 : 0) // nudge folders up a touch, as the user asked for both
}

/**
 * Walk the project tree breadth-first (shallow entries first) and return files
 * and folders whose name/path contains `query`, accent- and case-insensitive.
 * Capped in both hits and nodes scanned so each keystroke stays cheap. An empty
 * query lists the project's top level (folders first).
 */
async function searchProjectEntries(root: string, query: string): Promise<MentionHit[]> {
  const MAX_HITS = 30
  const MAX_SCAN = 20000
  const q = foldText(query.trim())

  // Empty query → just the project's top level (folders first), no recursion.
  if (!q) {
    let top: import('node:fs').Dirent[]
    try {
      top = await fsReaddir(root, { withFileTypes: true })
    } catch {
      return []
    }
    return top
      .filter((e) => !(e.isDirectory() && MENTION_IGNORE.has(e.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, MAX_HITS)
      .map((e) => ({ path: e.name, name: e.name, isDir: e.isDirectory() }))
  }

  type Hit = MentionHit & { score: number }
  const hits: Hit[] = []
  const queue: string[] = [''] // relative dirs still to visit ('' = root)
  let scanned = 0

  while (queue.length && scanned < MAX_SCAN) {
    const rel = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsReaddir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (scanned >= MAX_SCAN) break
      scanned++
      const isDir = e.isDirectory()
      if (isDir && MENTION_IGNORE.has(e.name)) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (isDir) queue.push(relPath)
      const score = mentionScore(q, e.name, relPath, isDir)
      if (score >= 0) hits.push({ path: relPath, name: e.name, isDir, score })
    }
  }
  hits.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return hits.slice(0, MAX_HITS).map(({ path, name, isDir }) => ({ path, name, isDir }))
}

// ---- project map: the whole tree, for the "Projeto" graph view ----------------

/**
 * The project map's nodes: the N most RECENTLY MODIFIED files, plus every
 * folder needed to reach them.
 *
 * Showing the whole repo was the first version and it was the wrong picture —
 * hundreds of files nobody has touched in months, with the live work lost in
 * the middle. Sorting by mtime makes the map answer "what is moving in this
 * project", which is what it exists for. Anything the agent touches gets added
 * on the fly by the renderer even if it isn't in this list.
 *
 * The walk is still capped (MAX_SCAN) so a monorepo can't stall the main
 * process; `truncated` says the ranking only saw part of the repo.
 */
async function readProjectTree(root: string, keep: string[] = [], limit = 100): Promise<ProjectTree> {
  const MAX_SCAN = 8000
  const files: { path: string; name: string; mtimeMs: number }[] = []
  const queue: string[] = ['']
  let scanned = 0
  let truncated = false

  while (queue.length && scanned < MAX_SCAN) {
    const rel = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsReaddir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    const batch: Promise<void>[] = []
    for (const e of entries) {
      if (scanned >= MAX_SCAN) {
        truncated = true
        break
      }
      scanned++
      const isDir = e.isDirectory()
      // Dotfiles stay out: config noise on a map meant to show code.
      if (e.name.startsWith('.')) continue
      if (isDir && MENTION_IGNORE.has(e.name)) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (isDir) {
        queue.push(relPath)
        continue
      }
      // stat per file is the price of ranking by mtime; fired in parallel per
      // directory so it's one round of I/O per folder, not one per file.
      batch.push(
        fsStat(join(root, relPath))
          .then((s) => {
            files.push({ path: relPath, name: e.name, mtimeMs: s.mtimeMs })
          })
          .catch(() => {
            /* vanished mid-scan — just leave it out */
          })
      )
    }
    await Promise.all(batch)
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const top = files.slice(0, limit)

  // Every ancestor folder of a kept file has to come along, otherwise the node
  // is an orphan and the graph drops it (and the travel animation would have
  // no route to walk).
  const out = new Map<string, ProjectNode>()
  for (const f of top) {
    const parts = f.path.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      if (!out.has(p)) out.set(p, { path: p, name: parts[i], isDir: true })
    }
    out.set(f.path, { path: f.path, name: f.name, isDir: false, mtimeMs: f.mtimeMs })
  }

  // Which of the caller's current nodes are actually gone from disk (as opposed
  // to just having dropped out of the ranking).
  const missing: string[] = []
  await Promise.all(
    keep.map(async (rel) => {
      if (!rel) return
      try {
        await fsAccess(join(root, rel))
      } catch {
        missing.push(rel)
      }
    })
  )

  return { nodes: [...out.values()], truncated: truncated || files.length > limit, missing }
}

// ---- "/" autocomplete: list the agent's skills --------------------------------

/**
 * List the skills available to the agent: project-local entries, the active
 * cache skill store and user-level `~/.claude/skills`. Deduped by name
 * (project wins), sorted alphabetically.
 */
async function listAgentSkills(projectRoot: string): Promise<SkillInfo[]> {
  return discoverSkills(projectRoot).map(({ name, description }) => ({ name, description }))
}

/**
 * Mensagens que acabaram de chegar do celular, esperando o `agent:send` que
 * fecha o círculo. A marca é consumida uma vez só e casa pelo TEXTO — assim uma
 * mensagem digitada no PC na mesma conversa não rouba o carimbo de celular.
 */
const pendingRemote = new Map<string, { text: string; at: number }>()
/** A volta pelo renderer é imediata, MAS a mensagem pode ficar na fila enquanto o
 *  agente termina o turno anterior — por isso a janela é larga, e não de segundos.
 *  Passou disso, a marca é lixo e a origem cai para o padrão (PC). */
const REMOTE_MARK_TTL_MS = 30 * 60_000

function markRemoteInbound(convId: string, text: string): void {
  pendingRemote.set(convId, { text, at: Date.now() })
}

/** Consome a marca (uma vez) e diz de onde a mensagem partiu. */
function takeOrigin(convId: string, outgoing: string): MessageOrigin {
  const mark = pendingRemote.get(convId)
  if (!mark) return 'pc'
  pendingRemote.delete(convId)
  const fresh = Date.now() - mark.at < REMOTE_MARK_TTL_MS
  return fresh && outgoing === mark.text ? 'celular' : 'pc'
}

// LAN bridge: phones POST commands here; we forward them to the renderer (which
// dispatches into the right conversation) and tee live agent events back over SSE.
const remote = new RemoteServer({
  onInbound: (convId, text, images) => {
    // A mensagem do celular dá a volta pelo renderer (que a despacha na conversa
    // certa) e só então volta para cá no `agent:send`. Guardamos a marca aqui,
    // que é o único ponto que SABE que a origem é o celular.
    markRemoteInbound(convId, text)
    send(Channels.remoteInbound, { convId, text, images })
  },
  onSetSkipPerms: (on) => send(Channels.remoteSetSkipPerms, { on }),
  onSetModel: (convId, model, effort) => send(Channels.remoteSetModel, { convId, model, effort }),
  onRecoveryAction: (convId, action) => send(Channels.remoteRecoveryAction, { convId, action }),
  onPermissionResponse: (convId, res) => send(Channels.remotePermissionResponse, { convId, res }),
  apkPath: () => join(REMOTE_ROOT, 'dist', 'agent-remote.apk'),
  wwwDir: () => join(REMOTE_ROOT, 'www'),
  onClientsChanged: (info) => send(Channels.remoteClients, info),
  // Fixed pairing token, persisted in settings.json so phones stay paired.
  loadToken: () => loadConfig().remoteToken,
  saveToken: async (token) => {
    await updateConfig({ remoteToken: token })
  },
  // Voice runs on the PC (the OpenAI key lives here): the phone records/plays,
  // we transcribe/synthesize. Throw 'no-key' so the phone shows a clear hint.
  transcribe: (audioBase64, mimeType) => {
    const apiKey = loadConfig().openai.apiKey.trim()
    if (!apiKey) throw new Error('no-key')
    return transcribeAudio(apiKey, audioBase64, mimeType)
  },
  tts: (text) => {
    const { apiKey, voice } = loadConfig().openai
    if (!apiKey.trim()) throw new Error('no-key')
    return synthesizeSpeech(apiKey.trim(), text, voice)
  },
  voiceReady: () => !!loadConfig().openai.apiKey.trim()
})

// Outbound relay to the VPS broker: lets a phone reach this PC from ANY network
// (not just the LAN) without opening a port or sharing a VPS password — routing is
// by the bridge's own token. Dials out only while the bridge is ON.
const relay = new RelayClient({
  brokerUrl: REMOTE_RELAY_WS,
  getToken: () => remote.info().token,
  getPort: () => remote.info().port,
  onStatus: (connected) => remote.setRelayConnected(connected)
})

/** Get (creating if needed) the browser dedicated to a conversation. */
function getBrowser(convId: string): BrowserController {
  let b = browsers.get(convId)
  if (!b) {
    // Callbacks are gated on `activeConvId` so a background conversation's
    // browser never paints over the one the user is looking at.
    b = new BrowserController(
      {
        onFrame: (frame) => convId === activeConvId && send(Channels.browserFrame, frame),
        onState: (state) => convId === activeConvId && send(Channels.browserStateChanged, state),
        onPicked: (el) => convId === activeConvId && send(Channels.browserPicked, el),
        // Boot progress is tagged with convId so the renderer shows it on the right chat.
        onAndroidProgress: (line) => send(Channels.androidProgress, { convId, line })
      },
      convId
    )
    void b.setViewport(desiredViewport.width, desiredViewport.height)
    browsers.set(convId, b)
  }
  return b
}

/** The browser shown in the panel right now, if any (does not create one). */
function activeBrowser(): BrowserController | null {
  return activeConvId ? browsers.get(activeConvId) ?? null : null
}

function createWindow(): void {
  if (closeRequestTimer) clearInterval(closeRequestTimer)
  closeRequestTimer = null
  closeRequested = false
  closeReady = false
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#1f1e1d',
    title: 'Agent Code',
    icon: join(
      import.meta.dirname,
      '../../build',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#262624',
      symbolColor: '#e8e6e3',
      height: 52
    },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // Enable Chromium's built-in PDF viewer so the file preview can render
      // PDFs in an <iframe>/<embed> (off by default).
      plugins: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const reload = input.type === 'keyDown' && (key === 'f5' || (input.control && key === 'r'))
    if (!reload) return
    event.preventDefault()
    send(Channels.appReloadRequested, null)
  })

  // Grant microphone access for the voice dictation (getUserMedia). Electron denies
  // media by default with no handler; we allow only 'media' from our own renderer.
  // Both handlers are needed: the async request prompt AND the sync check that
  // getUserMedia consults first.
  const sess = mainWindow.webContents.session
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  sess.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  mainWindow.on('close', (event) => {
    if (closeReady) return
    event.preventDefault()
    requestRendererCloseFlush()
  })

  mainWindow.on('closed', () => {
    if (closeRequestTimer) clearInterval(closeRequestTimer)
    closeRequestTimer = null
    mainWindow = null
    closeRequested = false
    closeReady = false
  })
}

// TEMP login diagnostics → auth-debug.log in the cache folder (removed once the
// OAuth flow is confirmed end-to-end).
function authLog(line: string): void {
  try {
    appendFileSync(join(getCacheInfo().dir, 'auth-debug.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* best-effort */
  }
}

function registerIpc(): void {
  ipcMain.handle(Channels.storageStatusGet, () => storageLifecycle.status())
  ipcMain.handle(Channels.storagePostgresSettingsGet, () => storageLifecycle.postgresSettings())
  ipcMain.handle(Channels.storagePostgresTest, (_event, draft: PostgresConnectionDraft) =>
    storageLifecycle.testPostgres(draft)
  )
  ipcMain.handle(Channels.storagePostgresActivate, async (_event, draft: PostgresConnectionDraft) => {
    if (!(await confirmStorageTransitionStopsAgents('postgres'))) return false
    await storageLifecycle.activatePostgres(draft, storageTransitionHooks)
    relaunchAfterStorageTransition()
    return true
  })
  ipcMain.handle(Channels.storagePostgresDeactivate, async () => {
    if (!(await confirmStorageTransitionStopsAgents('sqlite'))) return false
    await storageLifecycle.deactivatePostgres(storageTransitionHooks)
    relaunchAfterStorageTransition()
    return true
  })
  ipcMain.handle(Channels.storageRetry, (_event, draft?: PostgresConnectionDraft) =>
    storageLifecycle.retryPostgres(draft)
  )
  ipcMain.handle(Channels.storagePostgresPasswordClear, () => storageLifecycle.clearPostgresPassword())
  ipcMain.handle(Channels.storageFlushReady, (_event, requestId: string, error?: string) => {
    const pending = pendingStorageFlushes.get(requestId)
    if (!pending) return
    pendingStorageFlushes.delete(requestId)
    clearTimeout(pending.timer)
    if (error) pending.reject(new Error(error))
    else pending.resolve()
  })
  // App configuration (Settings screen).
  ipcMain.handle(Channels.configGet, () => {
    storageLifecycle.repository()
    return loadConfig()
  })
  ipcMain.handle(Channels.configSet, (_e, patch: Partial<AppConfig>) => {
    assertStorageWritable()
    return updateAppConfig(patch)
  })
  ipcMain.handle(Channels.appCloseReady, async () => {
    if (!closeRequested || !mainWindow) return
    if (closeRequestTimer) clearInterval(closeRequestTimer)
    closeRequestTimer = null
    if (quitRequested) await closeStorageForQuit()
    closeReady = true
    const windowToClose = mainWindow
    setImmediate(() => {
      windowToClose.close()
      if (quitRequested) {
        quitReady = true
        app.quit()
      }
    })
  })

  ipcMain.handle(Channels.appReloadReady, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.reload()
  })
  ipcMain.handle(Channels.windowsControlSetEnabled, async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled deve ser booleano.')
    assertStorageWritable()
    await updateAppConfig({ windowsControlEnabled: enabled })
  })

  // OpenAI voice (chat): speech-to-text and text-to-speech. The key stays in main
  // (read from config); the renderer only ships audio/text. Errors come back as
  // { ok: false } so the UI can show a toast / prompt for the key.
  ipcMain.handle(Channels.openaiTranscribe, async (e, audioBase64: string, mimeType: string) => {
    const cfg = loadConfig()

    // On-device engine: nothing is uploaded, but the model may still need to be
    // downloaded. Progress is streamed so the mic can keep its loading state and
    // say what's happening instead of just hanging.
    if (cfg.transcribeEngine === 'local') {
      // A config salva pode ter um id de um catálogo antigo (ex.: o Whisper que
      // existia antes do app passar a oferecer só os modelos da NVIDIA) — usá-lo
      // direto tenta baixar um repo que não tem os pesos no formato esperado e
      // falha com um erro obscuro. Cair no padrão quando o id não é mais oferecido.
      const model = LOCAL_SPEECH_MODELS.some((m) => m.id === cfg.localSpeech.model)
        ? cfg.localSpeech.model
        : DEFAULT_LOCAL_SPEECH_MODEL
      const report = (p: SpeechSetupProgress): void => {
        if (!e.sender.isDestroyed()) e.sender.send(Channels.speechSetupProgress, p)
      }
      try {
        const text = await transcribeLocal(Buffer.from(audioBase64, 'base64'), model, report)
        return { ok: true, text }
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err)
        report({ stage: 'error', message: 'Não consegui preparar o reconhecimento de voz.' })
        return { ok: false, error: message }
      }
    }

    const apiKey = cfg.openai.apiKey.trim()
    if (!apiKey) return { ok: false, error: 'no-key' }
    // Segment is written to a scratch folder only for the duration of the STT
    // call — the API needs a file, but nothing here should outlive this request.
    let tempFile: string | null = null
    try {
      tempFile = await writeTempAudioSegment(join(getCacheInfo().dir, 'tmp-audio'), audioBase64, mimeType)
      const text = await transcribeAudio(apiKey, audioBase64, mimeType)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    } finally {
      if (tempFile) void deleteTempAudioSegment(tempFile)
    }
  })
  // Claude Code auth: status + the one-click OAuth login (no typed /login).
  ipcMain.handle(Channels.authStatus, async () => ({ authenticated: await isAuthenticated() }))
  ipcMain.handle(Channels.authLogin, async () => {
    authLog('=== auth:login start ===')
    // The FIRST login opens the user's own SYSTEM browser (product decision) — not
    // the app's embedded browser. The CLI runs a loopback to capture the code.
    const openUrl = (url: string): void => {
      authLog(`opening system browser: ${url}`)
      void shell.openExternal(url)
    }
    const ok = await runClaudeLogin(openUrl, authLog)
    authLog(`=== auth:login done: authenticated=${ok} ===`)
    return { ok }
  })
  ipcMain.handle(Channels.authLogout, async () => {
    assertStorageWritable()
    const status = await logoutClaude()
    authLog(`=== auth:logout: loggedIn=${status.loggedIn} authMethod=${status.authMethod} ===`)
    return status
  })

  // OpenAI Codex auth: same one-click OAuth pattern as Claude above, but
  // against the ChatGPT subscription login instead of an Anthropic account.
  ipcMain.handle(Channels.codexStatus, () => codexStatus())
  ipcMain.handle(Channels.codexLogin, async () => {
    assertStorageWritable()
    authLog('=== codex:login start ===')
    const openUrl = (url: string): void => {
      authLog(`opening system browser: ${url}`)
      void shell.openExternal(url)
    }
    const result = await runCodexLogin(openUrl, authLog)
    authLog(`=== codex:login done: ok=${result.ok} message=${result.message ?? ''} ===`)
    return result
  })
  ipcMain.handle(Channels.codexLogout, async () => {
    assertStorageWritable()
    await codexLogout()
    authLog('=== codex:logout ===')
  })

  ipcMain.handle(Channels.openaiTts, async (_e, text: string) => {
    const { apiKey, voice } = loadConfig().openai
    if (!apiKey.trim()) return { ok: false, error: 'no-key' }
    try {
      const { base64, mimeType } = await synthesizeSpeech(apiKey.trim(), text, voice)
      return { ok: true, audioBase64: base64, mimeType }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // Cache folder: where the SQLite db (config/token/conversations) + .md memories live.
  ipcMain.handle(Channels.cacheGetInfo, () => getCacheInfo())
  ipcMain.handle(Channels.cacheChooseDir, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Escolha onde salvar os dados do Agent Code',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    assertStorageWritable()
    await storageTransitionHooks.waitForIdleAgents()
    await requestStorageFlush()
    const info = setCacheDir(res.filePaths[0])
    if (storageLifecycle.status().backend === 'sqlite') {
      await storageLifecycle.initializeSqlite(info)
      await initializeConfigPersistence()
      await initializeCodexAuthPersistence()
    } else {
      storageLifecycle.updateSqliteLocation(info)
    }
    const skillSync = syncCacheSkills(app.getAppPath(), info.dir)
    for (const error of skillSync.errors) console.error(`[skills] ${error}`)
    const enabled = loadConfig().windowsControlEnabled === true
    windowsControl.setEnabled(enabled)
    send(Channels.windowsControlChanged, enabled)
    return info
  })
  ipcMain.handle(Channels.kvGet, (_e, key: string) => readPersistedKv(key))
  ipcMain.handle(Channels.kvSet, (_e, key: string, value: string) => {
    assertStorageWritable(true)
    return writePersistedKv(key, value)
  })
  ipcMain.handle(Channels.conversationsLoadAll, async () =>
    (await storageLifecycle.repository().loadConversations()).map((entry) => entry.payload)
  )
  ipcMain.handle(Channels.conversationsLoadVersioned, () =>
    storageLifecycle.repository().loadConversations({ includeDeleted: true })
  )
  ipcMain.handle(Channels.conversationsUpsert, async (_e, input: ConversationUpsertDto) => {
    if (!input || typeof input.id !== 'string' || !input.id || !input.payload || typeof input.payload !== 'object') {
      throw new TypeError('Conversa inválida.')
    }
    assertStorageWritable(true)
    const held = sessionLeases.get(input.id)
    let payload: ConversationRecord
    try {
      payload = await attachProjectIdentity(input.payload)
    } catch (cause) {
      if (!isMissingProjectFolderError(cause)) throw cause
      const persisted = (await storageLifecycle.repository().loadConversations({ includeDeleted: true }))
        .find((entry) => entry.id === input.id)?.payload
      payload = preserveProjectIdentityForMissingPersistedWrite(input.payload, persisted)
    }
    const repository = storageLifecycle.repository()
    try {
      return await upsertConversationWithLeaseRecovery(repository, {
        ...input,
        payload,
        ...(held ? { lease: { token: held.lease.token, fencingEpoch: held.lease.fencingEpoch } } : {})
      })
    } catch (cause) {
      throw storageErrorForIpc(cause)
    }
  })
  ipcMain.handle(Channels.conversationsDelete, async (_e, input: ConversationDeleteDto) => {
    if (!input || typeof input.id !== 'string' || !Number.isInteger(input.expectedRevision)) {
      throw new TypeError('Exclusão de conversa inválida.')
    }
    assertStorageWritable(true)
    const held = sessionLeases.get(input.id)
    try {
      return await storageLifecycle.repository().deleteConversation({
        ...input,
        ...(held ? { lease: { token: held.lease.token, fencingEpoch: held.lease.fencingEpoch } } : {})
      })
    } catch (cause) {
      throw storageErrorForIpc(cause)
    }
  })
  ipcMain.handle(Channels.conversationsSaveAll, async (_e, list: unknown) => {
    // A malformed (non-array) payload must never be treated as "zero conversations" —
    // that would delete every conversation, not just skip the save.
    if (!Array.isArray(list)) return
    assertStorageWritable()
    await storageLifecycle.repository().replaceAllConversations(list as ConversationRecord[])
  })

  ipcMain.handle(Channels.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(Channels.pickFile, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // Project-folder guard: true only when the path exists and is a directory.
  ipcMain.handle(Channels.pathExists, async (_e, p: string) => {
    try {
      const s = await fsStat(p)
      return s.isDirectory()
    } catch {
      return false
    }
  })

  // Open a project folder in VS Code. First try the `code` CLI (handles folders
  // properly); if it isn't on PATH, fall back to VS Code's `vscode://` URL handler
  // (registered by the installer). Returns a status so the renderer can toast.
  ipcMain.handle(Channels.openInEditor, async (_e, dir: string): Promise<{ ok: boolean; message: string }> => {
    if (!dir) return { ok: false, message: 'Nenhuma pasta para abrir.' }
    const launched = await new Promise<boolean>((resolve) => {
      // shell:true so Windows resolves `code` → `code.cmd` via PATHEXT.
      const child = spawn(`code "${dir}"`, { shell: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (launched) return { ok: true, message: 'Abrindo no VS Code…' }
    try {
      await shell.openExternal('vscode://file/' + dir.replace(/\\/g, '/'))
      return { ok: true, message: 'Abrindo no VS Code…' }
    } catch {
      return {
        ok: false,
        message: 'Não foi possível abrir o VS Code. Verifique se está instalado e se o comando "code" está no PATH.'
      }
    }
  })

  ipcMain.handle(Channels.openInFolder, async (_e, dir: string): Promise<{ ok: boolean; message: string }> => {
    if (!dir) return { ok: false, message: 'Nenhuma pasta para abrir.' }
    // shell.openPath opens the folder itself in the OS file explorer; it resolves
    // with an empty string on success or an error description on failure.
    const err = await shell.openPath(dir)
    return err
      ? { ok: false, message: `Não foi possível abrir a pasta: ${err}` }
      : { ok: true, message: 'Abrindo a pasta no explorador…' }
  })

  ipcMain.handle(
    Channels.mentionSearch,
    async (_e, root: string, query: string): Promise<MentionHit[]> => {
      if (!root) return []
      return searchProjectEntries(root, query)
    }
  )

  ipcMain.handle(Channels.listSkills, async (_e, root: string): Promise<SkillInfo[]> => {
    return listAgentSkills(root)
  })

  ipcMain.handle(
    Channels.projectTree,
    async (_e, root: string, keep: string[] = []): Promise<ProjectTree> => {
      if (!root) return { nodes: [], truncated: false, missing: [] }
      return readProjectTree(root, keep)
    }
  )

  // Save a copy of a file the agent created into the user's Downloads folder and
  // reveal it (so "baixar" works on the desktop too, not only on the phone).
  ipcMain.handle(
    Channels.fileDownload,
    async (_e, path: string): Promise<{ ok: boolean; message: string; saved?: string }> => {
      if (!path) return { ok: false, message: 'Caminho de arquivo ausente.' }
      try {
        const src = await fsStat(path)
        if (!src.isFile()) return { ok: false, message: 'O caminho não é um arquivo.' }
        const downloads = app.getPath('downloads')
        let dest = join(downloads, basename(path))
        // Avoid clobbering an existing file: append " (1)", " (2)", …
        const ext = extname(dest)
        const stem = dest.slice(0, dest.length - ext.length)
        let n = 1
        while (await fsExists(dest)) dest = `${stem} (${n++})${ext}`
        await fsCopyFile(path, dest)
        shell.showItemInFolder(dest)
        return { ok: true, message: `Salvo em ${dest}`, saved: dest }
      } catch (err) {
        return { ok: false, message: `Falha ao baixar: ${String(err)}` }
      }
    }
  )

  ipcMain.handle(Channels.fileRead, async (_e, absolutePath: string) => {
    try {
      return await fsReadFile(absolutePath, 'utf8')
    } catch (err) {
      return `Erro ao ler arquivo: ${String(err)}`
    }
  })

  // Read a file as raw bytes (base64) for binary previews (PDF, images, xlsx…).
  // Capped at 50 MB so a huge file can't blow up the IPC payload / renderer memory.
  ipcMain.handle(Channels.fileReadBytes, async (_e, absolutePath: string): Promise<FileBytes> => {
    try {
      const buf = await fsReadFile(absolutePath)
      if (buf.byteLength > 50 * 1024 * 1024) {
        return { ok: false, error: 'Arquivo muito grande para visualizar (limite de 50 MB).' }
      }
      return { ok: true, base64: buf.toString('base64'), size: buf.byteLength }
    } catch (err) {
      return { ok: false, error: `Erro ao ler arquivo: ${String(err)}` }
    }
  })

  // Composer: a pasted line that looks like a local path — stat only, no
  // bytes read, so the agent opens the ORIGINAL path with its own tools.
  ipcMain.handle(Channels.resolvePastedPath, async (_e, rawPath: string): Promise<ResolvedPastedRef> => {
    return resolvePastedPath(rawPath)
  })

  // Composer: a pasted line that looks like a file URL — download it to disk
  // (streaming) and hand back the saved path, never the bytes.
  ipcMain.handle(
    Channels.downloadPastedUrl,
    async (_e, url: string, convId: string): Promise<ResolvedPastedRef> => {
      return downloadPastedUrl(url, convId)
    }
  )

  ipcMain.handle(Channels.agentStart, async (_e, opts: StartAgentOptions) => {
    assertStorageWritable()
    const { convId } = opts
    const project = await fsStat(opts.cwd).catch(() => null)
    if (!project?.isDirectory()) throw new Error('A pasta local do projeto não foi localizada nesta instalação.')
    // Replace only THIS conversation's session; others keep running.
    sessions.get(convId)?.dispose()
    await releaseSessionLease(convId)
    const { repository } = await acquireSessionLease(convId)
    const sessionStore = repository.createSessionStore(convId)
    try {
      if (opts.resume) await prepareSessionResume(repository, convId, opts.cwd, opts.resume)
    } catch (error) {
      await releaseSessionLease(convId)
      throw error
    }
    const s = new AgentSession(
      opts,
      getBrowser(convId),
      // Tag every event/permission with the conversation so the renderer can
      // route it to the right chat, even across concurrent sessions. Events are
      // also teed to any connected phones over the remote bridge (SSE).
      (event) => {
        send(Channels.agentEvent, { convId, event })
        remote.broadcast(convId, event)
      },
      (req) => send(Channels.agentPermissionRequest, { convId, req }),
      (id) => send(Channels.agentPermissionExpired, { convId, id }),
      sessionStore,
      async (sessionId, mirrorFailed) => {
        if (mirrorFailed) {
          await repository.markSessionResumeReady(convId, sessionId, false)
          throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'O SDK informou falha no espelhamento do transcript.')
        }
        const [info, entries] = await Promise.all([
          getSessionInfo(sessionId, { dir: opts.cwd, sessionStore }),
          sessionStore.load({ projectKey: convId, sessionId })
        ])
        if (!info || !entries?.length) {
          throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'O transcript espelhado não passou na verificação.')
        }
        await getSessionMessages(sessionId, { dir: opts.cwd, sessionStore })
        await repository.markSessionResumeReady(convId, sessionId, true, hashJson(normalizeJson(entries)))
      },
      { appRoot: app.getAppPath() }
    )
    sessions.set(convId, s)
    let ok = false
    try {
      ok = await s.start()
    } catch (error) {
      console.error(`Agent failed to start for conversation ${convId}:`, error)
    }
    if (!ok) {
      if (sessions.get(convId) === s) sessions.delete(convId)
      s.dispose()
      await releaseSessionLease(convId)
    }
    return { ok }
  })

  ipcMain.handle(
    Channels.agentSend,
    async (
      _e,
      convId: string,
      text: string,
      images?: ImageAttachment[],
      files?: FileAttachment[],
      fileRefs?: FileRefAttachment[],
      messageUuid?: string,
      messageKind?: AgentMessageKind
    ) => {
      assertStorageWritable()
      if (!sessionLeases.has(convId)) {
        throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'A conversa não possui lease de escrita ativo.')
      }
      // Non-image files are saved to disk and referenced by path so the agent can
      // open them with its own tools (Read, scripts, etc.). Pasted-by-reference
      // files (fileRefs) are already on disk — local path or main's own
      // download — so they join the same note without another save.
      const saved: Array<{ name: string; path: string }> =
        files && files.length > 0 ? await saveAttachments(convId, files) : []
      const finalText = buildAttachmentNote(text, [...saved, ...(fileRefs ?? [])])
      await sessions.get(convId)?.send(finalText, images, messageUuid, takeOrigin(convId, text), messageKind)
    }
  )

  ipcMain.handle(Channels.agentInterrupt, async (_e, convId: string) => {
    return (await sessions.get(convId)?.interrupt()) ?? { stillQueued: [] }
  })

  ipcMain.handle(Channels.agentSetBypass, (_e, convId: string, on: boolean) => {
    sessions.get(convId)?.setBypass(on)
  })

  ipcMain.handle(Channels.agentPermissionResponse, (_e, convId: string, res: PermissionResponse) => {
    sessions.get(convId)?.resolvePermission(res)
  })

  ipcMain.handle(Channels.agentDispose, (_e, convId: string) => {
    sessions.get(convId)?.dispose()
    sessions.delete(convId)
    void releaseSessionLease(convId)
  })

  ipcMain.handle(Channels.agentRefreshUsage, async (_e, convId: string) => {
    await sessions.get(convId)?.refreshUsage()
  })

  // Manual panel controls act on the browser of the conversation being viewed.
  ipcMain.handle(Channels.browserLaunch, async () => {
    if (activeConvId) await getBrowser(activeConvId).ensureLaunched()
  })
  ipcMain.handle(Channels.browserNavigate, (_e, url: string) =>
    activeConvId ? getBrowser(activeConvId).navigate(url) : ''
  )
  ipcMain.handle(Channels.browserBack, () => activeBrowser()?.back())
  ipcMain.handle(Channels.browserForward, () => activeBrowser()?.forward())
  ipcMain.handle(Channels.browserReload, () => activeBrowser()?.reload())
  ipcMain.handle(Channels.browserSetSelectMode, (_e, on: boolean) => activeBrowser()?.setSelectMode(on))
  ipcMain.handle(Channels.browserInput, (_e, ev: BrowserInput) => activeBrowser()?.forwardInput(ev))
  ipcMain.handle(Channels.browserClose, () => activeBrowser()?.close())

  ipcMain.handle(Channels.browserSetViewport, (_e, width: number, height: number) => {
    desiredViewport = { width, height }
    void activeBrowser()?.setViewport(width, height)
  })

  // Tab controls act on the conversation currently shown in the panel. newTab
  // uses getBrowser so "+" can launch the browser for a conversation that has none.
  // Returns the result string so the renderer can surface success/errors (e.g.
  // an Android tab failing because the toolchain isn't installed).
  ipcMain.handle(Channels.browserNewTab, async (_e, kind?: TabKind, url?: string): Promise<string> => {
    if (!activeConvId) return 'Nenhuma conversa ativa.'
    return getBrowser(activeConvId).newTab(kind ?? 'web', url)
  })
  ipcMain.handle(Channels.browserSelectTab, (_e, tabId: string) => activeBrowser()?.selectTab(tabId))
  ipcMain.handle(Channels.browserCloseTab, (_e, tabId: string) => activeBrowser()?.closeTab(tabId))
  ipcMain.handle(Channels.browserSetAndroidSize, (_e, width: number, height: number, dpi?: number) =>
    activeBrowser()?.setAndroidSize(width, height, dpi)
  )

  ipcMain.handle(Channels.browserSetActive, async (_e, convId: string | null) => {
    activeConvId = convId
    const b = convId ? browsers.get(convId) : null
    // Repaint the panel for the newly-shown conversation: either its live page
    // (resized to the current panel) or the empty placeholder if it has none yet.
    if (b) {
      await b.setViewport(desiredViewport.width, desiredViewport.height)
      await b.refreshView()
    } else send(Channels.browserStateChanged, EMPTY_BROWSER_STATE)
  })

  // ---- remote control (smartfone-remote) ----
  // Persist the ON/OFF intent so the bridge auto-starts on the next launch. The
  // HTTP server itself can't survive the process exit, but the user's choice does:
  // "Ligar" → remoteEnabled = true; "Desligar" → false. App close does NOT clear it.
  ipcMain.handle(Channels.remoteStart, async () => {
    assertStorageWritable()
    const info = await remote.start()
    if (info.running) {
      await updateConfig({ remoteEnabled: true })
      relay.start() // dial the VPS broker so remote (off-LAN) access works
    }
    return info
  })
  ipcMain.handle(Channels.remoteStop, async () => {
    assertStorageWritable()
    relay.stop()
    const info = await remote.stop()
    await updateConfig({ remoteEnabled: false })
    return info
  })
  ipcMain.handle(Channels.remoteStatus, () => remote.info())
  ipcMain.handle(Channels.remotePublishState, (_e, state: RemoteStatePayload) => {
    remote.setState(state)
  })
  ipcMain.handle(Channels.remoteBuildApk, async () => {
    const r = await buildRemoteApk(REMOTE_ROOT, (line) =>
      send(Channels.remoteBuildProgress, { line })
    ).catch((err) => ({ ok: false, message: String(err) }))
    send(Channels.remoteBuildProgress, { line: r.message, done: true, ok: r.ok })
    return r
  })

  ipcMain.handle(Channels.browserDispose, async (_e, convId: string) => {
    const b = browsers.get(convId)
    if (!b) return
    browsers.delete(convId)
    await b.close()
    if (activeConvId === convId) {
      activeConvId = null
      send(Channels.browserStateChanged, EMPTY_BROWSER_STATE)
    }
  })
}

const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) app.quit()

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return
  initStore() // prepares the legacy SQLite source and cache folders before the v2 migration
  const cacheInfo = getCacheInfo()
  await storageLifecycle.initialize({
    location: cacheInfo,
    userDataDir: app.getPath('userData'),
    secureStorage: safeStorage,
    appVersion: app.getVersion()
  })
  const storageAvailable = storageLifecycle.canMutate()
  if (storageAvailable) {
    await initializeConfigPersistence()
    await initializeCodexAuthPersistence()
  }
  const skillSync = syncCacheSkills(app.getAppPath(), cacheInfo.dir)
  for (const error of skillSync.errors) console.error(`[skills] ${error}`)
  authLog('=== main started (new build) ===')
  registerIpc()
  createWindow()
  storageLifecycle.subscribe((status) => {
    send(Channels.storageStatusChanged, status)
    if (status.state === 'postgres-offline') {
      for (const [convId, session] of sessions) {
        void session.waitForIdle().catch(() => undefined).finally(() => {
          session.dispose()
          sessions.delete(convId)
          void releaseSessionLease(convId)
        })
      }
    }
  })
  storageLifecycle.subscribeChanges((changes) => {
    void (async () => {
      if (changes.some((change) => change.entity.endsWith('-kv') && change.entityId.startsWith('config.'))) {
        await initializeConfigPersistence()
      }
      if (changes.some((change) => change.entity.endsWith('-kv') && change.entityId === 'codexAuth')) {
        await initializeCodexAuthPersistence()
      }
      send(Channels.storageChanged, changes)
    })().catch((error) => {
      authLog(`change feed apply failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  if (storageAvailable) {
    const exportSnapshot = await storageLifecycle.repository().readExportSnapshot()
    parquetExportPromise = exportConversationsParquet(
      cacheInfo.dir,
      exportSnapshot.conversations,
      cacheInfo.memoriesDir,
      { backend: exportSnapshot.backend, watermark: exportSnapshot.watermark }
    ).catch((error) => {
      authLog(`daily conversation parquet export failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // Runs outside every chat session. The cheap transcript mtime gate happens
  // before any agent is started, and the persisted timestamp keeps it daily.
  if (storageAvailable) stopMemoryCurator = await startMemoryCuratorScheduler()
  // Re-arm the LAN remote bridge if the user had it ON before closing the app, so
  // a paired phone reconnects on its own (the fixed token is already persisted).
  if (storageAvailable && loadConfig().remoteEnabled) {
    void remote
      .start()
      .then(() => relay.start())
      .catch(() => {
        /* no LAN / port busy — the user can re-open the panel and try again */
      })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  windowsControl.stop()
  for (const b of browsers.values()) void b.close()
  browsers.clear()
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
  relay.stop()
  void remote.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  quitRequested = true
  if (!quitReady) {
    event.preventDefault()
    if (mainWindow && !mainWindow.isDestroyed()) {
      requestRendererCloseFlush()
    } else {
      void closeStorageForQuit()
        .then(() => {
          quitReady = true
          app.quit()
        })
        .catch((error) => console.error('[storage] failed to close before quit:', error))
    }
    return
  }
  windowsControl.stop()
  // O transcritor local é um processo Python com o modelo na GPU: fechar o app
  // sem matá-lo deixaria VRAM presa até o usuário perceber no gerenciador.
  stopLocalSpeech()
  stopMemoryCurator?.()
  stopMemoryCurator = null
})
