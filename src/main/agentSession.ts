import { query, type McpServerConfig, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'
import type { BrowserController } from './browserController'
import { createBrowserMcpServer } from './browserTools'
import { createAndroidMcpServer } from './android/androidTools'
import { createStitchPreviewMcpServer } from './stitchTools'
import { createWindowsControlMcpServer, WINDOWS_CONTROL_HINT } from './windowsControl/tools'
import { windowsControl } from './windowsControl/service'
import { loadConfig } from './config'
import { getCacheInfo } from './store'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isOllamaModel, modelSupportsVision, OLLAMA_BASE_URL } from '../shared/ipc'
import { describeImages, mergeUserTextWithVisualContext } from './visionRelay'
import type {
  AskQuestion,
  AgentInterruptResult,
  ChatEvent,
  ImageAttachment,
  PermissionRequest,
  PermissionResponse,
  RateLimitStatus,
  StartAgentOptions
} from '../shared/ipc'

const BROWSER_HINT = `You have an embedded web browser available through the "browser" MCP tools
(browser_navigate, browser_snapshot, browser_screenshot, browser_click, browser_type,
browser_get_text, browser_evaluate, browser_back, browser_reload). When the user asks you
to look something up on the web, open a site, or interact with a page, use these tools — the
page is rendered live inside the app for the user to see.

The preview is organized into TABS. There is always exactly one ACTIVE tab, and every
browser action targets it. Each tab has a name like "web - <site>" (only "web" tabs exist
today; "android"/"iphone" are reserved for the future). Tab tools: browser_list_tabs (see
all tabs and which is active), browser_new_tab (open another tab), browser_select_tab (switch
the active tab by id), browser_close_tab.

Default to REUSING the current tab: use browser_navigate to go elsewhere in the same tab.
Only open a new tab when you truly need a second page side-by-side — do not open tabs
needlessly. If you are unsure which tab you control, call browser_list_tabs or browser_snapshot
(both report the active tab name). When the user picks an element with "Select", the message
tells you which tab it came from — act on that tab.`

const ANDROID_HINT = `You can also build and test ANDROID apps through the "android" MCP tools.
When the user asks to create an Android app, generate an APK, or test something on Android,
this is the path — do NOT tell them it's unsupported.

Toolchain: the JDK + Android SDK + emulator are installed on demand by "android_setup"
(idempotent; only downloads what's missing — it can take a while the first time). Run it once
before building or previewing if the tools aren't present yet.

Building an APK: scaffold the project (for a WEB app, wrap it with Capacitor and build its
android/ folder; for a native app, a Kotlin/Gradle project), then call "android_build_apk"
with the Gradle project root (the folder containing gradlew). Then "android_install_run" with
the resulting .apk installs and launches it on the device.

Previewing/testing: "android_open_preview" boots a device/emulator (a connected phone if any,
otherwise the default AVD) and streams its screen into a preview tab named "android - <app>",
right next to the web tabs (same tab strip, Android icon). Interact with the running app using
android_screenshot / android_tap / android_swipe / android_type / android_key (taps use
normalized 0..1 coordinates that match the screenshot). Pass appName to android_install_run so
the tab reads "android - <app name>".

Screen sizes: the preview starts as a Galaxy S26 Ultra. To test the app on different screens,
use "android_list_device_models" to see the presets, then "android_set_device" with a modelId
(e.g. "s24", "pixel-8-pro", "tab-s9") or a custom width/height — it resizes the emulator and the
on-screen device frame follows. Test responsiveness across a few phone and tablet sizes.`

// Lets the model hand the user a downloadable file straight from the chat (works
// on the desktop AND on the Android remote app). The renderer turns the marker
// below into a "Baixar" button; without it, a built artifact like an APK has no
// way to reach the phone.
const DOWNLOAD_HINT = `When the user asks you to GIVE or SEND them a file they can download — an APK,
a .zip, a PDF, an exported document, an image, a build artifact, etc. — do not just print the
path. Emit a download marker on its OWN line so a "Baixar" (download) button appears in the chat
(it works both on the desktop and on the phone app):

[[download:ABSOLUTE_PATH]]

Example: [[download:C:\\Users\\me\\proj\\android\\app\\build\\outputs\\apk\\debug\\app-debug.apk]]

Rules: use the ABSOLUTE path to the finished file that already exists on disk; emit one marker per
file; only do this for real deliverable files the user asked for (NOT for source code you edited
in the project). After building something like an APK, locate the resulting file and emit its
marker so the user can download it right here.`

