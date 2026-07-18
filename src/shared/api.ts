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
} from './ipc'

/** The surface exposed on `window.api` by the preload script. */
export interface AgentCodeApi {
  /** Read the persisted app configuration. */
  getConfig(): Promise<AppConfig>
  /** Persist a partial app configuration (merged with what's on disk). */
  setConfig(patch: Partial<AppConfig>): Promise<void>
  /** Toggle the independent high-risk permission for controlling Windows apps. */
  setWindowsControlEnabled(enabled: boolean): Promise<void>
  /** Keep every renderer surface synchronized with the Windows-control gate. */
  onWindowsControlChanged(cb: (enabled: boolean) => void): () => void
  /** Whether a path exists and is a directory (project-folder guard). */
  pathExists(path: string): Promise<boolean>
  pickDirectory(): Promise<string | null>
  /** Native file picker — returns the absolute path, or null if canceled. */
  pickFile(): Promise<string | null>
  /** Open a project folder in VS Code. Returns a status (success or why it failed). */
  openInEditor(dir: string): Promise<{ ok: boolean; message: string }>
  /** Open a project folder in the OS file explorer. Returns a status. */
  openInFolder(dir: string): Promise<{ ok: boolean; message: string }>
  /** Live "@" autocomplete: files/folders under `root` matching `query` (≤ limit hits). */
  mentionSearch(root: string, query: string): Promise<MentionHit[]>
  /** "/" autocomplete: skills available to the agent (project `root` + user-level). */
  listSkills(root: string): Promise<SkillInfo[]>
  /** Save a copy of a file (created by the agent) to Downloads and reveal it. */
  downloadFile(path: string): Promise<{ ok: boolean; message: string; saved?: string }>
  /** Read the content of a local file (e.g. for previewing in the UI). */
  readFile(path: string): Promise<string>
  /** Read a local file as base64 bytes — for binary previews (PDF, images, xlsx…). */
  readFileBytes(path: string): Promise<FileBytes>
  /** Resolve a composer-pasted line as a local file path (stat only, no bytes read). */
  resolvePastedPath(path: string): Promise<ResolvedPastedRef>
  /** Download a composer-pasted http(s) file URL to disk (streamed, no bytes over IPC). */
  downloadPastedUrl(url: string, convId: string): Promise<ResolvedPastedRef>
  /** Absolute path a pasted/dropped `File` points to, or '' if it has no real
   *  file on disk (e.g. a blob built in JS). Synchronous (runs in preload). */
  getPathForFile(file: File): string
  /** Read the active cache folder (SQLite db + .md memories location). */
  getCacheInfo(): Promise<CacheInfo>
  /** Pick a new cache folder and switch to it; resolves null if the dialog was canceled. */
  chooseCacheDir(): Promise<CacheInfo | null>
  /** Read a value (JSON string) from the cache-folder SQLite key→value store. */
  kvGet(key: string): Promise<string | null>
  /** Write a value (JSON string) into the cache-folder SQLite key→value store. */
  kvSet(key: string, value: string): Promise<void>
  /** Load every conversation from every per-project db under `data/` (merged). */
  loadAllConversations(): Promise<unknown[]>
  /** Persist the full conversation list, split one db per project (`cwd`). */
  saveAllConversations(list: unknown[]): Promise<void>

