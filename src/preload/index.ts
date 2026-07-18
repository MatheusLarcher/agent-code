import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { Channels } from '../shared/ipc'
import type { AgentCodeApi } from '../shared/api'
import type {
  AgentEventMsg,
  AgentInterruptResult,
  AndroidProgressMsg,
  AppConfig,
  BrowserFrame,
  BrowserInput,
  BrowserState,
  CacheInfo,
  FileAttachment,
  FileBytes,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  ResolvedPastedRef,
  SkillInfo,
  PermissionExpiredMsg,
  PermissionRequestMsg,
  PermissionResponse,
  PickedElement,
  RemoteBuildProgressMsg,
  RemoteInboundMsg,
  RemotePermissionResponseMsg,
  RemoteSetModelMsg,
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
  setWindowsControlEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(Channels.windowsControlSetEnabled, enabled),
  onWindowsControlChanged: (cb: (enabled: boolean) => void): (() => void) =>
    on(Channels.windowsControlChanged, cb),

  // directory picker
  pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke(Channels.pathExists, path),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(Channels.pickDirectory),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke(Channels.pickFile),
  openInEditor: (dir: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(Channels.openInEditor, dir),
  openInFolder: (dir: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(Channels.openInFolder, dir),
  mentionSearch: (root: string, query: string): Promise<MentionHit[]> =>
    ipcRenderer.invoke(Channels.mentionSearch, root, query),
  listSkills: (root: string): Promise<SkillInfo[]> =>
    ipcRenderer.invoke(Channels.listSkills, root),
  downloadFile: (path: string): Promise<{ ok: boolean; message: string; saved?: string }> =>
    ipcRenderer.invoke(Channels.fileDownload, path),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke(Channels.fileRead, path),
  readFileBytes: (path: string): Promise<FileBytes> => ipcRenderer.invoke(Channels.fileReadBytes, path),
  resolvePastedPath: (path: string): Promise<ResolvedPastedRef> =>
    ipcRenderer.invoke(Channels.resolvePastedPath, path),
  downloadPastedUrl: (url: string, convId: string): Promise<ResolvedPastedRef> =>
    ipcRenderer.invoke(Channels.downloadPastedUrl, url, convId),
  // Synchronous — webUtils runs directly in the preload process, no IPC round
  // trip. Returns '' if the File wasn't constructed from a real path on disk
  // (e.g. a blob built in JS, or a screenshot never saved anywhere).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  getCacheInfo: (): Promise<CacheInfo> => ipcRenderer.invoke(Channels.cacheGetInfo),
  chooseCacheDir: (): Promise<CacheInfo | null> => ipcRenderer.invoke(Channels.cacheChooseDir),
  kvGet: (key: string): Promise<string | null> => ipcRenderer.invoke(Channels.kvGet, key),
  kvSet: (key: string, value: string): Promise<void> => ipcRenderer.invoke(Channels.kvSet, key, value),
  loadAllConversations: (): Promise<unknown[]> => ipcRenderer.invoke(Channels.conversationsLoadAll),
  saveAllConversations: (list: unknown[]): Promise<void> =>
    ipcRenderer.invoke(Channels.conversationsSaveAll, list),

  // OpenAI voice (chat)
  transcribeAudio: (
    audioBase64: string,
    mimeType: string
  ): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke(Channels.openaiTranscribe, audioBase64, mimeType),
  speak: (
    text: string
  ): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }> =>
    ipcRenderer.invoke(Channels.openaiTts, text),
  authStatus: (): Promise<{ authenticated: boolean }> => ipcRenderer.invoke(Channels.authStatus),
  authLogin: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.authLogin),

  // agent
  startAgent: (opts: StartAgentOptions): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(Channels.agentStart, opts),
  sendMessage: (
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    messageUuid?: string
  ): Promise<void> => ipcRenderer.invoke(Channels.agentSend, convId, text, images, files, fileRefs, messageUuid),
  interrupt: (convId: string): Promise<AgentInterruptResult> =>
    ipcRenderer.invoke(Channels.agentInterrupt, convId),
  setBypass: (convId: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke(Channels.agentSetBypass, convId, on),
  respondPermission: (convId: string, res: PermissionResponse): Promise<void> =>
    ipcRenderer.invoke(Channels.agentPermissionResponse, convId, res),
  disposeAgent: (convId: string): Promise<void> => ipcRenderer.invoke(Channels.agentDispose, convId),
  refreshUsage: (convId: string): Promise<void> => ipcRenderer.invoke(Channels.agentRefreshUsage, convId),
  onAgentEvent: (cb: (e: AgentEventMsg) => void): (() => void) => on(Channels.agentEvent, cb),
  onPermissionRequest: (cb: (m: PermissionRequestMsg) => void): (() => void) =>
    on(Channels.agentPermissionRequest, cb),
  onPermissionExpired: (cb: (m: PermissionExpiredMsg) => void): (() => void) =>
    on(Channels.agentPermissionExpired, cb),

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
  newTab: (kind?: TabKind, url?: string): Promise<string> => ipcRenderer.invoke(Channels.browserNewTab, kind, url),
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
  onRemoteSetSkipPerms: (cb: (m: { on: boolean }) => void): (() => void) =>
    on(Channels.remoteSetSkipPerms, cb),
  onRemoteSetModel: (cb: (m: RemoteSetModelMsg) => void): (() => void) =>
    on(Channels.remoteSetModel, cb),
  onRemoteRecoveryAction: (cb: (m: { convId: string; action: 'retry' | 'cancel' }) => void): (() => void) =>
    on(Channels.remoteRecoveryAction, cb),
  onRemotePermissionResponse: (cb: (m: RemotePermissionResponseMsg) => void): (() => void) =>
    on(Channels.remotePermissionResponse, cb),
  onRemoteBuildProgress: (cb: (m: RemoteBuildProgressMsg) => void): (() => void) =>
    on(Channels.remoteBuildProgress, cb),
  onRemoteClients: (cb: (info: RemoteInfo) => void): (() => void) => on(Channels.remoteClients, cb)
}

contextBridge.exposeInMainWorld('api', api)
