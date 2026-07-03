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
  /** Anthropic ACCOUNT rate-limit status (5h session / weekly / etc.) — not
   *  tied to this conversation. The renderer routes this straight into a
   *  global (not per-conversation) state; it never becomes a chat bubble. */
  | { kind: 'rate-limit'; limits: RateLimitStatus }

/** One rate-limit window's status, mirroring the SDK's `rate_limit_event`.
 *  Only sent for claude.ai subscription (Pro/Max) sessions — a bare API key
 *  never triggers this, so the UI must handle "no data yet" gracefully. */
export interface RateLimitStatus {
  rateLimitType:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
    | 'seven_day_overage_included'
    | 'overage'
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** Fraction of the window used, 0..1, when known. */
  utilization?: number
  /** Epoch ms when this window resets, when known. */
  resetsAt?: number
  /** Epoch ms when this snapshot was produced locally (for stale-checking + persistence). */
  updatedAt?: number
}

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

/** One hit in the "@" autocomplete: a file or folder under the project. */
export interface MentionHit {
  /** Path relative to the project root, with forward slashes (e.g. "src/main/index.ts"). */
  path: string
  /** Just the file/folder name (e.g. "index.ts"). */
  name: string
  /** True for a directory, false for a file. */
  isDir: boolean
}

/** Result of reading a file as raw bytes (base64) for binary previews. */
export type FileBytes =
  | { ok: true; base64: string; size: number }
  | { ok: false; error: string }

/** One skill in the "/" autocomplete (from a SKILL.md frontmatter). */
export interface SkillInfo {
  /** Skill slug, e.g. "planejar" — inserted as `/planejar` to activate it. */
  name: string
  /** One-line summary (frontmatter `description`, collapsed to a single line). */
  description: string
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

/**
 * Text-like extensions the "👁️ Preview" file window can render. Markdown,
 * plain text, config and source/markup files — anything `readFile` can show as
 * text. Binary deliverables (apk, png, pdf…) are intentionally excluded: they
 * get the "⬇️ Baixar" chip instead, since previewing them as text is useless.
 */
export const TEXT_PREVIEW_EXTS: ReadonlySet<string> = new Set([
  // docs / plain text
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rst', 'adoc',
  // data / config
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf', 'properties',
  'xml', 'csv', 'tsv',
  // markup / styles
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  // scripts / source
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'swift', 'lua', 'r', 'pl',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'gradle'
])

/**
 * True when `path` can be opened in the text "Janela de Arquivo" preview. Files
 * with no extension (LICENSE, Dockerfile, Makefile…) are treated as text too.
 */
export function isTextPreviewable(path: string): boolean {
  const base = path.split(/[\\/]/).pop() || path
  const m = /\.([a-z0-9]+)$/i.exec(base)
  if (!m) return true // extensionless files are almost always plain text/config
  return TEXT_PREVIEW_EXTS.has(m[1].toLowerCase())
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
  /** Epoch ms when this request auto-resolves if the user doesn't respond
   *  (questions → proceed without an answer; tool permissions → auto-deny).
   *  Drives the countdown bar in the modal. */
  deadline?: number
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

/** main → renderer: a pending permission/question auto-resolved (timed out), so
 *  the renderer should close its modal for that conversation. */
export interface PermissionExpiredMsg {
  convId: string
  id: string
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
export type TabKind = 'web' | 'android' | 'stitch' | 'iphone' | 'file'

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
  iphone: { kind: 'iphone', label: 'iphone', display: 'iPhone', implemented: false },
  file: { kind: 'file', label: 'file', display: 'Arquivo', implemented: true }
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
  /** Reasoning effort for the model (low / medium / high / xhigh / max). */
  effort?: string
}

/** Reasoning effort levels a model may support. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Which effort levels each model supports. Haiku stops at high; Opus/Sonnet/Fable go to max.
 *  Ollama models don't support effort at all. */
export const MODEL_EFFORT: Record<string, EffortLevel[]> = {
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-4-5': ['low', 'medium', 'high'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max']
}

/** Default effort when none is selected — "high" is the Anthropic default. */
export const DEFAULT_EFFORT: EffortLevel = 'high'

// ---- App configuration (persisted in the main process) ------------------

/** Google Stitch integration (optional). When enabled with a valid API key, the
 *  agent gets the Stitch MCP tools to generate UI mockups. */
export interface StitchConfig {
  enabled: boolean
  /** API key from Stitch → Settings → API Keys (sent as the X-Goog-Api-Key header). */
  apiKey: string
}

/** Voices offered by gpt-4o-mini-tts (shown in the Settings dropdown). */
export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse'
] as const
export type OpenAiVoice = (typeof OPENAI_VOICES)[number]

// ---- Ollama Cloud integration -------------------------------------------
// Ollama Cloud exposes an Anthropic-compatible Messages API, so the bundled
// Claude Code CLI can talk to it unchanged — we just point it at Ollama via
// env vars (see agentSession.ts). The user picks an Ollama model in the same
// model selector as Opus/Sonnet/Haiku; auth is the Ollama API key (no Anthropic
// login needed). Models keep their `:cloud` tag, which is also how we detect
// "this is an Ollama model" everywhere (see isOllamaModel).

