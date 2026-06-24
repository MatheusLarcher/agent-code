// Shared IPC contract between the Electron main process and the renderer.
// Keep this file type-only so it can be imported from main, preload and renderer.

/** A normalized chat event the renderer renders. Produced in main from SDKMessage. */
export type ChatEvent =
  | { kind: 'system'; sessionId: string; model: string; cwd: string; tools: string[] }
  | { kind: 'assistant-text'; id: string; text: string; final: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: 'tool-result'; id: string; toolUseId: string; isError: boolean; text: string }
  | {
      kind: 'result'
      id: string
      isError: boolean
      text: string
      durationMs: number
      costUsd?: number
      /** Real context-window size after this turn (last model request input). */
      contextTokens?: number
      usage?: TokenUsage
    }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

/** An image attached to a user message, sent to the agent as a base64 block. */
export interface ImageAttachment {
  /** MIME type, e.g. "image/png" / "image/jpeg". */
  mediaType: string
  /** Base64 payload, without the `data:...;base64,` prefix. */
  data: string
}

/**
 * A non-image file attached to a user message (Excel, Word, PDF, text, etc.).
 * Main saves it to disk and references it by path so the agent can open it with
 * its own tools — the model doesn't receive the bytes inline.
 */
export interface FileAttachment {
  /** Original file name, e.g. "relatorio.xlsx". */
  name: string
  /** MIME type (best-effort; "application/octet-stream" when unknown). */
  mediaType: string
  /** Base64 payload, without the `data:...;base64,` prefix. */
  data: string
  /** Size in bytes (for the chip label). */
  size: number
}

/**
 * Extensions treated as "deliverables" — finished artifacts a user would ask to
 * be created and then download (an APK, a zip, a PDF, an image…). Deliberately
 * excludes source/code/config/text the agent edits while working, so the chat's
 * "⬇️ Baixar" affordance only shows on real outputs, not on every file touched.
 */
export const DOWNLOADABLE_EXTS: ReadonlySet<string> = new Set([
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z',
  // app packages / installers / binaries
  'apk', 'aab', 'ipa', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'iso', 'jar', 'bin',
  // documents / spreadsheets / slides
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'csv',
  // media
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'mp4', 'mov', 'webm', 'avi', 'mkv',
  'mp3', 'wav', 'ogg', 'flac',
  // fonts
  'ttf', 'otf', 'woff', 'woff2'
])

/** True when `path` ends in a deliverable extension (see DOWNLOADABLE_EXTS). */
export function isDownloadableFile(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? DOWNLOADABLE_EXTS.has(m[1].toLowerCase()) : false
}

/** Marker the agent emits to expose a file for download in the chat: `[[download:PATH]]`. */
export const DOWNLOAD_MARKER = /\[\[download:\s*([^\]\n]+?)\s*\]\]/g

/**
 * Split assistant text into the visible markdown (markers removed) and the list
 * of absolute file paths the agent flagged as downloadable.
 */
export function parseDownloads(text: string): { clean: string; paths: string[] } {
  const paths: string[] = []
  const clean = text
    .replace(DOWNLOAD_MARKER, (_m, p: string) => {
      const path = p.trim()
      if (path) paths.push(path)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, paths }
}

/** One option of an AskUserQuestion question. */
export interface AskQuestionOption {
  label: string
  description: string
}

/** A single AskUserQuestion question (the agent asks the user to choose). */
export interface AskQuestion {
  /** Short chip/tag for the question. */
  header: string
  /** The full question text. */
  question: string
  /** When true, the user may pick several options. */
  multiSelect: boolean
  options: AskQuestionOption[]
}

/** The user's answer to one AskUserQuestion question. */
export interface QuestionAnswer {
  header: string
  question: string
  /** Selected option labels and/or free-text ("Outro"). */
  selected: string[]
}

/** Agent asks the user to approve a tool call. When `questions` is present the
 *  request is an `AskUserQuestion` interactive prompt (rendered as a choice
 *  dialog, not the plain allow/deny modal) — its answer is fed back to the model. */
export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  questions?: AskQuestion[]
}

/** A chat event tagged with the conversation whose agent produced it. Each
 *  conversation runs its own independent agent session in the main process. */