  /** Transcribe recorded audio (base64) to text via OpenAI. `error: 'no-key'`
   *  means the user hasn't set an OpenAI API key yet. */
  transcribeAudio(
    audioBase64: string,
    mimeType: string
  ): Promise<{ ok: boolean; text?: string; error?: string }>
  /** Synthesize speech (base64 MP3) from already-treated text via OpenAI. */
  speak(
    text: string
  ): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }>
  /** Whether a Claude Code login already exists. */
  authStatus(): Promise<{ authenticated: boolean }>
  /** Trigger the Claude OAuth login (opens the system browser); resolves when done. */
  authLogin(): Promise<{ ok: boolean }>

  startAgent(opts: StartAgentOptions): Promise<{ ok: boolean }>
  sendMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    /** Stable SDK uuid used to correlate an interrupt receipt with this bubble. */
    messageUuid?: string
  ): Promise<void>
  interrupt(convId: string): Promise<AgentInterruptResult>
  /** Toggle "allow all" on a conversation's running session. */
  setBypass(convId: string, on: boolean): Promise<void>
  respondPermission(convId: string, res: PermissionResponse): Promise<void>
  /** Dispose a conversation's agent session (on chat deletion). */
  disposeAgent(convId: string): Promise<void>
  /** Poll the latest account-wide rate-limit snapshot for a connected session. */
  refreshUsage(convId: string): Promise<void>
  onAgentEvent(cb: (e: AgentEventMsg) => void): () => void
  onPermissionRequest(cb: (m: PermissionRequestMsg) => void): () => void
  /** Subscribe to permission/question timeouts (auto-resolved) so the renderer
   *  can close the matching modal. Returns an unsubscribe function. */
  onPermissionExpired(cb: (m: PermissionExpiredMsg) => void): () => void

  launchBrowser(): Promise<void>
  navigate(url: string): Promise<string>
  browserBack(): Promise<void>
  browserForward(): Promise<void>
  browserReload(): Promise<void>
  setSelectMode(on: boolean): Promise<void>
  sendBrowserInput(ev: BrowserInput): Promise<void>
  closeBrowser(): Promise<void>
  /** Resize the active browser's viewport (CSS px) to match the panel. */
  setBrowserViewport(width: number, height: number): Promise<void>
  /** Switch the panel to a conversation's browser (null = none). */
  setActiveBrowser(convId: string | null): Promise<void>
  /** Close and forget a conversation's browser. */
  disposeBrowser(convId: string): Promise<void>
  /** Open a new preview tab (defaults to web) on the active browser. Returns a
   *  status string (success message, or why it failed — e.g. Android toolchain missing). */
  newTab(kind?: TabKind, url?: string): Promise<string>
  /** Make a tab the active (controlled/streamed) one. */
  selectTab(tabId: string): Promise<void>
  /** Close a preview tab. */
  closeTab(tabId: string): Promise<void>
  /** Set the active Android preview's screen size (px) — a device model or custom. */
  setAndroidSize(width: number, height: number, dpi?: number): Promise<string>
  onBrowserFrame(cb: (f: BrowserFrame) => void): () => void
  onBrowserState(cb: (s: BrowserState) => void): () => void
  onBrowserPicked(cb: (el: PickedElement) => void): () => void
  /** Boot-progress lines while a conversation's Android device/emulator starts. */
  onAndroidProgress(cb: (m: AndroidProgressMsg) => void): () => void

  // ---- remote control (smartfone-remote) ----
  /** Start the LAN bridge so a phone can drive the sessions. */
  remoteStart(): Promise<RemoteInfo>
  /** Stop the LAN bridge. */
  remoteStop(): Promise<RemoteInfo>
  /** Current bridge status (running, url, token, connected phones). */
  remoteStatus(): Promise<RemoteInfo>
  /** Publish the latest conversation snapshot for the bridge to serve to phones. */
  publishRemoteState(state: RemoteStatePayload): Promise<void>
  /** Build the Android remote APK (smartfone-remote). Progress via onRemoteBuildProgress. */
  buildRemoteApk(): Promise<{ ok: boolean; apkPath?: string; message: string }>
  /** A command arrived from a phone — dispatch it into its conversation. */
  onRemoteInbound(cb: (m: RemoteInboundMsg) => void): () => void
  /** A phone toggled the global "Permitir tudo" switch — apply it on the PC. */
  onRemoteSetSkipPerms(cb: (m: { on: boolean }) => void): () => void
  /** A phone asked to change a conversation's model/effort — apply it on the PC. */
  onRemoteSetModel(cb: (m: RemoteSetModelMsg) => void): () => void
  onRemoteRecoveryAction(cb: (m: { convId: string; action: 'retry' | 'cancel' }) => void): () => void
  /** A phone answered a pending permission/question — resolve it locally too. */
  onRemotePermissionResponse(cb: (m: RemotePermissionResponseMsg) => void): () => void
  /** Progress lines while the remote APK is built. */
  onRemoteBuildProgress(cb: (m: RemoteBuildProgressMsg) => void): () => void
  /** The connected-phone count changed. */
  onRemoteClients(cb: (info: RemoteInfo) => void): () => void
}
