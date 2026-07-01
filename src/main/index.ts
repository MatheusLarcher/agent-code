import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
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
import { AgentSession } from './agentSession'
import { RemoteServer } from './remote/remoteServer'
import { RelayClient } from './remote/relayClient'
import { buildRemoteApk } from './remote/buildApk'
import { Channels, REMOTE_RELAY_WS } from '../shared/ipc'
import { loadConfig, updateConfig } from './config'
import { transcribeAudio, synthesizeSpeech } from './openai'
import { isAuthenticated } from './auth'
import { runClaudeLogin } from './login'
import { appendFileSync } from 'node:fs'
import { initStore, getCacheInfo, setCacheDir, kvGet, kvSet } from './store'
import { saveAttachments } from './attachments'
import type {
  AppConfig,
  BrowserInput,
  FileAttachment,
  FileBytes,
  ImageAttachment,
  MentionHit,
  SkillInfo,
  PermissionResponse,
  RemoteStatePayload,
  StartAgentOptions,
  TabKind
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null

// One independent agent session per conversation — they run concurrently, so
// switching/sending in one conversation never cancels another's running task.
const sessions = new Map<string, AgentSession>()

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
  mainWindow?.webContents.send(channel, payload)
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

// ---- "/" autocomplete: list the agent's skills --------------------------------

/**
 * Pull `name` and `description` out of a SKILL.md frontmatter block. Handles the
 * three shapes seen in this repo: `description: "..."`, `description: ...`, and a
 * YAML block scalar (`description: >-` followed by indented lines). The
 * description is collapsed to a single line for the menu subtitle.
 */
function parseSkillFrontmatter(md: string): { name: string; description: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  let name = ''
  let description = ''
  for (let i = 0; i < lines.length; i++) {
    const nameM = /^name:\s*(.+)$/.exec(lines[i])
    if (nameM) {
      name = nameM[1].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    const descM = /^description:\s*(.*)$/.exec(lines[i])
    if (descM) {
      const inline = descM[1].trim()
      // Block scalar (">", "|", ">-", "|-") or empty → gather indented continuation.
      if (inline === '' || /^[>|][-+]?$/.test(inline)) {
        const buf: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s/.test(lines[j]) || lines[j].trim() === '') buf.push(lines[j].trim())
          else break
        }
        description = buf.join(' ').trim()
      } else {
        description = inline.replace(/^['"]|['"]$/g, '')
      }
    }
  }
  if (!name) return null
  return { name, description: description.replace(/\s+/g, ' ').trim() }
}

/**
 * List the skills available to the agent: each subfolder with a SKILL.md under
 * the project's `.claude/skills` and `.agents/skills`, plus the user-level
 * `~/.claude/skills`. Deduped by name (project wins), sorted alphabetically.
 */
async function listAgentSkills(projectRoot: string): Promise<SkillInfo[]> {
  const roots = [
    projectRoot ? join(projectRoot, '.claude', 'skills') : '',
    projectRoot ? join(projectRoot, '.agents', 'skills') : '',
    join(homedir(), '.claude', 'skills')
  ].filter(Boolean)

  const byName = new Map<string, SkillInfo>()
  for (const root of roots) {
    let dirs: import('node:fs').Dirent[]
    try {
      dirs = await fsReaddir(root, { withFileTypes: true })
    } catch {
      continue // skills dir absent — skip
    }
    for (const d of dirs) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue
      try {
        const md = await fsReadFile(join(root, d.name, 'SKILL.md'), 'utf8')
        const parsed = parseSkillFrontmatter(md)
        if (parsed && !byName.has(parsed.name)) byName.set(parsed.name, parsed)
      } catch {
        /* no SKILL.md here — skip */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// LAN bridge: phones POST commands here; we forward them to the renderer (which
// dispatches into the right conversation) and tee live agent events back over SSE.
const remote = new RemoteServer({
  onInbound: (convId, text, images) => send(Channels.remoteInbound, { convId, text, images }),
  onSetSkipPerms: (on) => send(Channels.remoteSetSkipPerms, { on }),
  apkPath: () => join(REMOTE_ROOT, 'dist', 'agent-remote.apk'),
  wwwDir: () => join(REMOTE_ROOT, 'www'),
  onClientsChanged: (info) => send(Channels.remoteClients, info),
  // Fixed pairing token, persisted in settings.json so phones stay paired.
  loadToken: () => loadConfig().remoteToken,
  saveToken: (token) => updateConfig({ remoteToken: token }),
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

  mainWindow.on('closed', () => {
    mainWindow = null
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
  // App configuration (Settings screen).
  ipcMain.handle(Channels.configGet, () => loadConfig())
  ipcMain.handle(Channels.configSet, (_e, patch: Partial<AppConfig>) => updateConfig(patch))

  // OpenAI voice (chat): speech-to-text and text-to-speech. The key stays in main
  // (read from config); the renderer only ships audio/text. Errors come back as
  // { ok: false } so the UI can show a toast / prompt for the key.
  ipcMain.handle(Channels.openaiTranscribe, async (_e, audioBase64: string, mimeType: string) => {
    const apiKey = loadConfig().openai.apiKey.trim()
    if (!apiKey) return { ok: false, error: 'no-key' }
    try {
      const text = await transcribeAudio(apiKey, audioBase64, mimeType)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
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
    return setCacheDir(res.filePaths[0])
  })
  ipcMain.handle(Channels.kvGet, (_e, key: string) => kvGet(key))
  ipcMain.handle(Channels.kvSet, (_e, key: string, value: string) => kvSet(key, value))

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

  ipcMain.handle(Channels.agentStart, async (_e, opts: StartAgentOptions) => {
    const { convId } = opts
    // Replace only THIS conversation's session; others keep running.
    sessions.get(convId)?.dispose()
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
      (id) => send(Channels.agentPermissionExpired, { convId, id })
    )
    sessions.set(convId, s)
    void s.start()
    return { ok: true }
  })

  ipcMain.handle(
    Channels.agentSend,
    async (_e, convId: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => {
      let finalText = text
      // Non-image files are saved to disk and referenced by path so the agent can
      // open them with its own tools (Read, scripts, etc.).
      if (files && files.length > 0) {
        const saved = await saveAttachments(convId, files)
        if (saved.length > 0) {
          const refs = saved.map((s) => `- ${s.name}: ${s.path}`).join('\n')
          const note = `Arquivos anexados pelo usuário (abra-os com suas ferramentas, ex.: Read, se forem relevantes):\n${refs}`
          finalText = finalText ? `${finalText}\n\n${note}` : note
        }
      }
      sessions.get(convId)?.send(finalText, images)
    }
  )

  ipcMain.handle(Channels.agentInterrupt, async (_e, convId: string) => {
    await sessions.get(convId)?.interrupt()
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
    const info = await remote.start()
    if (info.running) {
      updateConfig({ remoteEnabled: true })
      relay.start() // dial the VPS broker so remote (off-LAN) access works
    }
    return info
  })
  ipcMain.handle(Channels.remoteStop, async () => {
    relay.stop()
    const info = await remote.stop()
    updateConfig({ remoteEnabled: false })
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

app.whenReady().then(() => {
  initStore() // open the cache-folder SQLite db (+ migrate legacy settings.json) before anything reads config
  authLog('=== main started (new build) ===')
  registerIpc()
  createWindow()
  // Re-arm the LAN remote bridge if the user had it ON before closing the app, so
  // a paired phone reconnects on its own (the fixed token is already persisted).
  if (loadConfig().remoteEnabled) {
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
  for (const b of browsers.values()) void b.close()
  browsers.clear()
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
  relay.stop()
  void remote.stop()
  if (process.platform !== 'darwin') app.quit()
})
