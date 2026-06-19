import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '../shared/ipc'
import type { AgentCodeApi } from '../shared/api'
import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  ChatEvent,
  PermissionRequest,
  PermissionResponse,
  PickedElement,
  StartAgentOptions
} from '../shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AgentCodeApi = {
  // directory picker
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(Channels.pickDirectory),

  // agent
  startAgent: (opts: StartAgentOptions): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(Channels.agentStart, opts),
  sendMessage: (text: string): Promise<void> => ipcRenderer.invoke(Channels.agentSend, text),
  interrupt: (): Promise<void> => ipcRenderer.invoke(Channels.agentInterrupt),
  setBypass: (on: boolean): Promise<void> => ipcRenderer.invoke(Channels.agentSetBypass, on),
  respondPermission: (res: PermissionResponse): Promise<void> =>
    ipcRenderer.invoke(Channels.agentPermissionResponse, res),
  onAgentEvent: (cb: (e: ChatEvent) => void): (() => void) => on(Channels.agentEvent, cb),
  onPermissionRequest: (cb: (r: PermissionRequest) => void): (() => void) =>
    on(Channels.agentPermissionRequest, cb),

  // browser
  launchBrowser: (): Promise<void> => ipcRenderer.invoke(Channels.browserLaunch),
  navigate: (url: string): Promise<string> => ipcRenderer.invoke(Channels.browserNavigate, url),
  browserBack: (): Promise<void> => ipcRenderer.invoke(Channels.browserBack),
  browserForward: (): Promise<void> => ipcRenderer.invoke(Channels.browserForward),
  browserReload: (): Promise<void> => ipcRenderer.invoke(Channels.browserReload),
  setSelectMode: (on: boolean): Promise<void> =>
    ipcRenderer.invoke(Channels.browserSetSelectMode, on),
  sendBrowserInput: (ev: BrowserInput): Promise<void> =>
    ipcRenderer.invoke(Channels.browserInput, ev),
  closeBrowser: (): Promise<void> => ipcRenderer.invoke(Channels.browserClose),
  onBrowserFrame: (cb: (f: BrowserFrame) => void): (() => void) => on(Channels.browserFrame, cb),
  onBrowserState: (cb: (s: BrowserState) => void): (() => void) =>
    on(Channels.browserStateChanged, cb),
  onBrowserPicked: (cb: (el: PickedElement) => void): (() => void) =>
    on(Channels.browserPicked, cb)
}

contextBridge.exposeInMainWorld('api', api)