/** Base URL for Ollama Cloud's Anthropic-compatible endpoint. Set as
 *  ANTHROPIC_BASE_URL; the CLI appends `/v1/messages`. */
export const OLLAMA_BASE_URL = 'https://ollama.com'

// Curated Ollama Cloud models offered in the model selector (id = exact Ollama
// tag). Models marked "assinatura" require a paid Ollama plan (the free tier
// returns a permission_error); the gpt-oss and qwen3-coder tags work on the free
// tier. Tags were verified live against https://ollama.com/v1/messages.
export const OLLAMA_MODELS = [
  { id: 'qwen3-coder:480b-cloud', label: 'Qwen3 Coder 480B (Ollama)' },
  { id: 'gpt-oss:120b-cloud', label: 'GPT-OSS 120B (Ollama)' },
  { id: 'gpt-oss:20b-cloud', label: 'GPT-OSS 20B (Ollama)' },
  { id: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro (Ollama · assinatura)' },
  { id: 'glm-5.2:cloud', label: 'GLM 5.2 (Ollama · assinatura)' },
  { id: 'kimi-k2.7-code:cloud', label: 'Kimi K2.7 Code (Ollama · assinatura)' }
] as const

/** True when `model` is an Ollama Cloud model (routes through Ollama, not Anthropic).
 *  Any `:cloud`-tagged id counts, so future Ollama models work without a code change. */
export function isOllamaModel(model: string | undefined): boolean {
  if (!model) return false
  return model.endsWith(':cloud') || OLLAMA_MODELS.some((m) => m.id === model)
}

/** Ollama Cloud models in OLLAMA_MODELS confirmed to accept image input
 *  THROUGH OLLAMA'S OWN Anthropic-compatible cloud endpoint (`POST
 *  https://ollama.com/v1/messages` with an image block) — not just "the base
 *  model has a vision encoder somewhere". Verified with a live probe against
 *  every model in OLLAMA_MODELS: only `kimi-k2.7-code:cloud` returned 200 (it
 *  actually processed the image); the other five all returned 400 `this model
 *  does not support image input`. Re-verify the same way before adding
 *  anything here — a wrong entry sends a raw image straight to a model that
 *  400s, exactly the bug this list exists to prevent. */
const OLLAMA_VISION_MODELS = new Set(['kimi-k2.7-code:cloud'])

/** Whether `model` can accept an image directly. All Claude models support
 *  vision; for Ollama Cloud, only the models in OLLAMA_VISION_MODELS do —
 *  everything else routes through the vision-fallback relay
 *  (vision_fallback_router in src/main/visionRelay.ts) instead. */
export function modelSupportsVision(model: string | undefined): boolean {
  if (!model) return true
  if (!isOllamaModel(model)) return true
  return OLLAMA_VISION_MODELS.has(model)
}

/** Fallback context window for a model not listed in CONTEXT_LIMITS. */
export const DEFAULT_CONTEXT_LIMIT = 200_000

/** Context-window size (max input tokens) per model — the denominator of the
 *  context-usage bar. Anthropic values are authoritative (Anthropic model
 *  catalog): the Opus 4.x family and Sonnet 5 are 1M, Haiku 4.5 is 200K.
 *  Ollama Cloud values are best-effort native context windows. Unknown models
 *  fall back to DEFAULT_CONTEXT_LIMIT. Keep this in sync when adding a model to
 *  the selector (App.tsx MODELS / OLLAMA_MODELS) — a wrong limit makes the bar
 *  read wrong. */
export const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic — authoritative
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-fable-5': 1_000_000,
  // Ollama Cloud — native context windows (verified against each model's own
  // published specs, not a guess): Qwen3-Coder-480B and gpt-oss keep their
  // documented 256K/128K; DeepSeek V4 Pro and GLM-5.2 are actually 1M native —
  // they were previously under-reported here, which made the context bar read
  // as "full" way before the model's real limit.
  'qwen3-coder:480b-cloud': 256_000,
  'gpt-oss:120b-cloud': 128_000,
  'gpt-oss:20b-cloud': 128_000,
  'deepseek-v4-pro:cloud': 1_000_000,
  'glm-5.2:cloud': 1_000_000,
  'kimi-k2.7-code:cloud': 256_000
}

/** Context-window size for a model id, falling back to DEFAULT_CONTEXT_LIMIT. */
export function contextLimitFor(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT
  return CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
}

/** Ollama Cloud integration (optional). When enabled with an API key, the model
 *  selector gains the OLLAMA_MODELS; sessions on those run against Ollama Cloud
 *  via the Anthropic-compatible API. The key is stored only in the SQLite db. */
export interface OllamaConfig {
  enabled: boolean
  /** API key from ollama.com → Settings → Keys (sent as ANTHROPIC_AUTH_TOKEN). */
  apiKey: string
}

/** OpenAI integration (optional). When an API key is set, the chat gets voice
 *  input (speech→text, gpt-4o-mini-transcribe) and read-aloud (text→speech,
 *  gpt-4o-mini-tts). The key is stored only in the cache-folder SQLite db. */