export interface AgentEventMsg {
  convId: string
  event: ChatEvent
}

/** A permission request tagged with the conversation that needs it. */
export interface PermissionRequestMsg {
  convId: string
  req: PermissionRequest
}

export interface PermissionResponse {
  id: string
  behavior: 'allow' | 'deny'
  /** When true, remember the decision for this tool name for the rest of the session. */
  always?: boolean
  message?: string
  /** Present when answering an AskUserQuestion: the user's picks per question.
   *  The main process turns these into the tool's reply to the model. */
  answers?: QuestionAnswer[]
}

/** A live frame from a preview tab (web CDP screencast, or an Android device). */
export interface BrowserFrame {
  /** base64-encoded image (no data: prefix). */
  data: string
  /** Natural pixel size of the captured page/screen. */
  width: number
  height: number
  /** Image encoding of `data`. Web tabs stream JPEG; Android tabs stream PNG. Defaults to JPEG. */
  mime?: 'image/jpeg' | 'image/png'
}

/**
 * Kind of preview surface a tab renders. `web` (Playwright) and `android`
 * (a live device/emulator screen) are functional; `stitch` is a web-backed tab
 * that renders a Google Stitch design for visual approval (opened by the agent,
 * not manually); `iphone` is reserved (name + icon) for a future implementation.
 */
export type TabKind = 'web' | 'android' | 'stitch' | 'iphone'

/** Display + capability metadata for each preview kind (single source of truth). */
export interface TabKindMeta {
  kind: TabKind
  /** Short word shown in the tab label AND to the LLM (e.g. "web"). */
  label: string
  /** Human label for menus, e.g. "Android". */
  display: string
  /** Whether the kind can actually be opened yet. */
  implemented: boolean
}

export const TAB_KINDS: Record<TabKind, TabKindMeta> = {
  web: { kind: 'web', label: 'web', display: 'Web', implemented: true },
  android: { kind: 'android', label: 'android', display: 'Android', implemented: true },
  // Implemented, but opened by the agent (carries generated HTML) — never offered
  // in the manual "new tab" modal, so it isn't listed there.
  stitch: { kind: 'stitch', label: 'stitch', display: 'Stitch', implemented: true },
  iphone: { kind: 'iphone', label: 'iphone', display: 'iPhone', implemented: false }
}

/** A single preview tab, as seen by the renderer and the LLM. */
export interface TabInfo {
  id: string
  kind: TabKind
  /** Page/site title (empty when blank or not loaded). */
  title: string
  url: string
  /** True for the one tab currently being controlled/streamed. */
  active: boolean
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The canonical tab name shown in the UI (after its icon) and given to the LLM,
 * e.g. `web - Google`. Falls back to the host, then to "nova aba".
 */
export function tabName(t: { kind: TabKind; title: string; url: string }): string {
  const site = (t.title && t.title.trim()) || hostOf(t.url) || 'nova aba'
  return `${TAB_KINDS[t.kind].label} - ${site}`
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  launched: boolean
  /** All preview tabs of the active conversation's browser (in tab-strip order). */
  tabs: TabInfo[]
  /** Active Android tab's current screen size (px) — drives the device frame. */
  androidSize?: { width: number; height: number }
}

/** Element captured by the "select on page" picker, forwarded to the chat composer. */
export interface PickedElement {
  selector: string
  tagName: string
  id: string
  classes: string
  text: string
  html: string
  url: string
  /** Id of the tab the element was picked from (so the LLM acts on the right tab). */
  tabId: string
  /** Display name of that tab, e.g. "web - Google". */
  tabName: string
}

/** Input event forwarded from the renderer canvas back into the page. */
export type BrowserInput =
  | { type: 'move'; nx: number; ny: number }
  | { type: 'down'; nx: number; ny: number; button: 'left' | 'right' | 'middle' }
  | { type: 'up'; nx: number; ny: number; button: 'left' | 'right' | 'middle' }
  | { type: 'click'; nx: number; ny: number; button: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; nx: number; ny: number; dx: number; dy: number }
  | {
      type: 'key'
      key: string
      text?: string
      /** Modifier state — lets us bridge Ctrl/Cmd combos (copy/paste/cut/select-all). */
      ctrl?: boolean
      meta?: boolean
      shift?: boolean
      alt?: boolean
    }

/** Per-turn token usage reported by the agent. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface StartAgentOptions {
  /** Conversation this agent serves — also keys its dedicated browser instance. */
  convId: string
  cwd: string
  model?: string
  /** Start the agent with permission prompts disabled (--dangerously-skip-permissions). */
  skipPermissions?: boolean
  /** SDK session id to resume — loads the prior conversation history so an old chat can continue. */
  resume?: string
}