// Shown to the model only when the Google Stitch integration is enabled in
// Settings, so it knows it has this skill and follows the create→approve→implement flow.
const STITCH_HINT = `You ALSO have GOOGLE STITCH available through the "stitch" MCP tools
(mcp__stitch__*: list_projects, create_project, generate_screen_from_text, refine designs,
fetch_screen_code, fetch_screen_image, extract_design_context, get_screen, list_screens…).
Stitch is Google's AI UI designer: it turns a text prompt into a polished UI mockup and its
frontend code. Use it whenever the user wants a NEW screen/page/UI/mockup/front-end design.

Follow THIS flow strictly:
1. Tell the user in chat that you are creating a mockup with Stitch (a short heads-up), then
   call generate_screen_from_text (creating a project first if needed) to generate the screen.
2. Fetch the generated screen's HTML with fetch_screen_code.
3. Call mcp__stitchpreview__show_stitch_design with that HTML (and a short title) — this opens
   a "stitch" preview tab showing the design to the user.
4. STOP. Ask the user to review the design in the preview and approve it there: the tab has an
   "Aplicar no projeto" button (approve) and a "Descartar" button (reject). Do NOT modify the
   project yet.
5. Only AFTER the user approves (they click "Aplicar no projeto" and you receive a message
   saying so) do you apply it. Crucially, INTERPRET what the user originally asked for in this
   conversation and do THAT — it may be creating a brand-new screen, redesigning/restyling an
   existing screen or component, changing a theme, or anything else they requested. The user only
   clicks "Aplicar"; it's on you to map the approved design onto their actual intent. Do NOT paste
   the raw Stitch HTML: ADAPT the visual (layout, colors, typography, spacing, components) to the
   project's stack, structure and conventions, reusing existing components and patterns, via
   normal file edits.
6. After applying, SHOW the result in the preview so the user sees the new look running: open or
   refresh the relevant project screen (e.g. navigate the embedded browser to the running app/page,
   or rebuild/preview the affected screen). Don't just say it's done — make it visible.

If the user rejects ("Descartar"), do not implement; offer to refine the design with Stitch instead.`

// Shown to the model only when the "Modo econômico" toggle is ON in the UI.
// Instructs the LLM to skip validation/build/tests for trivial tasks to save tokens.
const ECONOMY_HINT = `MODO ECONÔMICO ATIVADO — O USUÁRIO MARCOU O TOGGLE "ECONÔMICO" NA UI.

Você está operando em modo de economia de tokens. Siga estas regras:

1. **Pule typecheck e build para tarefas triviais** — Se a mudança for puramente textual (typo, label, comentário, string), NÃO rode typecheck nem build. Apenas edite.

2. **Pule testes para mudanças pontuais** — Se a mudança for em 1 arquivo, sem alteração de lógica (CSS, texto de UI, ajuste visual), NÃO rode testes.

3. **Não revalide o código após editar** — Não releia o arquivo depois de editá-lo. O Edit/Write já teria falhado se algo desse errado.

4. **Sem verificações redundantes** — Não faça grep/ls/glob para "confirmar" algo que você já sabe.

5. **Respostas mais curtas** — Seja direto. Um "✅ pronto" é suficiente para tarefas simples. Não explique o que fez a menos que o usuário pergunte.

6. **Sem Definition of Done completo** — As regras normais de validação (rodar o app, testar fluxo real, verificar estado vazio/erro) NÃO se aplicam. Apenas faça a mudança e siga em frente.

7. **Mudanças complexas = ignore o modo econômico** — Se a tarefa envolve múltiplos arquivos, alterações de lógica, refatoração, segurança ou credenciais, siga o fluxo normal completo.

8. **Nunca pule verificações de segurança** — Credenciais, secrets, dados sensíveis sempre exigem cuidado normal.`