export interface OpenAiConfig {
  /** API key from platform.openai.com → API keys (sent as a Bearer header by main). */
  apiKey: string
  /** Voice used for read-aloud (one of OPENAI_VOICES). */
  voice: string
  /** Reading speed: 0.8 = slow, 1 = normal, 1.5 = fast. Applied in the renderer
   *  as the audio playbackRate (exact/instant) — the model's own pace is unreliable. */
  speed: number
}

/** Everything the user can configure — persisted across app restarts. */
export interface AppConfig {
  stitch: StitchConfig
  /** OpenAI key for chat voice (TTS + speech-to-text). */
  openai: OpenAiConfig
  /** Ollama Cloud key + toggle (adds Ollama models to the selector). */
  ollama: OllamaConfig
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
  openai: { apiKey: '', voice: 'alloy', speed: 1 },
  ollama: { enabled: false, apiKey: '' },
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
  agentRefreshUsage: 'agent:refresh-usage',
  /** Dispose a conversation's agent session (e.g. when the chat is deleted). */
  agentDispose: 'agent:dispose',
  pickDirectory: 'app:pick-directory',
  pickFile: 'app:pick-file',
  /** Check whether a path exists and is a directory (project folder guard). */
  pathExists: 'app:path-exists',
  /** Open a project folder in VS Code (via the `code` CLI, falling back to the vscode:// URL). */
  openInEditor: 'app:open-in-editor',
  /** Open a project folder in the OS file explorer (Explorer/Finder/xdg-open). */
  openInFolder: 'app:open-in-folder',
  /** Live "@" autocomplete: search files/folders under the project for a query. */
  mentionSearch: 'app:mention-search',
  /** "/" autocomplete: list the skills available to the agent (project + user). */
  listSkills: 'app:list-skills',
  /** Save a copy of an agent-created file to the Downloads folder and reveal it. */
  fileDownload: 'app:file-download',
  /** Read the content of a local file. */
  fileRead: 'app:file-read',
  /** Read a local file as base64 bytes (for binary previews: PDF, images, xlsx…). */
  fileReadBytes: 'app:file-read-bytes',
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
  /** Whether a Claude Code login exists on this machine. */
  authStatus: 'auth:status',
  /** Run the Claude OAuth login (opens the browser); resolves when authenticated. */
  authLogin: 'auth:login',
  // main -> renderer (send)
  agentEvent: 'agent:event',
  agentPermissionRequest: 'agent:permission-request',
  /** main → renderer: a pending permission/question timed out and was auto-resolved. */
  agentPermissionExpired: 'agent:permission-expired',
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
  remoteClients: 'remote:clients',
  /** main → renderer: a phone toggled the global "Permitir tudo" switch. */
  remoteSetSkipPerms: 'remote:set-skip-perms',
  /** Phone asked to change a conversation's model/effort. */
  remoteSetModel: 'remote:set-model'
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

/** Endpoint público (VPS, atrás do Cloudflare HTTPS) do controle remoto. O QR usa
 *  este host + token; o PC disca o WebSocket do relay aqui. */
export const REMOTE_PUBLIC_HOST = 'https://agent-code.larchertech.com'
/** WebSocket de saída que o PC abre pro broker na VPS (relay multiusuário). */
export const REMOTE_RELAY_WS = 'wss://agent-code.larchertech.com/__relay'

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
  /** Whether the PC is connected to the VPS broker (remote access ready). */
  relayConnected: boolean
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
  /** Current model id of this conversation (phone shows/changes it). */
  model?: string
  /** Current reasoning effort of this conversation. */
  effort?: string
}

/** Snapshot the renderer publishes to main so the bridge can serve history. */
export interface RemoteStatePayload {
  conversations: RemoteConversation[]
  /** Global "Permitir tudo" (skip permissions) state, mirrored to the phone. */
  skipPerms?: boolean
  /** Models available in the PC's picker (Claude + enabled Ollama), for the phone's selector. */
  models?: { id: string; label: string }[]
  /** Effort levels supported per model id (mirrors MODEL_EFFORT; missing/empty = no effort UI). */
  modelEffort?: Record<string, string[]>
  /** Human labels per effort level (pt-BR), so the phone doesn't hardcode them. */
  effortLabels?: Record<string, string>
}

/** A command received from a phone, forwarded to the renderer to dispatch into
 *  the matching conversation's agent session (phone → PC → Claude Code). */
export interface RemoteInboundMsg {
  convId: string
  text: string
  /** Optional images attached on the phone, forwarded to the agent. */
  images?: ImageAttachment[]
}

/** A model/effort change requested from a phone, forwarded to the renderer
 *  (which applies it with the same rules as the PC's own pickers). */
export interface RemoteSetModelMsg {
  convId: string
  /** New model id, when the phone changed the model. */
  model?: string
  /** New effort level, when the phone changed the effort. */
  effort?: string
}

/** A progress line emitted while the remote APK is being built. */
export interface RemoteBuildProgressMsg {
  line: string
  /** Set on the terminal line: whether the build finished successfully. */
  done?: boolean
  ok?: boolean
}