// ---- App configuration (persisted in the main process) ------------------

/** Google Stitch integration (optional). When enabled with a valid API key, the
 *  agent gets the Stitch MCP tools to generate UI mockups. */
export interface StitchConfig {
  enabled: boolean
  /** API key from Stitch → Settings → API Keys (sent as the X-Goog-Api-Key header). */
  apiKey: string
}

/** OpenAI integration (optional). When an API key is set, the chat gets voice
 *  input (speech→text, gpt-4o-mini-transcribe) and read-aloud (text→speech,
 *  gpt-4o-mini-tts). The key is stored only in the cache-folder SQLite db. */
export interface OpenAiConfig {
  /** API key from platform.openai.com → API keys (sent as a Bearer header by main). */
  apiKey: string
}

/** Everything the user can configure — persisted across app restarts. */
export interface AppConfig {
  stitch: StitchConfig
  /** OpenAI key for chat voice (TTS + speech-to-text). */
  openai: OpenAiConfig
  /** "Permitir tudo": run new sessions with permission prompts disabled. Persisted. */
  skipPermissions: boolean
  /** Fixed pairing token for the LAN remote bridge. Generated once and reused on
   *  every start so a paired phone never has to re-pair. Empty until first use. */
  remoteToken: string
  /** Whether the user turned the LAN remote bridge ON. Persisted so it auto-starts
   *  on the next app launch — the user shouldn't have to re-enable it every time.
   *  Set true on "Ligar ponte", false only on explicit "Desligar". */
  remoteEnabled: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  stitch: { enabled: false, apiKey: '' },
  openai: { apiKey: '' },
  skipPermissions: false,
  remoteToken: '',
  remoteEnabled: false
}

/** Where per-user data lives: the SQLite db (config/token/conversations) + .md memories. */
export interface CacheInfo {
  /** Absolute path of the active cache folder (…/agent-code). */
  dir: string
  /** Absolute path of the SQLite database inside it. */
  dbPath: string
  /** Absolute path of the memories folder inside it. */
  memoriesDir: string
}