// Persistent, cross-conversation memory. The .md files live in the user's chosen
// cache folder (next to the SQLite db — see store.ts), so the PATH is per-user/per-machine,
// but THESE INSTRUCTIONS ship with the project, so every install behaves the same.
// Built per session because the folder path and the current index are dynamic.
function buildMemoryHint(memoriesDir: string): string {
  // Pre-load the index so the model passively knows what it already remembers,
  // the same way Claude Code surfaces MEMORY.md — empty on a fresh install.
  let index = ''
  try {
    const indexPath = join(memoriesDir, 'MEMORY.md')
    if (existsSync(indexPath)) index = readFileSync(indexPath, 'utf8').trim()
  } catch {
    /* unreadable index — treat as empty */
  }

  return `You have a PERSISTENT MEMORY for this user, kept as Markdown files in this folder:
${memoriesDir}

This folder is part of the user's cache folder (next to the app's database) and survives across
conversations. The memories are private to THIS user/machine — always use the ABSOLUTE path above
(your working directory is the user's project, NOT this folder). The folder already exists; just
write into it with your tools.

SAVING — when the user asks you to remember, save, note, or memorize something ("lembra disso",
"salva na memória", "anota", "memorize", "remember this", etc.):
- Write ONE fact per file as <short-kebab-name>.md inside the folder above.
- Keep a MEMORY.md index in that same folder: one bullet per memory — "- [Title](file.md) — short hook".
- Before creating a file, check the index for an existing memory on the same topic and UPDATE that
  file instead of making a duplicate. Delete a memory file (and its index line) if it becomes wrong.
- Do NOT save things already evident from the project's code, git history, or CLAUDE.md.

RECALLING — these files are your long-term knowledge about this user and their projects. Read the
relevant ones when they help the current task. The current index is below (empty if none yet):

--- MEMORY.md (current index) ---
${index || '(no memories saved yet)'}`
}

// Tools auto-approved without prompting the user.
const READ_ONLY = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'WebFetch',
  'WebSearch'
])

// Android interaction/inspection tools are auto-approved (like the browser tools).
// The heavy ones — android_setup (multi-GB download), android_build_apk and
// android_install_run — are intentionally NOT here, so they go through the prompt.
const ANDROID_AUTO = new Set([
  'mcp__android__android_open_preview',
  'mcp__android__android_list_devices',
  'mcp__android__android_list_device_models',
  'mcp__android__android_set_device',
  'mcp__android__android_screenshot',
  'mcp__android__android_tap',
  'mcp__android__android_swipe',
  'mcp__android__android_type',
  'mcp__android__android_key'
])

let counter = 0
const nextId = (): string => `e${Date.now().toString(36)}-${counter++}`

// A pending question/permission auto-resolves after this long without an answer:
// a question proceeds (the model is told nobody answered); a tool permission
// auto-denies (never auto-allow a tool the user never saw).
const PERMISSION_TIMEOUT_MS = 7 * 60_000

// `AskUserQuestion` is the tool the model uses to ask the user a multiple-choice
// question. The bundled CLI can't render it without a terminal, so we intercept it
// (see handlePermission) and surface the questions to our own UI. This pulls the
// questions out of the raw tool input into our typed shape (tolerant of bad data).
function parseAskQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  return raw.map((q) => {
    const o = (q ?? {}) as Record<string, unknown>
    const options = Array.isArray(o.options) ? o.options : []
    return {
      header: typeof o.header === 'string' ? o.header : '',
      question: typeof o.question === 'string' ? o.question : '',
      multiSelect: o.multiSelect === true,
      options: options.map((op) => {
        const x = (op ?? {}) as Record<string, unknown>
        return {
          label: typeof x.label === 'string' ? x.label : String(x.label ?? ''),
          description: typeof x.description === 'string' ? x.description : ''
        }
      })
    }
  })
}

type AssistantBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }

export class AgentSession {
  private input = new AsyncQueue<SDKUserMessage>()
  private q: ReturnType<typeof query> | null = null
  private pendingPermissions = new Map<
    string,
    {
      toolName: string
      input: Record<string, unknown>
      resolve: (r: PermissionResult) => void
      /** Auto-resolve timer (cleared if the user answers first). */
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private approvedTools = new Set<string>()
  /** "Allow all" — when true every tool is auto-approved without prompting. Toggleable at runtime. */
  private bypassAll = false
  /** Set when the user manually canceled the previous turn. The SDK keeps the
   *  interrupted exchange in its in-memory context (no API to drop it), so the
   *  next message is prefixed with a note telling the model to disregard it. */
  private canceledPending = false
  private liveId: string | null = null
  private liveText = ''
  /** Text lookup for UUIDs returned by the SDK interrupt receipt. Bounded so a
   *  long-lived session cannot retain every prompt forever. */
  private submittedMessages = new Map<string, string>()
  /** Context-window size of the most recent model request (last `assistant`
   *  message's input usage) — the true "context used", not the per-turn sum. */
  private lastContextTokens = 0
  /** Per-session cancellation scope for Windows UI actions. */
  private windowsControlScope = windowsControl.createScope()

  constructor(
    private readonly opts: StartAgentOptions,
    private readonly browser: BrowserController,
    private readonly emit: (e: ChatEvent) => void,
    private readonly askPermission: (req: PermissionRequest) => void,
    /** Called when a pending permission/question timed out and was auto-resolved,
     *  so the renderer can close the matching modal. */
    private readonly onPermissionExpire: (id: string) => void
  ) {}

  async start(): Promise<void> {
    this.bypassAll = this.opts.skipPermissions === true

    const cfg = loadConfig()

    // Google Stitch is opt-in: only wire its remote MCP (and tell the model about
    // the skill) when the user enabled it and provided an API key in Settings.
    const stitch = cfg.stitch
    const stitchOn = stitch.enabled && stitch.apiKey.trim().length > 0

    const mcpServers: Record<string, McpServerConfig> = {
      browser: createBrowserMcpServer(this.browser),
      android: createAndroidMcpServer(this.browser)
    }
    if (process.platform === 'win32') {
      mcpServers.windows = createWindowsControlMcpServer(this.windowsControlScope)
    }
    // Tell the model where its per-user memory lives (and pre-load the index), so
    // "lembra disso" saves into the cache folder and recall works across chats.
    const memoriesDir = getCacheInfo().memoriesDir
    let append = `${BROWSER_HINT}\n\n${ANDROID_HINT}\n\n${DOWNLOAD_HINT}\n\n${buildMemoryHint(memoriesDir)}`
    if (process.platform === 'win32') append += `\n\n${WINDOWS_CONTROL_HINT}`
    if (stitchOn) {
      // Official Stitch remote MCP — auth via the X-Goog-Api-Key header.
      mcpServers.stitch = {
        type: 'http',
        url: 'https://stitch.googleapis.com/mcp',
        headers: { 'X-Goog-Api-Key': stitch.apiKey.trim() },
        timeout: 300_000
      }
      // Our bridge that renders generated designs in the preview for approval.
      mcpServers.stitchpreview = createStitchPreviewMcpServer(this.browser)
      append += `\n\n${STITCH_HINT}`
    }

    // Modo econômico: when the user toggled it on for THIS conversation, tell the
    // model to skip validation/build/tests for trivial tasks to save tokens.
    if (this.opts.economyMode) {
      append += `\n\n${ECONOMY_HINT}`
    }

    // Ollama Cloud routing: when the chosen model is an Ollama model, point the
    // bundled Claude Code CLI at Ollama's Anthropic-compatible API instead of
    // Anthropic. This is the same trick as `ollama launch claude` — three env
    // vars. ANTHROPIC_API_KEY MUST be cleared (empty), or the CLI prefers a
    // stored Anthropic key and ignores ANTHROPIC_BASE_URL. Since SDK `env`
    // REPLACES the subprocess environment (not merged), we spread process.env.
    const ollamaOn = isOllamaModel(this.opts.model)
    const ollamaKey = cfg.ollama.apiKey.trim()
    if (ollamaOn && !ollamaKey) {
      this.emit({
        kind: 'error',
        id: nextId(),
        text: 'Modelo do Ollama selecionado, mas falta a API key. Abra Configurações → Ollama Cloud e cole sua chave.'
      })
      return
    }
    const env = ollamaOn
      ? {
          ...process.env,
          ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: ollamaKey,
          ANTHROPIC_API_KEY: ''
        }
      : undefined

    const options: Options = {
      cwd: this.opts.cwd,
      model: this.opts.model,
      ...(this.opts.effort ? { effort: this.opts.effort as Options['effort'] } : {}),
      ...(env ? { env } : {}),
      // The memories folder lives outside the project cwd, so allow it explicitly —
      // otherwise the workspace boundary would block reading/writing memory files.
      additionalDirectories: [memoriesDir],
      // Resume a previous SDK session (loads its history) when continuing an old chat.
      ...(this.opts.resume ? { resume: this.opts.resume } : {}),
      // Run the bundled Claude Code CLI under system Node rather than the
      // Electron binary, which would otherwise be picked up as the runtime.
      executable: 'node',
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      mcpServers,
      // Always route through our gate. "Allow all" is handled inside
      // handlePermission via the bypassAll flag so it can be toggled live.
      canUseTool: (toolName, input) => this.handlePermission(toolName, input)
    }

    this.q = query({ prompt: this.input, options })

    try {
      for await (const message of this.q) {
        this.handleMessage(message)
      }
    } catch (err) {
      this.emit({ kind: 'error', id: nextId(), text: `Agent stopped: ${String(err)}` })
    }
  }

  async send(text: string, images?: ImageAttachment[], messageUuid?: string): Promise<void> {
    const uuid = messageUuid || randomUUID()
    const receiptText = text.length > 500 ? `${text.slice(0, 500)}…` : text
    this.submittedMessages.set(uuid, receiptText)
    if (this.submittedMessages.size > 100) {
      const oldest = this.submittedMessages.keys().next().value
      if (oldest) this.submittedMessages.delete(oldest)
    }
    // If the user manually canceled the previous turn, neutralize it: the SDK
    // still carries the interrupted request (and any partial reply) in context,
    // so prefix a clear note telling the model to ignore that canceled exchange.
    let outText = text
    if (this.canceledPending) {
      this.canceledPending = false
      const note =
        '[Observação do sistema: o usuário CANCELOU manualmente a solicitação anterior e a resposta parcial a ela. ' +
        'Desconsidere por completo aquela solicitação cancelada e a resposta interrompida — trate como se nunca ' +
        'tivessem existido — e atenda apenas à mensagem a seguir.]'
      outText = text ? `${note}\n\n${text}` : note
    }

    // vision_fallback_router — the picked model can't see images (most Ollama
    // Cloud models are text-only): intercept BEFORE it ever reaches the SDK.
    // A one-off call to a multimodal Claude model turns the image into a
    // structured technical description, wrapped in [VISUAL_CONTEXT] and merged
    // into the text the main model actually receives. The image itself never
    // goes to the text-only model. Transparent: same conversation, same reply.
    if (images && images.length > 0 && !modelSupportsVision(this.opts.model)) {
      let merged: string
      try {
        const analysis = await describeImages(images, outText)
        merged = mergeUserTextWithVisualContext(outText, analysis)
      } catch (err) {
        // Degrade without blocking the send: the model still gets the user's
        // text, plus a note explaining the image couldn't be read this time.
        merged = `${outText}\n\n[Observação do sistema: não foi possível analisar a(s) imagem(ns) anexada(s) automaticamente (${String(err)}). Responda com base apenas no texto acima.]`
      }
      this.input.push({
        type: 'user',
        message: { role: 'user', content: merged },
        parent_tool_use_id: null,
        uuid
      } as SDKUserMessage)
      return
    }

    // With images, send a content-block array (image blocks first, then the
    // text) instead of a plain string — the native Anthropic image format.
    let content: unknown = outText
    if (images && images.length > 0) {
      const blocks: unknown[] = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      }))
      if (outText) blocks.push({ type: 'text', text: outText })
      content = blocks
    }
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid
    } as SDKUserMessage
    this.input.push(msg)
  }

  async interrupt(): Promise<AgentInterruptResult> {
    this.windowsControlScope.cancel()
    if (!this.q) return { stillQueued: [] }
    try {
      const receipt = await this.q.interrupt()
      // Manual cancel: flag the conversation so the next message tells the model
      // to disregard the canceled request (set only on a real interrupt).
      this.canceledPending = true
      return {
        stillQueued: (receipt?.still_queued ?? []).map((messageId) => ({
          messageId,
          text: this.submittedMessages.get(messageId)
        }))
      }
    } catch {
      /* not in a turn */
      return { stillQueued: [] }
    }
  }

  resolvePermission(res: PermissionResponse): void {
    const pending = this.pendingPermissions.get(res.id)
    if (!pending) return
    this.pendingPermissions.delete(res.id)
    clearTimeout(pending.timer) // user answered in time — cancel the auto-resolve
    // An answered AskUserQuestion: the user picked options. PermissionResult only
    // allows allow/deny, and we can't supply the tool's own structured output, so
    // we feed the answer back as a `deny` message — the model reads it and goes on.
    if (res.answers) {
      const lines = res.answers.map((a) => `- ${a.header || a.question}: ${a.selected.join(', ') || '(sem resposta)'}`)
      pending.resolve({
        behavior: 'deny',
        message: `The user answered your question(s):\n${lines.join('\n')}`
      })
      return
    }
    if (res.behavior === 'allow') {
      if (res.always) this.approvedTools.add(pending.toolName)
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: res.message ?? 'Denied by user.' })
    }
  }

  /** Toggle "allow all" while the session is running. */
  setBypass(on: boolean): void {
    this.bypassAll = on
    if (on) {
      // Auto-approve anything currently waiting on the user — EXCEPT an
      // AskUserQuestion, which still needs a real answer (it isn't a permission).
      for (const [id, pending] of this.pendingPermissions) {
        if (pending.toolName === 'AskUserQuestion') continue
        clearTimeout(pending.timer)
        pending.resolve({ behavior: 'allow', updatedInput: pending.input })
        this.pendingPermissions.delete(id)
      }
    }
  }

  /** Poll the SDK's experimental usage endpoint for the latest account-wide
   *  rate-limit snapshot (5h / weekly / etc.). Emits `rate-limit` events so the
   *  badge updates even when the backend did not push a `rate_limit_event` on
   *  its own. Safe to call at any time; failures are swallowed. */
  async refreshUsage(): Promise<void> {
    const q = this.q
    if (!q) return
    try {
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      if (!usage.rate_limits_available || !usage.rate_limits) return
      const limits = usage.rate_limits
      const now = Date.now()
      const emitLimit = (
        type: RateLimitStatus['rateLimitType'],
        data: { utilization: number | null; resets_at: string | null } | null | undefined
      ): void => {
        if (!data) return
        const utilization = data.utilization
        const resetsAt = data.resets_at ? new Date(data.resets_at).getTime() : undefined
        if (utilization == null && resetsAt == null) return
        let status: RateLimitStatus['status'] = 'allowed'
        if (utilization != null) {
          if (utilization >= 100) status = 'rejected'
          else if (utilization >= 80) status = 'allowed_warning'
        }
        this.emit({
          kind: 'rate-limit',
          limits: {
            rateLimitType: type,
            status,
            utilization: utilization != null ? utilization / 100 : undefined,
            resetsAt,
            updatedAt: now
          }
        })
      }
      emitLimit('five_hour', limits.five_hour)
      emitLimit('seven_day', limits.seven_day)
      emitLimit('seven_day_opus', limits.seven_day_opus)
      emitLimit('seven_day_sonnet', limits.seven_day_sonnet)

      // Paid overage window — present only when enabled on the account.
      const extra = limits.extra_usage
      if (extra?.is_enabled) {
        const u = extra.utilization
        let status: RateLimitStatus['status'] = 'allowed'
        if (u != null) {
          if (u >= 100) status = 'rejected'
          else if (u >= 80) status = 'allowed_warning'
        }
        this.emit({
          kind: 'rate-limit',
          limits: {
            rateLimitType: 'overage',
            status,
            utilization: u != null ? u / 100 : undefined,
            updatedAt: now
          }
        })
      }
    } catch {
      /* best-effort: usage endpoint is experimental and may fail */
    }
  }

  dispose(): void {
    this.windowsControlScope.cancel()
    this.input.close()
  }

  // ---- internals ----

  private handlePermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // AskUserQuestion is NOT a permission — it's a question that needs an answer.
    // Always route it to our interactive UI (even with "allow all" on: you can't
    // auto-answer a question), and feed the user's pick back via resolvePermission.
    if (toolName === 'AskUserQuestion') {
      const id = nextId()
      this.askPermission({
        id,
        toolName,
        input,
        questions: parseAskQuestions(input),
        deadline: Date.now() + PERMISSION_TIMEOUT_MS
      })
      return new Promise<PermissionResult>((resolve) => this.registerPending(id, toolName, input, resolve))
    }
    // Windows control has its own high-risk master gate. "Permitir tudo" must
    // never bypass it; enabling the dedicated toggle is the explicit grant.
    if (toolName.startsWith('mcp__windows__')) {
      if (loadConfig().windowsControlEnabled !== true) {
        return Promise.resolve({
          behavior: 'deny',
          message: 'Controle do Windows desativado. Ative “Permitir controle do Windows” nas Configurações.'
        })
      }
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (
      this.bypassAll ||
      READ_ONLY.has(toolName) ||
      toolName.startsWith('mcp__browser__') ||
      // Stitch design/preview tools are safe to auto-run: they only generate and
      // display mockups. The real gate is implementing into the project (Write/Edit),
      // which still prompts, plus the explicit Aplicar/Descartar approval in the preview.
      toolName.startsWith('mcp__stitch__') ||
      toolName.startsWith('mcp__stitchpreview__') ||
      ANDROID_AUTO.has(toolName) ||
      this.approvedTools.has(toolName)
    ) {
      // IMPORTANT: an "allow" result MUST echo the tool input back as `updatedInput`.
      // The CLI runs the tool with whatever `updatedInput` it receives; omitting it
      // runs the tool with empty input, which then fails its own schema validation
      // ("erro de validação interno") for anything that isn't read-only.
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const id = nextId()
    this.askPermission({ id, toolName, input, deadline: Date.now() + PERMISSION_TIMEOUT_MS })
    return new Promise<PermissionResult>((resolve) => this.registerPending(id, toolName, input, resolve))
  }

  /** Track a pending request and arm its auto-resolve timer. */
  private registerPending(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    resolve: (r: PermissionResult) => void
  ): void {
    const timer = setTimeout(() => this.expirePermission(id), PERMISSION_TIMEOUT_MS)
    // Don't let a pending prompt keep the process alive (e.g. on quit).
    timer.unref?.()
    this.pendingPermissions.set(id, { toolName, input, resolve, timer })
  }

  /** No answer in time: a question proceeds (model told nobody answered); a tool
   *  permission auto-denies. Either way, tell the renderer to close the modal. */
  private expirePermission(id: string): void {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    clearTimeout(pending.timer)
    if (pending.toolName === 'AskUserQuestion') {
      pending.resolve({
        behavior: 'deny',
        message:
          'O usuário não respondeu em 7 minutos. Siga sem a resposta dele: assuma a opção mais sensata e continue a tarefa.'
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message:
          'Sem resposta do usuário (tempo de 7 minutos esgotado). A ferramenta NÃO foi autorizada; siga sem executá-la.'
      })
    }
    this.onPermissionExpire(id)
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.emit({
            kind: 'system',
            sessionId: message.session_id,
            model: message.model,
            cwd: message.cwd,
            tools: message.tools
          })
          // The level event is not emitted at process startup. Reset explicitly
          // so a resumed/restarted session never leaves stale tasks in the UI.
          this.emit({ kind: 'background-tasks', tasks: [] })
        } else if (message.subtype === 'background_tasks_changed') {
          this.emit({
            kind: 'background-tasks',
            tasks: message.tasks.map((task) => ({
              id: task.task_id,
              type: task.task_type,
              description: task.description
            }))
          })
        }
        break

      case 'stream_event':
        this.handleStreamEvent(message.event as { type: string; message?: { id?: string }; delta?: { type?: string; text?: string } })
        break

      case 'assistant': {
        // Each assistant message carries the usage of THAT model request. Its
        // input (fresh + cache read + cache write) is the real context-window
        // occupancy at this point — unlike result.usage, which sums the turn.
        // Only count MAIN-thread messages: a subagent (Task/skill) reports its
        // own, separate context (parent_tool_use_id set), which must not be
        // shown as the conversation's context.
        const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null
        const u = (message.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage
        if (u && parentToolUseId === null) {
          this.lastContextTokens =
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
        this.handleAssistant(message.message.content as unknown as AssistantBlock[], message.aborted === true)
        break
      }

      case 'user':
        this.handleUser((message.message.content as unknown) as AssistantBlock[] | string)
        break

      case 'result': {
        const r = message as unknown as {
          subtype: string
          is_error: boolean
          result?: string
          duration_ms: number
          total_cost_usd?: number
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
          origin?: { kind?: string }
        }
        // A background subagent (Task tool) finishing sends its OWN `result`
        // message into this same stream, tagged `origin.kind === 'peer'`. That
        // is not the end of the main turn — emitting it as `kind: 'result'`
        // would tell the renderer the whole turn is done (clearing the "busy"
        // indicator: spinner, timer, "trabalhando" banner) while the main
        // agent keeps working and producing more tool_use/text afterward.
        // Mirrors the parent_tool_use_id filter already used for the
        // `assistant` case below (context-token tracking).
        if (r.origin?.kind === 'peer') break
        this.emit({
          kind: 'result',
          id: nextId(),
          isError: r.is_error,
          text: r.result ?? (r.subtype === 'success' ? 'Done.' : r.subtype),
          durationMs: r.duration_ms,
          costUsd: r.total_cost_usd,
          // `|| undefined` so the renderer's `?? fallback` kicks in if we never
          // saw a main-thread assistant usage (0 would otherwise stick).
          contextTokens: this.lastContextTokens || undefined,
          usage: r.usage
            ? {
                input: r.usage.input_tokens ?? 0,
                output: r.usage.output_tokens ?? 0,
                cacheRead: r.usage.cache_read_input_tokens ?? 0,
                cacheWrite: r.usage.cache_creation_input_tokens ?? 0
              }
            : undefined
        })
        // Refresh the account-wide usage badge as soon as the turn finishes,
        // even if the SDK did not push a spontaneous rate_limit_event.
        void this.refreshUsage()
        break
      }

      // Account-wide rate-limit status (5h session / weekly / etc.) — only sent
      // for claude.ai subscription sessions. One type per event; the renderer
      // accumulates them into a global map (not tied to this conversation).
      case 'rate_limit_event': {
        const info = (
          message as unknown as {
            rate_limit_info: {
              status: 'allowed' | 'allowed_warning' | 'rejected'
              rateLimitType?:
                | 'five_hour'
                | 'seven_day'
                | 'seven_day_opus'
                | 'seven_day_sonnet'
                | 'seven_day_overage_included'
                | 'overage'
              utilization?: number
              resetsAt?: number
            }
          }
        ).rate_limit_info
        if (info.rateLimitType) {
          this.emit({
            kind: 'rate-limit',
            limits: {
              rateLimitType: info.rateLimitType,
              status: info.status,
              utilization: info.utilization,
              resetsAt: info.resetsAt,
              updatedAt: Date.now()
            }
          })
        }
        break
      }

      default:
        break
    }
  }

  private handleStreamEvent(ev: { type: string; message?: { id?: string }; delta?: { type?: string; text?: string } }): void {
    if (ev.type === 'message_start') {
      this.liveId = ev.message?.id ?? nextId()
      this.liveText = ''
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      if (!this.liveId) this.liveId = nextId()
      this.liveText += ev.delta.text ?? ''
      this.emit({ kind: 'assistant-text', id: this.liveId, text: this.liveText, final: false })
    }
  }

  private handleAssistant(blocks: AssistantBlock[], aborted = false): void {
    let emittedText = false
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        emittedText = true
        this.emit({
          kind: 'assistant-text',
          id: this.liveId ?? nextId(),
          text: block.text,
          final: true,
          ...(aborted ? { aborted: true as const } : {})
        })
      } else if (block.type === 'thinking' && block.thinking) {
        this.emit({ kind: 'thinking', id: nextId(), text: block.thinking })
      } else if (block.type === 'tool_use') {
        this.emit({
          kind: 'tool-use',
          id: block.id ?? nextId(),
          name: block.name ?? 'tool',
          input: block.input,
          parentToolUseId: null
        })
      }
    }
    // Some aborted frames carry no completed text block even though partial
    // deltas already painted text. Re-emit that live row only to attach the flag.
    if (aborted && !emittedText && this.liveId && this.liveText) {
      this.emit({ kind: 'assistant-text', id: this.liveId, text: this.liveText, final: true, aborted: true })
    }
    this.liveId = null
    this.liveText = ''
  }

  private handleUser(content: AssistantBlock[] | string): void {
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type === 'tool_result') {
        const raw = (block as unknown as { content?: unknown; tool_use_id?: string; is_error?: boolean })
        this.emit({
          kind: 'tool-result',
          id: nextId(),
          toolUseId: raw.tool_use_id ?? '',
          isError: Boolean(raw.is_error),
          text: stringifyToolResult(raw.content)
        })
      }
    }
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000)
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string }
        if (b.type === 'text') return b.text ?? ''
        if (b.type === 'image') return '[image]'
        return ''
      })
      .join('\n')
      .slice(0, 4000)
  }
  return ''
}
