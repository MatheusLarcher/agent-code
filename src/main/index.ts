import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import { stat as fsStat, copyFile as fsCopyFile, access as fsAccess } from 'node:fs/promises'
import { BrowserController } from './browserController'
import { AgentSession } from './agentSession'
import { RemoteServer } from './remote/remoteServer'
import { buildRemoteApk } from './remote/buildApk'
import { Channels } from '../shared/ipc'
import { loadConfig, updateConfig } from './config'
import type {
  AppConfig,
  BrowserInput,
  ImageAttachment,
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

// LAN bridge: phones POST commands here; we forward them to the renderer (which
// dispatches into the right conversation) and tee live agent events back over SSE.
const remote = new RemoteServer({
  onInbound: (convId, text, images) => send(Channels.remoteInbound, { convId, text, images }),
  apkPath: () => join(REMOTE_ROOT, 'dist', 'agent-remote.apk'),
  wwwDir: () => join(REMOTE_ROOT, 'www'),
  onClientsChanged: (info) => send(Channels.remoteClients, info),
  // Fixed pairing token, persisted in settings.json so phones stay paired.
  loadToken: () => loadConfig().remoteToken,
  saveToken: (token) => updateConfig({ remoteToken: token })
})

/** Get (creating if needed) the browser dedicated to a conversation. */
function getBrowser(convId: string): BrowserController {
  let b = browsers.get(convId)
  if (!b) {
    // Callbacks are gated on `activeConvId` so a background conversation's
    // browser never paints over the one the user is looking at.
    b = new BrowserController({
      onFrame: (frame) => convId === activeConvId && send(Channels.browserFrame, frame),
      onState: (state) => convId === activeConvId && send(Channels.browserStateChanged, state),
      onPicked: (el) => convId === activeConvId && send(Channels.browserPicked, el),
      // Boot progress is tagged with convId so the renderer shows it on the right chat.
      onAndroidProgress: (line) => send(Channels.androidProgress, { convId, line })
    })
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
      contextIsolation: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  // App configuration (Settings screen).
  ipcMain.handle(Channels.configGet, () => loadConfig())
  ipcMain.handle(Channels.configSet, (_e, patch: Partial<AppConfig>) => updateConfig(patch))

  ipcMain.handle(Channels.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(Channels.pickFile, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
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
      (req) => send(Channels.agentPermissionRequest, { convId, req })
    )
    sessions.set(convId, s)
    void s.start()
    return { ok: true }
  })

  ipcMain.handle(Channels.agentSend, (_e, convId: string, text: string, images?: ImageAttachment[]) => {
    sessions.get(convId)?.send(text, images)
  })

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
  ipcMain.handle(Channels.browserNewTab, async (_e, kind?: TabKind): Promise<string> => {
    if (!activeConvId) return 'Nenhuma conversa ativa.'
    return getBrowser(activeConvId).newTab(kind ?? 'web')
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
  ipcMain.handle(Channels.remoteStart, () => remote.start())
  ipcMain.handle(Channels.remoteStop, () => remote.stop())
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
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const b of browsers.values()) void b.close()
  browsers.clear()
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
  void remote.stop()
  if (process.platform !== 'darwin') app.quit()
})