// Channel name constants — single source of truth.
export const Channels = {
  // renderer -> main (invoke)
  /** Read the persisted app configuration (Settings screen). */
  configGet: 'config:get',
  /** Persist the app configuration (Settings screen). */
  configSet: 'config:set',
  /** Get the active cache folder (where the SQLite db + .md memories live). */
  cacheGetInfo: 'cache:get-info',
  /** Pick a new cache folder (native dialog) and switch to it; returns the new CacheInfo. */
  cacheChooseDir: 'cache:choose-dir',
  /** Read a value (JSON string) from the cache-folder SQLite key→value store. */
  kvGet: 'kv:get',
  /** Write a value (JSON string) into the cache-folder SQLite key→value store. */
  kvSet: 'kv:set',
  agentStart: 'agent:start',
  agentSend: 'agent:send',
  agentInterrupt: 'agent:interrupt',
  agentSetBypass: 'agent:set-bypass',
  agentPermissionResponse: 'agent:permission-response',
  /** Dispose a conversation's agent session (e.g. when the chat is deleted). */
  agentDispose: 'agent:dispose',
  pickDirectory: 'app:pick-directory',
  pickFile: 'app:pick-file',
  /** Open a project folder in VS Code (via the `code` CLI, falling back to the vscode:// URL). */
  openInEditor: 'app:open-in-editor',
  /** Save a copy of an agent-created file to the Downloads folder and reveal it. */
  fileDownload: 'app:file-download',
  browserLaunch: 'browser:launch',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetSelectMode: 'browser:set-select-mode',
  browserInput: 'browser:input',
  browserClose: 'browser:close',
  /** Resize the active browser's viewport (CSS px) to match the panel. */
  browserSetViewport: 'browser:set-viewport',
  /** Tell main which conversation's browser the panel is currently showing. */
  browserSetActive: 'browser:set-active',
  /** Close and discard a conversation's browser (e.g. when the chat is deleted). */
  browserDispose: 'browser:dispose',
  /** Open a new preview tab (web/android) on the active conversation's browser. */
  browserNewTab: 'browser:new-tab',
  /** Switch which tab is active (controlled/streamed). */
  browserSelectTab: 'browser:select-tab',
  /** Close a preview tab by id. */
  browserCloseTab: 'browser:close-tab',
  /** Set the active Android preview's screen size (device model or custom). */
  browserSetAndroidSize: 'browser:set-android-size',
  /** Start the LAN remote bridge; resolves with RemoteInfo (url/token/ip/port). */
  remoteStart: 'remote:start',
  /** Stop the LAN remote bridge. */
  remoteStop: 'remote:stop',
  /** Query the bridge status (RemoteInfo). */
  remoteStatus: 'remote:status',
  /** Renderer → main: publish the latest conversation snapshot for the bridge to serve. */
  remotePublishState: 'remote:publish-state',
  /** Build the Android remote APK (smartfone-remote); progress streams back. */
  remoteBuildApk: 'remote:build-apk',
  /** Transcribe recorded audio to text via OpenAI (gpt-4o-mini-transcribe). */
  openaiTranscribe: 'openai:transcribe',
  /** Synthesize speech from text via OpenAI (gpt-4o-mini-tts). */
  openaiTts: 'openai:tts',
  // main -> renderer (send)
  agentEvent: 'agent:event',
  agentPermissionRequest: 'agent:permission-request',
  browserFrame: 'browser:frame',
  browserStateChanged: 'browser:state',
  browserPicked: 'browser:picked',
  /** Progress lines while a conversation's Android device/emulator boots. */
  androidProgress: 'browser:android-progress',
  /** main → renderer: a command arrived from a phone, dispatch it into its conversation. */
  remoteInbound: 'remote:inbound',
  /** main → renderer: progress while building the remote APK. */
  remoteBuildProgress: 'remote:build-progress',
  /** main → renderer: the number of connected phones changed (RemoteInfo). */
  remoteClients: 'remote:clients'
} as const

/** A progress line emitted while an Android device/emulator boots, tagged with
 *  the conversation whose preview is starting. */
export interface AndroidProgressMsg {
  convId: string
  line: string
}

// ---- Remote control (smartfone-remote) ----------------------------------
// The PC runs a small LAN bridge (HTTP + SSE) so a phone can drive the same
// Claude Code sessions: it sends commands to the PC and the PC forwards them to
// the agent, while live events stream back to the phone.

/** Connection info for the remote bridge, shown in the QR/modal on the PC. */
export interface RemoteInfo {
  running: boolean
  /** Full URL encoded in the QR, e.g. `http://192.168.0.10:8765/?token=ab12`. */
  url: string
  /** LAN IPv4 the phone should reach (empty if none detected). */
  ip: string
  port: number
  /** Pairing token required by every /api/* call. */
  token: string
  /** How many phones currently have a live event stream open. */
  clients: number
}

/** One conversation as mirrored to the phone (history + live status). The
 *  `messages` are the renderer's UIMessage objects, passed through as JSON. */
export interface RemoteConversation {
  id: string
  title: string
  cwd: string
  busy: boolean
  connected: boolean
  updatedAt: number
  messages: unknown[]
}

/** Snapshot the renderer publishes to main so the bridge can serve history. */
export interface RemoteStatePayload {
  conversations: RemoteConversation[]
}

/** A command received from a phone, forwarded to the renderer to dispatch into
 *  the matching conversation's agent session (phone → PC → Claude Code). */
export interface RemoteInboundMsg {
  convId: string
  text: string
  /** Optional images attached on the phone, forwarded to the agent. */
  images?: ImageAttachment[]
}

/** A progress line emitted while the remote APK is being built. */
export interface RemoteBuildProgressMsg {
  line: string
  /** Set on the terminal line: whether the build finished successfully. */
  done?: boolean
  ok?: boolean
}
