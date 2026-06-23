import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '../shared/ipc'
import type { AgentCodeApi } from '../shared/api'
import type {
  AgentEventMsg,
  AndroidProgressMsg,
  AppConfig,
  BrowserFrame,
  BrowserInput,
  BrowserState,
  FileAttachment,
  ImageAttachment,
  PermissionRequestMsg,
  PermissionResponse,
  PickedElement,
  RemoteBuildProgressMsg,
  RemoteInboundMsg,
  RemoteInfo,
  RemoteStatePayload,
  StartAgentOptions,
  TabKind
} from '../shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AgentCodeApi = {
  // app config (Settings screen)
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(Channels.configGet),
  setConfig: (patch: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke(Channels.configSet, patch),

  // directory picker
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(Channels.pickDirectory),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke(Channels.pickFile),
  openInEditor: (dir: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(Channels.openInEditor, dir),
  downloadFile: (path: string): Promise<{ ok: boolean; message: string; saved?: string }> =>
    ipcRenderer.invoke(Channels.fileDownload, path),

  // agent
  startAgent: (opts: StartAgentOptions): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(Channels.agentStart, opts),
  sendMessage: (
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[]
  ): Promise<void> => ipcRenderer.invoke(Channels.agentSend, convId, text, images, files),
  interrupt: (convId: string): Promise<void> => ipcRenderer.invoke(Channels.agentInterrupt, convId),
  setBypass: (convId: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke(Channels.agentSetBypass, convId, on),
  respondPermission: (convId: string, res: PermissionResponse): Promise<void> =>
    ipcRenderer.invoke(Channels.agentPermissionResponse, convId, res),
  disposeAgent: (convId: string): Promise<void> => ipcRenderer.invoke(Channels.agentDispose, convId),
  onAgentEvent: (cb: (e: AgentEventMsg) => void): (() => void) => on(Channels.agentEvent, cb),
  onPermissionRequest: (cb: (m: PermissionRequestMsg) => void): (() => void) =>
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
  setBrowserViewport: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke(Channels.browserSetViewport, width, height),
  setActiveBrowser: (convId: string | null): Promise<void> =>
    ipcRenderer.invoke(Channels.browserSetActive, convId),
  disposeBrowser: (convId: string): Promise<void> =>
    ipcRenderer.invoke(Channels.browserDispose, convId),
  newTab: (kind?: TabKind): Promise<string> => ipcRenderer.invoke(Channels.browserNewTab, kind),
  selectTab: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.browserSelectTab, tabId),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke(Channels.browserCloseTab, tabId),
  setAndroidSize: (width: number, height: number, dpi?: number): Promise<string> =>
    ipcRenderer.invoke(Channels.browserSetAndroidSize, width, height, dpi),
  onBrowserFrame: (cb: (f: BrowserFrame) => void): (() => void) => on(Channels.browserFrame, cb),
  onBrowserState: (cb: (s: BrowserState) => void): (() => void) =>
    on(Channels.browserStateChanged, cb),
  onBrowserPicked: (cb: (el: PickedElement) => void): (() => void) =>
    on(Channels.browserPicked, cb),
  onAndroidProgress: (cb: (m: AndroidProgressMsg) => void): (() => void) =>
    on(Channels.androidProgress, cb),

  // remote control (smartfone-remote)
  remoteStart: (): Promise<RemoteInfo> => ipcRenderer.invoke(Channels.remoteStart),
  remoteStop: (): Promise<RemoteInfo> => ipcRenderer.invoke(Channels.remoteStop),
  remoteStatus: (): Promise<RemoteInfo> => ipcRenderer.invoke(Channels.remoteStatus),
  publishRemoteState: (state: RemoteStatePayload): Promise<void> =>
    ipcRenderer.invoke(Channels.remotePublishState, state),
  buildRemoteApk: (): Promise<{ ok: boolean; apkPath?: string; message: string }> =>
    ipcRenderer.invoke(Channels.remoteBuildApk),
  onRemoteInbound: (cb: (m: RemoteInboundMsg) => void): (() => void) =>
    on(Channels.remoteInbound, cb),
  onRemoteBuildProgress: (cb: (m: RemoteBuildProgressMsg) => void): (() => void) =>
    on(Channels.remoteBuildProgress, cb),
  onRemoteClients: (cb: (info: RemoteInfo) => void): (() => void) => on(Channels.remoteClients, cb)
}

contextBridge.exposeInMainWorld('api', api)
