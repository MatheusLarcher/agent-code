import { query, type McpServerConfig, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'
import type { BrowserController } from './browserController'
import { createBrowserMcpServer } from './browserTools'
import { createAndroidMcpServer } from './android/androidTools'
import { createWindowsControlMcpServer, WINDOWS_CONTROL_HINT } from './windowsControl/tools'
import { windowsControl } from './windowsControl/service'
import { loadConfig } from './config'
import { getCacheInfo } from './store'
import { buildDynamicMemoryContext, buildMemoryIndexContext } from './memoryIndex'
import { hostname } from 'node:os'
import { discoverSkills, renderAgentSkillCatalog } from './skillDiscovery'
import { readSessionTasks, watchSessionTasks } from './sessionTasks'
import { randomUUID } from 'node:crypto'
import { isOllamaModel, isOpenAIModel, modelSupportsFastMode, modelSupportsVision, OLLAMA_BASE_URL } from '../shared/ipc'
import { ensureCodexProxyRunning } from './codexProxy'
import { isCodexConnected } from './codexAuth'
import { describeImages, mergeUserTextWithVisualContext } from './visionRelay'
import { buildProjectOutline } from './projectOutline'
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

export const OPENAI_MAX_TURNS = 64
export const DEFAULT_LOOP_LIMIT = 100
export const MAX_LOOP_LIMIT = 10_000

/** Reads only numbers explicitly tied to a loop/repetition limit. Incidental
 * ports, dates and ids must never silently turn into execution budgets. */
export function loopLimitFromPrompt(text: string): number {
  const patterns = [
    /(?:limite(?:\s+(?:do|de))?\s+loop|loop\s+limit)\s*[:=]?\s*(\d+)/iu,
    /(?:at[eé]|no\s+m[aá]ximo|max(?:imum)?)\s+(\d+)\s+(?:vezes|ciclos|itera(?:ç|c)[õo]es|times|cycles|iterations)/iu,
    /(?:tente|repita|execute|rode|repeat|run|try)\s+(?:at[eé]\s+)?(\d+)\s+(?:vezes|ciclos|itera(?:ç|c)[õo]es|times|cycles|iterations)/iu
  ]
  for (const pattern of patterns) {
    const value = Number(pattern.exec(text)?.[1])
    if (Number.isSafeInteger(value) && value > DEFAULT_LOOP_LIMIT) {
      return Math.min(value, MAX_LOOP_LIMIT)
    }
  }
  return DEFAULT_LOOP_LIMIT
}

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

/** De onde a mensagem do usuário partiu: o próprio PC ou um celular pareado na
 *  ponte LAN (`remote/remoteServer.ts`). */
export type MessageOrigin = 'pc' | 'celular'

/**
 * Carimbo que abre TODA mensagem do usuário.
 *
 * Sem ele o modelo só tem a data que veio no system prompt — que é do INÍCIO da
 * sessão e envelhece enquanto a conversa segue (uma sessão que atravessa a
 * meia-noite passa o dia inteiro errando o "hoje"). E, com a ponte LAN, o mesmo
 * chat recebe mensagem do PC e do celular sem nada distinguir as duas.
 */
export function buildContextStamp(origin: MessageOrigin, now: Date = new Date(), machine: string = hostname()): string {
  const quando = now.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
  const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone
  const de = origin === 'celular' ? `do celular, pela ponte LAN do PC ${machine}` : `do PC ${machine}`
  return `[Contexto do sistema: mensagem enviada ${de} em ${quando} (${fuso}).]`
}

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

const LOOP_HINT = `MODO LOOP ATIVADO PELO USUÁRIO NESTA CONVERSA.

Use a skill /loop somente quando a tarefa realmente pedir repetição. Em CADA ciclo:
1. verifique primeiro a condição de saída escrita pelo usuário;
2. se a condição já foi atingida, chame ScheduleWakeup com {"stop":true} e entregue o resultado final;
3. só peça o próximo ScheduleWakeup DEPOIS de concluir e verificar o trabalho possível neste ciclo;
4. nunca use ScheduleWakeup apenas para esperar um subagente ou tarefa em background;
5. não inclua campos fora do schema, como "noop".

O Agent Code aplica 100 ciclos por padrão. Um limite maior só vale quando o usuário o pedir
explicitamente no texto. A condição de saída encerra o loop antes do limite.`

// Persistent, cross-conversation memory. The .md files live in the user's chosen
// cache folder (next to the SQLite db — see store.ts), so the PATH is per-user/per-machine,
// but THESE INSTRUCTIONS ship with the project, so every install behaves the same.
// Built per session because the folder path and the current index are dynamic.
function buildMemoryHint(memoriesDir: string): string {
  return `You have a PERSISTENT MEMORY for this user, kept as Markdown files in this folder:
${memoriesDir}

This folder is part of the user's cache folder (next to the app's database) and survives across
conversations. The memories are private to THIS user/machine — always use the ABSOLUTE path above
(your working directory is the user's project, NOT this folder). The folder already exists; just
write into it with your tools.

SUBFOLDERS — the user may group memories in subfolders (e.g. "2D/"). The folder name IS context:
every memory listed under a folder section below is about that subject. When the current task is
about that subject, those memories apply; save new memories on that subject INTO the same folder
(path relative to the root above, e.g. "2D/<short-kebab-name>.md").

SAVING — when the user asks you to remember, save, note, or memorize something ("lembra disso",
"salva na memória", "anota", "memorize", "remember this", etc.):
- Write ONE fact per file as <short-kebab-name>.md inside the folder above (or inside the matching
  subfolder, when the fact clearly belongs to an existing group).
- Keep a MEMORY.md index in the ROOT of that folder: one bullet per memory —
  "- [Title](file.md) — short hook", using the path WITH the subfolder when there is one
  ("- [Title](2D/file.md) — ...").
- Before creating a file, check the index for an existing memory on the same topic and UPDATE that
  file instead of making a duplicate. Delete a memory file (and its index line) if it becomes wrong.
- Do NOT save things already evident from the project's code, git history, or CLAUDE.md.

RECALLING — these files are your long-term knowledge about this user and their projects. Read the
relevant ones when they help the current task. A fresh index and bounded relevant excerpts are
attached to every user message, so changes made during this session are immediately available.`
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

/**
 * Which agent produced a message. `parentToolUseId === null` is the main agent;
 * anything else is the `Task` call that spawned the subagent, and works as the
 * track id in the agents panel. The SDK also labels subagent messages with their
 * type and task description — that's what makes a track readable ("Explore:
 * procurar onde o plano é montado") instead of `toolu_01ABC…`.
 */
interface TrackInfo {
  parentToolUseId: string | null
  subagentType?: string
  taskDescription?: string
}

const EMPTY_TRACK: TrackInfo = { parentToolUseId: null }

function trackOf(message: unknown, parentToolUseId: string | null): TrackInfo {
  if (!parentToolUseId) return EMPTY_TRACK
  const m = message as { subagent_type?: unknown; task_description?: unknown }
  return {
    parentToolUseId,
    ...(typeof m.subagent_type === 'string' && m.subagent_type ? { subagentType: m.subagent_type } : {}),
    ...(typeof m.task_description === 'string' && m.task_description ? { taskDescription: m.task_description } : {})
  }
}

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
  /** Avoid repeating a large unchanged memory index in every turn's history. */
  private lastMemoryIndex = ''
  /** Per-session cancellation scope for Windows UI actions. */
  private windowsControlScope = windowsControl.createScope()
  /** Stops the task-folder watcher of the CURRENT sdk session (a resume/restart
   *  can hand us a different session id, and then we re-point the watcher). */
  private stopTaskWatch: (() => void) | null = null
  private watchedSessionId: string | null = null
  private disposed = false
  private loopActive = false
  private loopCycles = 0
  private loopLimit = DEFAULT_LOOP_LIMIT
  private loopScheduledThisIteration = false

  constructor(
    private readonly opts: StartAgentOptions,
    private readonly browser: BrowserController,
    private readonly emit: (e: ChatEvent) => void,
    private readonly askPermission: (req: PermissionRequest) => void,
    /** Called when a pending permission/question timed out and was auto-resolved,
     *  so the renderer can close the matching modal. */
    private readonly onPermissionExpire: (id: string) => void,
    /** Installed Agent Code root; remains stable when a chat targets another project. */
    private readonly appRoot: string = process.cwd()
  ) {}

  async start(): Promise<boolean> {
    if (this.disposed) return false
    this.bypassAll = this.opts.skipPermissions === true

    const cfg = loadConfig()

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
    const discoveredSkills = discoverSkills(this.opts.cwd, undefined, this.appRoot)
    const adaptedSkillRoots = [...new Set(discoveredSkills.filter((skill) => !skill.native).map((skill) => skill.root))]
    const skillCatalog = renderAgentSkillCatalog(discoveredSkills)
    let append = `${BROWSER_HINT}\n\n${ANDROID_HINT}\n\n${DOWNLOAD_HINT}\n\n${buildMemoryHint(memoriesDir)}`
    if (skillCatalog) append += `\n\n${skillCatalog}`
    if (process.platform === 'win32') append += `\n\n${WINDOWS_CONTROL_HINT}`

    // Modo econômico: when the user toggled it on for THIS conversation, tell the
    // model to skip validation/build/tests for trivial tasks to save tokens.
    if (this.opts.economyMode) {
      append += `\n\n${ECONOMY_HINT}`
    } else if (this.opts.loopEnabled) {
      append += `\n\n${LOOP_HINT}`
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
      return false
    }
    // GPT (Codex) routing: same trick as Ollama above, but ANTHROPIC_BASE_URL
    // points at our own local proxy (see codexProxy.ts) instead of a real
    // Anthropic-compatible endpoint — the Codex backend speaks a completely
    // different protocol, so the proxy translates in both directions.
    const openaiOn = isOpenAIModel(this.opts.model)
    if (openaiOn && !isCodexConnected()) {
      this.emit({
        kind: 'error',
        id: nextId(),
        text: 'Modelo GPT selecionado, mas não há login do ChatGPT. Abra Configurações → OpenAI e conecte sua conta.'
      })
      return false
    }
    let openaiEnv: typeof process.env | undefined
    if (openaiOn) {
      try {
        const { baseUrl, secret } = await ensureCodexProxyRunning((line) => console.log(`[codex-proxy] ${line}`))
        openaiEnv = {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: secret,
          ANTHROPIC_API_KEY: '',
          // Agent's model aliases normally resolve back to Claude model ids.
          // Pin every child-agent tier to the selected GPT model instead.
          ANTHROPIC_DEFAULT_SONNET_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_FABLE_MODEL: this.opts.model,
          CLAUDE_CODE_SUBAGENT_MODEL: this.opts.model
        }
      } catch (err) {
        this.emit({
          kind: 'error',
          id: nextId(),
          text: `Não consegui iniciar o proxy do Codex: ${String(err)}`
        })
        return false
      }
    }

    const env = ollamaOn
      ? {
          ...process.env,
          ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: ollamaKey,
          ANTHROPIC_API_KEY: ''
        }
      : openaiEnv

    const options: Options = {
      cwd: this.opts.cwd,
      model: this.opts.model,
      ...(this.opts.effort ? { effort: this.opts.effort as Options['effort'] } : {}),
      // Modo rápido: only sent when the chosen model actually supports it — the
      // API rejects a fast-mode request on an unsupported model instead of
      // quietly serving it at standard speed.
      ...(this.opts.fastMode && modelSupportsFastMode(this.opts.model)
        ? { settings: { fastMode: true } }
        : {}),
      ...(env ? { env } : {}),
      ...(openaiOn ? { maxTurns: OPENAI_MAX_TURNS } : {}),
      // The memories folder lives outside the project cwd, so allow it explicitly —
      // otherwise the workspace boundary would block reading/writing memory files.
      additionalDirectories: [memoriesDir, ...adaptedSkillRoots],
      skills: 'all',
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

    if (this.disposed) return false
    try {
      this.q = query({ prompt: this.input, options })
    } catch (err) {
      this.emit({ kind: 'error', id: nextId(), text: `Agent failed to start: ${String(err)}` })
      return false
    }
    void this.consumeMessages(this.q)
    return true
  }

  private async consumeMessages(q: NonNullable<typeof this.q>): Promise<void> {
    try {
      for await (const message of q) {
        if (!this.disposed) this.handleMessage(message)
      }
    } catch (err) {
      if (!this.disposed) this.emit({ kind: 'error', id: nextId(), text: `Agent stopped: ${String(err)}` })
    } finally {
      if (this.q === q) this.q = null
    }
  }

  async send(
    text: string,
    images?: ImageAttachment[],
    messageUuid?: string,
    origin: MessageOrigin = 'pc'
  ): Promise<void> {
    // A real user dispatch starts a fresh loop budget. Dynamic wakeups are
    // injected by the CLI and do not pass through this method.
    this.loopActive = this.opts.loopEnabled === true && /^\s*\/loop(?:\s|$)/iu.test(text)
    this.loopCycles = 0
    this.loopLimit = loopLimitFromPrompt(text)
    this.loopScheduledThisIteration = false
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
    // Data/hora, máquina de origem e o índice fresco de `docs/`, sempre. Ficam
    // FORA do `outText` de propósito: o relay de visão abaixo recebe a mensagem
    // crua do usuário como pista da imagem. O contexto é colado só no payload final.
    const stamp = buildContextStamp(origin)
    const memoriesDir = getCacheInfo().memoriesDir
    const freshMemoryIndex = buildMemoryIndexContext(memoriesDir)
    const indexChanged = freshMemoryIndex !== this.lastMemoryIndex
    if (indexChanged) this.lastMemoryIndex = freshMemoryIndex
    const relevantMemories = buildDynamicMemoryContext(memoriesDir, text, false)
    const memoryParts = [indexChanged ? freshMemoryIndex : '', relevantMemories].filter(Boolean)
    const memoryContext = memoryParts.length
      ? `[PERSISTENT_MEMORY_CONTEXT]\n${memoryParts.join('\n\n')}\n[/PERSISTENT_MEMORY_CONTEXT]`
      : '[PERSISTENT_MEMORY_CONTEXT]\n(index unchanged; no relevant excerpt selected)\n[/PERSISTENT_MEMORY_CONTEXT]'
    let docsOutline: string
    try {
      docsOutline = await buildProjectOutline(this.opts.cwd)
    } catch {
      docsOutline = '[PROJECT_DOCS_OUTLINE]\ndocs/ [outline unavailable for this dispatch]\n[/PROJECT_DOCS_OUTLINE]'
    }
    const stamped = (body: string): string =>
      body
        ? `${stamp}\n\n${docsOutline}\n\n${memoryContext}\n\n${body}`
        : `${stamp}\n\n${docsOutline}\n\n${memoryContext}`

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
        message: { role: 'user', content: stamped(merged) },
        parent_tool_use_id: null,
        uuid
      } as SDKUserMessage)
      return
    }

    // With images, send a content-block array (image blocks first, then the
    // text) instead of a plain string — the native Anthropic image format.
    let content: unknown = stamped(outText)
    if (images && images.length > 0) {
      const blocks: unknown[] = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      }))
      // Antes o bloco de texto sumia quando a mensagem era só imagem; o carimbo
      // nunca é vazio, então agora ele sempre acompanha.
      blocks.push({ type: 'text', text: stamped(outText) })
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
      const receipt = (await this.q.interrupt()) as unknown as { still_queued?: string[] } | undefined
      // Manual cancel: flag the conversation so the next message tells the model
      // to disregard the canceled request (set only on a real interrupt).
      this.canceledPending = true
      return {
        stillQueued: (receipt?.still_queued ?? []).map((messageId: string) => ({
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
    if (this.disposed) return
    this.disposed = true
    this.windowsControlScope.cancel()
    this.stopTaskWatch?.()
    this.stopTaskWatch = null
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ behavior: 'deny', message: 'Agent session was closed before permission was granted.' })
    }
    this.pendingPermissions.clear()
    this.q?.close()
    this.q = null
    this.input.close()
  }

  /**
   * Point the task watcher at this sdk session and push its CURRENT list right
   * away. Called on every `system/init` — including the one a resume produces —
   * so a chat reopened after the app (or the machine) was restarted shows the
   * real progress instead of the snapshot it happened to see last time.
   */
  private syncTasks(sessionId: string): void {
    if (this.watchedSessionId === sessionId && this.stopTaskWatch) return
    this.stopTaskWatch?.()
    this.watchedSessionId = sessionId
    const items = readSessionTasks(sessionId)
    if (items) this.emit({ kind: 'task-list', items })
    this.stopTaskWatch = watchSessionTasks(sessionId, (list) => this.emit({ kind: 'task-list', items: list }))
  }

  // ---- internals ----

  private handlePermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    if (this.disposed) {
      return Promise.resolve({ behavior: 'deny', message: 'Agent session is closed.' })
    }
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
    if (toolName === 'Skill') {
      const skill = typeof input.skill === 'string' ? input.skill : typeof input.name === 'string' ? input.name : ''
      if (/^(?:[^:]+:)?loop$/iu.test(skill.trim())) {
        if (this.opts.loopEnabled !== true || this.opts.economyMode === true) {
          return Promise.resolve({
            behavior: 'deny',
            message: 'Loop desativado nesta conversa. Ative o toggle “Loop” para usar /loop.'
          })
        }
        this.loopActive = true
        // The per-conversation toggle is the explicit user grant. Returning here
        // also prevents loopActive from being set while the Skill permission is
        // still pending (and possibly denied).
        return Promise.resolve({ behavior: 'allow', updatedInput: input })
      }
    }
    if (toolName === 'ScheduleWakeup') {
      if (this.opts.loopEnabled !== true || this.opts.economyMode === true) {
        return Promise.resolve({
          behavior: 'deny',
          message: 'ScheduleWakeup bloqueado: o toggle Loop está desativado nesta conversa.'
        })
      }
      if (!this.loopActive) {
        return Promise.resolve({
          behavior: 'deny',
          message: 'ScheduleWakeup só pode ser usado por uma execução ativa da skill /loop; não o use para esperar subagentes.'
        })
      }
      const allowedKeys = new Set(['delaySeconds', 'reason', 'prompt', 'stop'])
      const unexpected = Object.keys(input).filter((key) => !allowedKeys.has(key))
      if (unexpected.length) {
        return Promise.resolve({
          behavior: 'deny',
          message: `ScheduleWakeup inválido: campos não permitidos: ${unexpected.join(', ')}.`
        })
      }
      if (input.stop === true) {
        this.loopActive = false
        this.loopScheduledThisIteration = false
        return Promise.resolve({ behavior: 'allow', updatedInput: { stop: true } })
      }
      if (this.loopCycles >= this.loopLimit) {
        this.loopActive = false
        this.loopScheduledThisIteration = false
        return Promise.resolve({
          behavior: 'deny',
          message: `Loop encerrado após ${this.loopLimit} ciclos sem confirmar a condição de saída. Peça explicitamente um limite maior para tentar novamente.`
        })
      }
      if (
        typeof input.delaySeconds !== 'number' ||
        !Number.isFinite(input.delaySeconds) ||
        typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        typeof input.prompt !== 'string' ||
        !input.prompt.trim()
      ) {
        return Promise.resolve({
          behavior: 'deny',
          message: 'ScheduleWakeup inválido: delaySeconds, reason e prompt são obrigatórios durante o loop.'
        })
      }
      this.loopCycles++
      this.loopScheduledThisIteration = true
      console.log(`[loop] conversation=${this.opts.convId} cycle=${this.loopCycles}/${this.loopLimit} scheduled`)
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
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
          // Re-sync the plan card with the CLI's own task files: TaskCreate/
          // TaskUpdate events only describe changes, so everything that happened
          // while this app wasn't listening would otherwise stay invisible.
          this.syncTasks(message.session_id)
        } else if ((message as { subtype?: string }).subtype === 'background_tasks_changed') {
          const tasks = (message as unknown as {
            tasks: Array<{ task_id: string; task_type: string; description: string }>
          }).tasks
          this.emit({
            kind: 'background-tasks',
            tasks: tasks.map((task) => ({
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
        this.handleAssistant(
          message.message.content as unknown as AssistantBlock[],
          (message as { aborted?: boolean }).aborted === true,
          trackOf(message, parentToolUseId)
        )
        break
      }

      case 'user': {
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null
        this.handleUser((message.message.content as unknown) as AssistantBlock[] | string, parent)
        break
      }

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
        // If an active loop iteration reaches a successful terminal result
        // without requesting another wakeup, its condition is complete. The CLI
        // has nothing pending and the local guard must not authorize a stale call.
        if (this.loopActive && !r.is_error && !this.loopScheduledThisIteration) {
          this.loopActive = false
          console.log(`[loop] conversation=${this.opts.convId} completed after ${this.loopCycles} cycle(s)`)
        }
        this.loopScheduledThisIteration = false
        // Belt-and-braces re-read at the end of every turn: if the folder watcher
        // ever misses a write (network drive, antivirus, watcher limits), the card
        // still lands on the truth instead of drifting for the rest of the chat.
        if (this.watchedSessionId) {
          const tasks = readSessionTasks(this.watchedSessionId)
          if (tasks) this.emit({ kind: 'task-list', items: tasks })
        }
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

  private handleAssistant(blocks: AssistantBlock[], aborted = false, track: TrackInfo = EMPTY_TRACK): void {
    let emittedText = false
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        // Text/thinking from a SUBAGENT must never land in the chat feed — it
        // would interleave with the main agent's answer. The SDK only forwards
        // it when `forwardSubagentText` is on (it isn't), so this is a guard,
        // not a live path.
        if (track.parentToolUseId) continue
        emittedText = true
        this.emit({
          kind: 'assistant-text',
          id: this.liveId ?? nextId(),
          text: block.text,
          final: true,
          ...(aborted ? { aborted: true as const } : {})
        })
      } else if (block.type === 'thinking' && block.thinking) {
        if (track.parentToolUseId) continue
        this.emit({ kind: 'thinking', id: nextId(), text: block.thinking })
      } else if (block.type === 'tool_use') {
        this.emit({
          kind: 'tool-use',
          id: block.id ?? nextId(),
          name: block.name ?? 'tool',
          input: block.input,
          // Which track ran this call: null = main agent, otherwise the `Task`
          // call that spawned the subagent. The renderer routes on this.
          parentToolUseId: track.parentToolUseId,
          ...(track.subagentType ? { subagentType: track.subagentType } : {}),
          ...(track.taskDescription ? { taskDescription: track.taskDescription } : {})
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

  private handleUser(content: AssistantBlock[] | string, parentToolUseId: string | null = null): void {
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type === 'tool_result') {
        const raw = (block as unknown as { content?: unknown; tool_use_id?: string; is_error?: boolean })
        this.emit({
          kind: 'tool-result',
          id: nextId(),
          toolUseId: raw.tool_use_id ?? '',
          isError: Boolean(raw.is_error),
          text: stringifyToolResult(raw.content),
          parentToolUseId
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
