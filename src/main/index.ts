import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { BrowserController } from './browserController'
import { AgentSession } from './agentSession'
import { Channels } from '../shared/ipc'
import type {
  BrowserInput,
  PermissionResponse,
  StartAgentOptions
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let browser: BrowserController | null = null
let session: AgentSession | null = null

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function getBrowser(): BrowserController {
  if (!browser) {
    browser = new BrowserController({
      onFrame: (frame) => send(Channels.browserFrame, frame),
      onState: (state) => send(Channels.browserStateChanged, state),
      onPicked: (el) => send(Channels.browserPicked, el)
    })
  }
  return browser
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#1f1e1d',
    title: 'Agent Code',
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
  ipcMain.handle(Channels.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(Channels.agentStart, async (_e, opts: StartAgentOptions) => {
    session?.dispose()
    session = new AgentSession(
      opts,
      getBrowser(),
      (event) => send(Channels.agentEvent, event),
      (req) => send(Channels.agentPermissionRequest, req)
    )
    void session.start()
    return { ok: true }
  })

  ipcMain.handle(Channels.agentSend, (_e, text: string) => {
    session?.send(text)
  })

  ipcMain.handle(Channels.agentInterrupt, async () => {
    await session?.interrupt()
  })

  ipcMain.handle(Channels.agentSetBypass, (_e, on: boolean) => {
    session?.setBypass(on)
  })

  ipcMain.handle(Channels.agentPermissionResponse, (_e, res: PermissionResponse) => {
    session?.resolvePermission(res)
  })

  ipcMain.handle(Channels.browserLaunch, async () => {
    await getBrowser().ensureLaunched()
  })
  ipcMain.handle(Channels.browserNavigate, (_e, url: string) => getBrowser().navigate(url))
  ipcMain.handle(Channels.browserBack, () => getBrowser().back())
  ipcMain.handle(Channels.browserForward, () => getBrowser().forward())
  ipcMain.handle(Channels.browserReload, () => getBrowser().reload())
  ipcMain.handle(Channels.browserSetSelectMode, (_e, on: boolean) => getBrowser().setSelectMode(on))
  ipcMain.handle(Channels.browserInput, (_e, ev: BrowserInput) => getBrowser().forwardInput(ev))
  ipcMain.handle(Channels.browserClose, () => getBrowser().close())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void browser?.close()
  session?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
