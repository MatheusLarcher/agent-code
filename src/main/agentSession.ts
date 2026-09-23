import { query, type McpServerConfig, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'
import { createAppMcpServer, APP_RESTART_HINT } from './appTools'
import { appRestart } from './appRestartRuntime'
import type { RestartActivity } from './appRestart'
import { isUsageExhausted, sdkUsageExhausted } from './providerQuota'
import { isStalled, STALL_POLL_MS } from './stallWatch'
import { composeRequestContext, composeUserPrompt } from './promptEnvelope'
import type { BrowserController } from './browserController'
import { createBrowserMcpServer } from './browserTools'
import { createAndroidMcpServer } from './android/androidTools'
import { createWindowsControlMcpServer, WINDOWS_CONTROL_HINT } from './windowsControl/tools'
import { windowsControl } from './windowsControl/service'
import { loadConfig } from './config'
import { getCacheInfo } from './store'
import { localLeftoversSettled } from './localLeftovers'
import { memoryWriteDenial } from './memory/memoryPaths'
import { createMemoryMcpServer } from './memory/memoryTools'
import { createTaskMcpServer } from './tasks/taskTools'
import { taskLedger } from './tasks/taskRuntime'
import { activeScopesFor, writeScopeDenial, type ScopedTask } from './tasks/writeScopeGuard'
import { newPlanGateState, notePlanTool, notePlanTurn, planGateDenial } from './board/planGate'
import { buildSpecialistAgents } from './agents/specialists'
import { applyPlanningSessionOptions, handoffAppendBlock, planGateApplies, sessionSkillDenial, sessionWriteScopes } from './planning/planningSession'
import { planningPreToolDecision, planningRequiresBashApproval, planningToolDenial } from './planning/planningPolicy'
import {
  memoryService,
  readSecret,
  readSecretsForPrompt,
  secretSink,
  secretVaultEnabled
} from './memory/memoryRuntime'
import {
  createMemoryCatalogSnapshot,
  memoryCatalogFilesystemVersion,
  renderMemoryCatalogUpdate,
  buildDynamicMemoryContext,
  type MemoryCatalogSnapshot
} from './memoryIndex'
import { selectMemoriesWithTypeSafe, typeSafeMemorySelectionActive, type MemorySelection } from './typesafe'
import { forgetUsedMemories, recordUsedMemories } from './memoria/memoriasUsadas'
import { homedir, hostname } from 'node:os'
import {
  createSkillCatalogSnapshot,
  discoverSkills,
  renderSkillCatalogUpdate,
  skillCatalogFilesystemVersion,
  type SkillCatalogSnapshot
} from './skillDiscovery'
import { readSessionTasks, watchSessionTasks } from './sessionTasks'
import {
  ensureNativeSkillRoot,
  exposeCacheSkills,
  managedSkillsFilesystemVersion,
  syncCacheSkills
} from './skillManager'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  fastModeTransport,
  isOllamaModel,
  isOpenAIModel,
  modelSupportsVision,
  OLLAMA_BASE_URL
} from '../shared/ipc'
import { ensureCodexProxyRunning, FAST_MODE_TOKEN_SUFFIX } from './codexProxy'
import { isCodexConnected } from './codexAuth'
import { describeImages, mergeUserTextWithVisualContext } from './visionRelay'
import { buildProjectOutline } from './projectOutline'
import { pathWithRtk } from './rtk'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  AskQuestion,
  AgentInterruptResult,
  AgentMessageKind,
  ChatEvent,
  ImageAttachment,
  PermissionRequest,
  PermissionResponse,
  RateLimitStatus,
  StartAgentOptions,
  TokenUsage
} from '../shared/ipc'
import { storageLifecycle } from './persistence/lifecycle'
import type { AgentInputQueueRepository, ProjectConversationCount, TokenUsageRepository } from './persistence/types'

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
// O modo NÃO reduz mais o rigor do trabalho: todos os recursos, validações e
// verificações continuam valendo igual ao modo normal. Ele apenas ADICIONA
// duas skills de compressão de tokens (`caveman` na saída, `rtk` na entrada).
const ECONOMY_HINT = `MODO ECONÔMICO ATIVADO — O USUÁRIO MARCOU O TOGGLE "ECONÔMICO" NA UI.

Este modo NÃO muda o que você faz nem o rigor com que faz. Todas as regras normais
continuam valendo integralmente: planejamento, typecheck, testes, build, validação
no app, revisão, segurança e Definition of Done. Não pule nenhuma etapa por causa
deste modo.

A única mudança é COMO os tokens trafegam. Enquanto este modo estiver ativo:

1. Carregue a skill **caveman** (ferramenta Skill, nome \`caveman\`) no início do
   turno e siga o estilo dela em todas as suas respostas — comprime a SAÍDA sem
   perder substância técnica.

2. Carregue a skill **rtk** (ferramenta Skill, nome \`rtk\`) e siga a regra dela ao
   usar o Bash: prefixe com \`rtk\` os comandos cobertos (\`git\`, \`ls\`, \`grep\`,
   \`test\`, \`tsc\`, \`docker\`, \`vitest\`, \`find\`, \`diff\`…) — comprime a ENTRADA
   vinda do terminal.

3. Se uma das duas skills não estiver disponível, siga com a outra e avise o
   usuário em uma linha; nunca trave a tarefa por causa disso.

Fora essas duas skills, comporte-se exatamente como no modo normal.`

// Short per-message companion of ECONOMY_HINT (see send()).
export const ECONOMY_TURN_REMINDER = `[MODO ECONÔMICO LIGADO — antes de qualquer outra ação neste turno: (1) se ainda não carregou nesta sessão, chame a ferramenta Skill com "caveman" e depois com "rtk"; (2) responda no estilo caveman; (3) todo comando de Bash coberto pelo rtk (git, ls, grep, find, diff, tsc, vitest, npm test, docker…) vai com o prefixo \`rtk\`. Rigor, testes e validações continuam normais.]`

const LOOP_HINT = `MODO LOOP ATIVADO PELO USUÁRIO NESTA CONVERSA.

Quando uma mensagem normal chegar com este modo ativo, ela será transformada internamente em /loop. Em CADA ciclo:
1. se o usuário escreveu uma condição de saída explícita, verifique-a primeiro;
2. se essa condição explícita já foi atingida, chame ScheduleWakeup com {"stop":true} e entregue o resultado final;
3. se não existe condição de saída explícita, NÃO invente uma e NÃO encerre antes do limite: continue agendando até completar 100 ciclos;
4. só peça o próximo ScheduleWakeup DEPOIS de concluir e verificar o trabalho possível neste ciclo;
5. nunca use ScheduleWakeup apenas para esperar um subagente ou tarefa em background;
6. não inclua campos fora do schema, como "noop".

O Agent Code aplica 100 ciclos por padrão. Um limite maior só vale quando o usuário o pedir
explicitamente no texto. Somente uma condição de saída explícita encerra o loop antes do limite.`

// Persistent, cross-conversation memory. The .md files live in the user's chosen
// cache folder (next to the SQLite db — see store.ts), so the PATH is per-user/per-machine,
// but THESE INSTRUCTIONS ship with the project, so every install behaves the same.
// Built per session because the folder path and the current index are dynamic.
/**
 * Entrega as senhas guardadas ao modelo, em texto puro, quando o usuário liga a
 * opção em Configurações. Desligado (o padrão), devolve string vazia e nada sai
 * do cofre.
 *
 * O interruptor é lido AQUI, na montagem da sessão. Ligar depois só vale na
 * sessão seguinte — o system prompt já foi enviado, e não há como retirar da
 * janela do modelo o que já entrou nela.
 */
async function buildSecretsHint(): Promise<string> {
  // Cofre indisponível degrada o turno; impedir a conversa de abrir seria pior.
  const secrets = await readSecretsForPrompt().catch(() => [])
  if (!secrets.length) return ''
  const lines = secrets.map((secret) => `- ${secret.name}: ${secret.value}`).join('\n')
  return `\n\n# Senhas do cofre

O usuário autorizou o acesso a estas credenciais em Configurações. Os valores
abaixo são reais — use-os quando a tarefa precisar e trate-os como segredo:
não os repita na resposta, em log, em commit, nem em arquivo, a menos que o
usuário peça explicitamente.

${lines}`
}

/**
 * Só entra no prompt quando o registro está ligado a um repositório. Diz ao
 * modelo O QUE é a fila e a disciplina mínima (reivindicar → running → evidência
 * → estado final); as regras duras vivem no repositório e voltam como texto
 * legível quando violadas.
 */
const TASKS_HINT = `You have a durable TASK LEDGER shared by the agent team (tools task_*). It is how work is delegated, scoped and verified across agents.

ROLES
- SUPERVISOR (you, in the main conversation, for any non-trivial request): decompose the request into tasks with task_create — each with a goal, VERIFIABLE acceptance criteria and a write_scope_allow (the files the executor may touch). Then delegate each task with the Agent tool using subagent_type "executor", passing the task id in the prompt. Do not implement delegated tasks yourself.
- EXECUTOR (subagent_type "executor", given a task id): task_claim(task_id) → task_transition pending→running → task_step_start per phase → do the work → task_deliverable_add for every piece of EVIDENCE (diff, test_run, note, file, screenshot) → task_transition running→review with a short reason. Never declare done yourself.
- CRITIC/REVIEWER (subagent_type "critico", or you for a small task): read task_get, check every acceptance criterion against the deliverables (run the tests yourself if a test_run is claimed), then either task_transition review→done, or send it back. The critic has no Write/Edit on purpose — a critic that fixes what it reviews stops being one.
- Two more specialists exist for the work around the task: "navegador-de-codigo" (read-only: where something lives in the code, answered as caminho:linha, without spending the main context) and "memoria" (looks up and proposes entries in the user's memory catalog).

SENDING WORK BACK — pick by who will redo it
- The SAME live executor will fix it now: task_transition review→running, then it keeps working under the same task.
- A NEW executor will redo it (the usual case: the first subagent already finished): task_transition review→failed with a reason listing exactly what is missing, then task_transition failed→pending. Only a "pending" task can be claimed, so this is what puts it back in the queue; skipping it leaves the task stranded in "running" with nobody able to take it. Each claim spends one attempt, and a task out of attempts stops being handed out — that is the anti-loop budget.

RULES THE LEDGER ENFORCES (not you)
- task_claim returns a LEASE (lease_token + fencing_epoch). Every write to that task must carry both. Another agent cannot claim the task while the lease lives; the lease is renewed automatically on every write you make.
- Moving a task to review or blocked RELEASES the lease — the executor is handing off. From then on, call the task's tools WITHOUT lease_token/fencing_epoch (that is how the critic closes it). Reusing the old fence after a handoff is refused.
- While you hold a task with write_scope, Write/Edit outside that scope are REFUSED by the permission gate, even with "allow all" on. Bash is checked too, by the write targets found in the command (redirection, cp/mv/rm/mkdir/touch/tee, sed -i, dd of=): a command whose target cannot be pinned down — one built from a variable, a relative path after cd, git checkout/restore/clean — is refused with the reason, so rewrite it with an absolute path inside the scope. If a file outside scope must change, record a task_event "blocker" and ask the supervisor to widen the scope or open another task.
- Invalid transitions and stale leases are refused and explained in the reply; read task_get and adjust instead of retrying blindly.
- "done" without deliverables is just a claim. A reviewer that finds no evidence sends the task back.

Trivial requests (one file, obvious change, no verification needed) do not need the ledger.`

function buildMemoryHint(memoriesDir: string): string {
  return `You have a PERSISTENT MEMORY for this user, kept as Markdown files in this folder:
${memoriesDir}

This folder is part of the user's cache folder (next to the app's database) and survives across
conversations. The memories are private to THIS user/machine — always use the ABSOLUTE path above
(your working directory is the user's project, NOT this folder). READING the folder is free
(Read/Glob/Grep). WRITING it directly is blocked: Write/Edit on these files is denied even with
"Permitir tudo" on, because the app keeps the files and MEMORY.md consistent from its own database.
To save, use the "memory_propose" tool (op create/update/retire); it writes the file AND the index.

SUBFOLDERS — the user may group memories in subfolders (e.g. "2D/"). The folder name IS context:
every memory listed under a folder section below is about that subject. When the current task is
about that subject, those memories apply; save new memories on that subject INTO the same folder
(path relative to the root above, e.g. "2D/<short-kebab-name>.md").

SAVING — when the user asks you to remember, save, note, or memorize something ("lembra disso",
"salva na memória", "anota", "memorize", "remember this", etc.):
- Call "memory_propose" with ONE fact per file: rel_path "<short-kebab-name>.md" (or
  "<subfolder>/<short-kebab-name>.md" when the fact belongs to an existing group), plus "title"
  and "hook" — those two become the MEMORY.md bullet, which the app regenerates for you.
- Before creating, check the index/"memory_list" for an existing memory on the same topic and use
  op "update" (with its "expected_revision") instead of creating a duplicate. Use op "retire" when
  a memory becomes wrong — never delete the file by hand.
- If the fact includes a credential (key, token, password), pass it in "secrets: [{name, value}]".
  The value goes to the app's encrypted vault and the note keeps only a "{{secret:<name>}}" marker.
- Do NOT save things already evident from the project's code, git history, or CLAUDE.md.

RECALLING — these files are your long-term knowledge about this user and their projects. The complete
catalog is loaded once when this conversation starts. On every actual provider request, Agent Code also
adds only bounded excerpts relevant to the active task (without the whole catalog and without vault values).
Before every user dispatch, Agent Code hashes the current Markdown contents. If anything changed, one
complete authoritative replacement is attached automatically; unchanged catalogs are never duplicated in
the conversation.`
}

/**
 * Ferramentas cujo efeito termina junto com a chamada, então não deixam dúvida
 * sobre reiniciar. Tudo fora desta lista conta como opaco ENQUANTO estiver em
 * voo (ver `restartOpaqueCalls`) — a diferença entre "não sei o que isso fez" e
 * "isso ainda está rodando".
 */
const VERIFIED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'mcp__app__app_restart'
]

/**
 * Trabalho que segue vivo DEPOIS de a chamada retornar: o retorno não prova
 * nada, então a sessão fica permanentemente incerta. É o caso que justifica um
 * latch — e o único.
 */
function startsDetachedWork(toolName: string, input: unknown): boolean {
  if (toolName === 'CronCreate' || toolName === 'RemoteTrigger' || toolName === 'Workflow') return true
  // Bash/Agent com run_in_background devolvem na hora e continuam rodando.
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { run_in_background?: unknown }).run_in_background === true
  )
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

// Quanto o Stop espera o recibo da interrupção antes de desistir de esperar. O
// recibo é informação (quais mensagens sobreviveram), não a interrupção em si:
// se o CLI estiver ocupado demais para responder, segurar a resposta do Stop
// só faz a tela ficar parada em "trabalhando" sem ninguém saber por quê.
const INTERRUPT_ACK_TIMEOUT_MS = 5_000

/** Arquivos do diretório de configuração do CLI que precisam sobreviver ao
 *  desvio abaixo: são o que o usuário percebe se sumir. */
const CLI_CONFIG_CARRY_OVER = ['CLAUDE.md', 'settings.json']

/**
 * Diretório de configuração para o CLI nas sessões que **não** falam com a
 * Anthropic (GPT pelo proxy do Codex, Ollama).
 *
 * O CLI prefere a credencial guardada do login do claude.ai a qualquer
 * `ANTHROPIC_AUTH_TOKEN` que a gente passe. Com o `ANTHROPIC_BASE_URL`
 * apontando para outro backend, ele mandava o `sk-ant-…` do usuário para lá: o
 * proxy respondia 401, o CLI reentrava para sempre e o turno **nunca
 * terminava** — sem resposta, sem erro e sem fim. Apontar o CLI para um
 * diretório onde não existe credencial nenhuma é o que o faz usar o token que
 * a gente passou. (Limpar `ANTHROPIC_API_KEY` não bastava: o login por OAuth
 * não vem de variável de ambiente, vem do disco.)
 *
 * O diretório é semeado com o `CLAUDE.md` e o `settings.json` do usuário para
 * as instruções globais e as configurações continuarem valendo — some a
 * credencial, não o resto. Melhor esforço: nada aqui pode derrubar um turno.
 */
export function cliConfigDirWithoutStoredLogin(localDir: string): string | undefined {
  try {
    const source = process.env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude')
    // Raiz local, não a pasta sincronizada: o CLI grava aqui transcrições,
    // plugins e telemetria a cada turno.
    const target = join(localDir, 'cli-config-sem-login')
    mkdirSync(target, { recursive: true })
    for (const name of CLI_CONFIG_CARRY_OVER) {
      const from = join(source, name)
      const to = join(target, name)
      if (!existsSync(from)) continue
      // Copia só quando muda: isto roda a cada sessão.
      const fresh = existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs
      if (!fresh) copyFileSync(from, to)
    }
    return target
  } catch (error) {
    // Sem o desvio o turno falharia com 401 em silêncio, que é pior do que um
    // aviso no log — mas derrubar a sessão aqui seria pior ainda.
    console.warn('[cli-config] não consegui preparar o diretório sem credencial:', error)
    return undefined
  }
}

/** Runtime-only preparation shared by regular GPT sessions and the PO Luna
 * observer. Its result is never serialized: it keeps the local proxy secret,
 * OAuth handling and isolated CLI config on the GPT side of the boundary. */
export interface GptObserverRuntime {
  env: NodeJS.ProcessEnv
}

export async function prepareGptRuntime(
  model: string,
  fastMode = false,
  /** Receives the proxy failure detail. The PO observer ignores it; a normal
   * GPT session still shows the cause, as it did before this extraction. */
  onError?: (detail: string) => void
): Promise<GptObserverRuntime | null> {
  if (!isOpenAIModel(model) || !isCodexConnected()) return null
  const cacheInfo = getCacheInfo()
  await localLeftoversSettled()
  const foreignCliConfigDir = cliConfigDirWithoutStoredLogin(cacheInfo.localDir)
  // A foreign backend must never inherit the process-level Claude root: that
  // root can contain an OAuth/API credential the CLI gives precedence to.
  if (!foreignCliConfigDir) return null
  try {
    const { baseUrl, secret } = await ensureCodexProxyRunning((line) => console.log(`[codex-proxy] ${line}`))
    return {
      env: {
        ...process.env,
        ...(foreignCliConfigDir ? { CLAUDE_CONFIG_DIR: foreignCliConfigDir } : {}),
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN:
          fastMode && fastModeTransport(model) === 'codex-priority'
            ? `${secret}${FAST_MODE_TOKEN_SUFFIX}`
            : secret,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model
      }
    }
  } catch (error) {
    console.warn('[codex-proxy] não consegui preparar runtime GPT do observador:', error)
    onError?.(String(error))
    return null
  }
}

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

/** Tool names that open a subagent node in the token-usage tree — same set
 *  `agentTracks.ts` in the renderer uses for live delegation tracks. */
const SPAWN_TOOLS = new Set(['Task', 'Agent'])

/** Reconstructs what an assistant message "said" for the token-usage preview:
 *  text, thinking, and a compact rendering of each tool call. Not a byte-exact
 *  copy of the HTTP request (see docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md),
 *  truncated like every other stored preview in this file. */
function buildOutputPreview(blocks: AssistantBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`[thinking] ${block.thinking}`)
    } else if (block.type === 'tool_use') {
      let inputStr = ''
      try {
        inputStr = JSON.stringify(block.input)
      } catch {
        inputStr = ''
      }
      parts.push(`[tool_use: ${block.name ?? 'tool'}] ${inputStr}`)
    }
  }
  return parts.join('\n').slice(0, 4000)
}

function trackOf(message: unknown, parentToolUseId: string | null): TrackInfo {
  if (!parentToolUseId) return EMPTY_TRACK
  const m = message as { subagent_type?: unknown; task_description?: unknown }
  return {
    parentToolUseId,
    ...(typeof m.subagent_type === 'string' && m.subagent_type ? { subagentType: m.subagent_type } : {}),
    ...(typeof m.task_description === 'string' && m.task_description ? { taskDescription: m.task_description } : {})
  }
}

const EMPTY_SKILL_CATALOG = createSkillCatalogSnapshot([])

export interface SkillRuntimePaths {
  appRoot: string
  userHome?: string
}

export interface AgentContinuationState {
  approvedTools: string[]
  loopActive: boolean
  loopCycles: number
  loopLimit: number
  loopScheduledThisIteration: boolean
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
      /** Auto-resolve timer (cleared if the user answers first; undefined while a
       *  minimized question waits with no deadline). */
      timer: ReturnType<typeof setTimeout> | undefined
    }
  >()
  private approvedTools = new Set<string>()
  /** "Allow all" — when true every tool is auto-approved without prompting. Toggleable at runtime. */
  private bypassAll = false
  /** Set when the user manually canceled the previous turn. The SDK keeps the
   *  interrupted exchange in its in-memory context (no API to drop it), so the
   *  next message is prefixed with a note telling the model to disregard it. */
  private canceledPending = false
  /** Original task text for bounded memory retrieval across the model's tool
   * loop. The full docs context is re-read by SDK hooks for every request. */
  private activeMemoryQuery = ''
  /**
   * A decisão do TypeSafe sobre quais memórias vão neste turno, memoizada.
   *
   * `buildLiveRequestContext` roda a cada request do provedor — várias vezes
   * dentro do loop de ferramentas de UMA mensagem. A escolha é da mensagem, não
   * do request: a promessa é criada uma vez, junto de `activeMemoryQuery`, e
   * todos os requests do turno esperam a mesma. `null` enquanto nenhuma
   * mensagem do usuário abriu um turno.
   */
  private activeMemorySelection: Promise<MemorySelection | null> | null = null
  /** Ordinal da decisão de memória. Uma decisão que demora não pode sobrescrever
   *  o registro de uma mensagem posterior que já decidiu. */
  private memorySelectionTurn = 0
  private liveId: string | null = null
  private liveText = ''
  /** Text lookup for UUIDs returned by the SDK interrupt receipt. Bounded so a
   *  long-lived session cannot retain every prompt forever. */
  private submittedMessages = new Map<string, string>()
  /** Context-window size of the most recent model request (last `assistant`
   *  message's input usage) — the true "context used", not the per-turn sum. */
  private lastContextTokens = 0
  /** Root `node_id` of the CURRENT turn — the token-usage tree's root node for
   *  the main agent. Lazily created (see `getTurnId`) and replaced on every
   *  new user turn (`beginTurn`). */
  private currentTurnId: string | null = null
  /** `nodeId -> parentNodeId` for the token-usage tree, populated when a
   *  `Task`/`Agent` tool-use is observed. Cleared every turn: a subagent's
   *  tool-use id never repeats across turns, so nothing is lost by starting
   *  fresh. */
  private readonly llmNodeParents = new Map<string, string | null>()
  /** Per-node call counter for `llm_calls.seq` — a subagent exchanges several
   *  messages with the model over its lifetime. */
  private readonly llmNodeSeq = new Map<string, number>()
  /** Latest reconstructed input (user text / tool result) seen for a node,
   *  consumed by the NEXT assistant message on that same node. */
  private readonly llmNodeInputPreview = new Map<string, string>()
  /** Calls emitted during the current turn, retained for terminal usage reconciliation. */
  private readonly turnLlmCalls = new Map<string, { nodeId: string; seq: number; model: string; tokens: TokenUsage; persistentId?: string }>()
  /** Version of the complete persistent-memory catalog already loaded into this session. */
  private memoryCatalogVersion = ''
  /** Content signature checked before materializing a replacement catalog. */
  private memoryFilesystemVersion = ''
  /** Version of the authoritative skill catalog already loaded into this
   *  session. Recomputed before every user dispatch so installs/removals become
   *  available without reopening the conversation. */
  private skillCatalogVersion = ''
  /** Version successfully reloaded by the SDK's native Skill registry. Kept
   *  separate so a transient reload failure is retried without duplicating the
   *  catalog update already delivered to the model. */
  private nativeSkillRegistryVersion = ''
  /** Signature of the last projects-on-this-machine list delivered to the
   *  model. Recomputed before every user dispatch; unchanged since last turn
   *  means nothing is re-sent (same "only when it changes" rule as memory/skills). */
  private projectsCatalogVersion = ''
  /** The catalog actually announced for `nativeSkillRegistryVersion` — the
   *  discovered snapshot minus whatever the SDK refused to load. */
  private nativeConfirmedSnapshot: SkillCatalogSnapshot | null = null
  /** Cheap metadata-only signature checked before parsing any frontmatter. */
  private skillFilesystemVersion = ''
  /** Content signature of the versioned `.agents/skills` source already copied
   * into the active cache for this session. */
  private managedSkillSourceVersion = ''
  /** A content-level managed skill change still awaiting SDK confirmation. */
  private managedSkillReloadPending = false
  /** Per-session cancellation scope for Windows UI actions. */
  private windowsControlScope = windowsControl.createScope()
  /** Stops the task-folder watcher of the CURRENT sdk session (a resume/restart
   *  can hand us a different session id, and then we re-point the watcher). */
  private stopTaskWatch: (() => void) | null = null
  private watchedSessionId: string | null = null
  /** Effective CLI root of this SDK process. GPT points it at the isolated
   * config so task-list snapshots never leak to the default Claude root. */
  private sessionTasksRoot: string | undefined
  private disposed = false
  private inputDrain: Promise<void> = Promise.resolve()
  private currentInputId: number | null = null
  private loopActive = false
  private loopCycles = 0
  private loopLimit = DEFAULT_LOOP_LIMIT
  private loopScheduledThisIteration = false
  private turnActive = false
  private idleWaiters = new Set<() => void>()
  private mirrorFailed = false
  private quotaRejected = false
  private providerContinuation = false
  private handoffReady: Promise<void> = Promise.resolve()
  private restartInitializing = true
  private restartPersisting = false
  private restartBackground: number | null = null
  private restartUncertain = false
  /**
   * Chamadas de ferramenta EM VOO cujo efeito não é verificável (shell, MCP de
   * terceiro, subagente). Entram no PreToolUse e saem quando a ferramenta
   * retorna — retornar É a prova de que terminou.
   *
   * Antes isto era um booleano que, uma vez ligado, nunca desligava: a primeira
   * chamada de Bash de qualquer conversa bloqueava o reinício pelo resto da vida
   * do processo (e `dispose` mantém o registro quando há incerteza, então nem
   * fechar a conversa liberava). O recurso de reinício ficava inalcançável.
   */
  private readonly restartOpaqueCalls = new Set<string>()
  private restartRegistration: ReturnType<NonNullable<typeof appRestart>['register']> | undefined

  /**
   * Detecção de travamento. "Ocupado" sozinho é otimista: liga ao enviar e só
   * desliga no `result`/`error`, então uma sessão travada e uma trabalhando são
   * indistinguíveis na tela — e é justamente com muitos agentes ao mesmo tempo
   * que isso acontece.
   *
   * `toolsInFlight` é PARALELO a `restartOpaqueCalls` e não se confunde com ele:
   * aquele rastreia só ferramenta não verificável (é sobre reiniciar com
   * segurança), este rastreia QUALQUER ferramenta (é sobre quanto tempo de
   * silêncio é normal — um build legítimo fica minutos sem emitir nada).
   */
  private lastActivityAt = Date.now()
  private readonly toolsInFlight = new Set<string>()
  private stalled = false
  private stallTimer: ReturnType<typeof setInterval> | undefined

  /**
   * O turno começou. Precisa ser chamado em TODO ponto que liga `turnActive`,
   * não só no hook `UserPromptSubmit`: o hook só dispara quando o CLI de fato
   * processa o prompt, e o caso mais grave de travamento é justamente o
   * processo que nunca chega lá. Ligando o watchdog só no hook, ele perderia
   * exatamente o silêncio que existe para detectar.
   */
  /**
   * Tarefas que esta sessão reivindicou e ainda não largou, com o `write_scope`
   * delas. Alimentado pelos ganchos do servidor MCP `tasks`; lido no gate de
   * permissão para recusar Write/Edit fora do escopo — fora do LLM e antes do
   * "Permitir tudo". Vazio = comportamento de sempre.
   */
  private readonly scopedTasks = new Map<string, ScopedTask>()

  /**
   * Quem chamou o último `task_claim`: o gate vê o `agentID` do SDK
   * (`undefined` = agente principal) e o servidor MCP, não. Guardado aqui entre
   * a autorização e a execução da ferramenta, que são consecutivas, para o
   * escopo saber a quem pertence.
   */
  private claimingAgent: string | null = null

  /**
   * Escopos que valem para este agente agora. Filtra os expirados (subagente
   * que morreu sem transicionar deixaria a sessão restrita para sempre) e os
   * de OUTRO subagente (um executor em `src/tasks/**` não pode impedir o
   * supervisor de escrever enquanto delega).
   */
  activeScopedTasks(agentId: string | null = null): ScopedTask[] {
    return activeScopesFor(this.scopedTasks.values(), agentId)
  }

  private beginTurn(): void {
    this.turnActive = true
    // A new turn is a new root node for the token-usage tree: fresh turnId,
    // fresh delegation map (a subagent's tool-use id from a past turn will
    // never come back, so nothing is lost by dropping it here).
    this.currentTurnId = randomUUID()
    this.llmNodeParents.clear()
    this.llmNodeSeq.clear()
    this.llmNodeInputPreview.clear()
    this.turnLlmCalls.clear()
    notePlanTurn(this.planGate)
    this.markActivity()
    this.startStallWatch()
  }

  /** Root `node_id` of the current turn — lazily created so code paths that
   *  observe SDK messages without going through `beginTurn` first (tests
   *  driving `handleMessage` directly) still get a stable id for the turn. */
  private getTurnId(): string {
    if (!this.currentTurnId) this.currentTurnId = randomUUID()
    return this.currentTurnId
  }

  /** Estado da trava do plano, por sessão. `declared` atravessa turnos de
   *  propósito — ver `notePlanTurn`. */
  private readonly planGate = newPlanGateState()

  /** Conversa de handoff (`opts.handoff`): o primeiro turno já terminou (result
   *  ou erro)? Até lá as skills de replanejamento são recusadas no gate.
   *  Sessão retomada (`opts.resume`) já passou do 1º turno — ver o construtor. */
  private handoffFirstTurnDone = false

  /** Qualquer sinal de vida do turno: mensagem do SDK ou ferramenta mudando de
   *  estado. Sai do travado na hora, sem esperar o próximo tique. */
  private markActivity(): void {
    this.lastActivityAt = Date.now()
    if (this.stalled) {
      this.stalled = false
      this.emit({ kind: 'stall-status', stalled: false, since: this.lastActivityAt })
    }
  }

  private checkStall(): void {
    // Fora de um turno o silêncio é o estado normal, não uma falha.
    if (!this.turnActive || this.disposed) return
    if (this.stalled) return
    if (!isStalled(Date.now(), this.lastActivityAt, this.toolsInFlight.size > 0)) return
    this.stalled = true
    this.emit({ kind: 'stall-status', stalled: true, since: this.lastActivityAt })
  }

  private startStallWatch(): void {
    if (this.stallTimer) return
    // `unref` para o intervalo nunca segurar o processo vivo no encerramento.
    this.stallTimer = setInterval(() => this.checkStall(), STALL_POLL_MS)
    this.stallTimer.unref?.()
  }

  private stopStallWatch(): void {
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = undefined
    // O turno acabou: se a tela estava mostrando "sem resposta", desfaz — senão
    // o aviso ficaria colado depois de a resposta chegar.
    if (this.stalled) {
      this.stalled = false
      this.emit({ kind: 'stall-status', stalled: false, since: Date.now() })
    }
  }

  restartActivity(): RestartActivity {
    return {
      busy: this.restartInitializing || this.restartPersisting || this.turnActive || this.pendingPermissions.size > 0,
      unsafe: this.restartUncertain || this.restartOpaqueCalls.size > 0
        ? 'Trabalho autônomo sem prova de término.'
        : this.restartBackground === null ? 'Estado de background desconhecido.'
        : this.restartBackground > 0 ? 'Tarefas em background ativas.'
        : this.loopActive ? 'Loop/agendamento ativo.' : this.mirrorFailed ? 'Persistência não verificada.' : undefined
    }
  }

  constructor(
    private readonly opts: StartAgentOptions,
    private readonly browser: BrowserController,
    private readonly emit: (e: ChatEvent) => void,
    private readonly askPermission: (req: PermissionRequest) => void,
    /** Called when a pending permission/question timed out and was auto-resolved,
     *  so the renderer can close the matching modal. */
    private readonly onPermissionExpire: (id: string) => void,
    private readonly sessionStore?: SessionStore,
    private readonly onTurnDurable?: (sessionId: string, mirrorFailed: boolean) => Promise<void>,
    private readonly skillRuntime?: SkillRuntimePaths,
    /** Called after the SDK has emitted the terminal result for a turn. */
    private readonly onTurnComplete?: () => void | Promise<void>,
    /** Persists `llm_calls` for the token-usage tree (see
     *  docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md).
     *  Optional: a session with none simply skips persistence but still emits
     *  the live `llm-call` ChatEvent. */
    private readonly tokenUsageRepository?: TokenUsageRepository,
    /** Durable FIFO for messages submitted while the SDK is busy or restarting. */
    private readonly inputQueueRepository?: AgentInputQueueRepository
  ) {
    // Native class fields run before constructor parameter properties are assigned.
    this.restartRegistration = appRestart?.register(opts.convId, () => this.restartActivity())
    // Um handoff retomado (app reiniciado, conversa reaberta) já teve o 1º turno.
    this.handoffFirstTurnDone = Boolean(opts.resume)
  }

  async start(): Promise<boolean> {
    if (this.disposed) return false
    this.bypassAll = this.opts.skipPermissions === true

    const cfg = loadConfig()

    const mcpServers: Record<string, McpServerConfig> = {
      browser: createBrowserMcpServer(this.browser),
      android: createAndroidMcpServer(this.browser),
      ...(this.restartRegistration ? { app: createAppMcpServer(this.restartRegistration.request) } : {})
    }
    if (process.platform === 'win32') {
      mcpServers.windows = createWindowsControlMcpServer(this.windowsControlScope)
    }
    // Only when the service is bound to an authoritative repository: without it
    // the tool would accept a memory and quietly drop it.
    const memory = memoryService()
    if (memory) {
      mcpServers.memory = createMemoryMcpServer({
        service: memory,
        vault: secretSink(),
        secretVaultEnabled,
        readSecret,
        conversationId: this.opts.convId,
        agent: 'session'
      })
    }
    // Registro de tarefas: a porta de entrada do multi-agent (item 5 do
    // subprojeto). Mesma regra do memory: só com repositório autoritativo,
    // senão a ferramenta aceitaria a tarefa e a perderia em silêncio.
    const ledger = taskLedger()
    if (ledger) {
      mcpServers.tasks = createTaskMcpServer({
        ledger,
        conversationId: this.opts.convId,
        projectCwd: this.opts.cwd,
        agent: `session:${this.opts.convId}`,
        // O escopo declarado na tarefa passa a valer no gate assim que esta
        // sessão vira o writer, e deixa de valer quando ela larga a tarefa.
        // Também roda a cada renovação de lease, então a validade acompanha a
        // posse real em vez de congelar no instante da reivindicação.
        onHold: (task, leaseExpiresAt) => {
          const held = this.scopedTasks.get(task.id)
          this.scopedTasks.set(task.id, {
            id: task.id,
            title: task.title,
            projectCwd: task.projectCwd,
            writeScope: task.writeScope,
            leaseExpiresAt,
            // Na renovação o dono já é conhecido; só a reivindicação o define.
            holder: held ? held.holder : this.claimingAgent
          })
        },
        onRelease: (taskId) => {
          this.scopedTasks.delete(taskId)
        }
      })
    }
    // Tell the model where its per-user memory lives (and pre-load the complete catalog), so
    // "lembra disso" saves into the cache folder and recall works across chats.
    const cacheInfo = getCacheInfo()
    this.synchronizeManagedSkills(cacheInfo.dir, cacheInfo.skillsDir)
    const memoriesDir = cacheInfo.memoriesDir
    const cacheSkillsDir = cacheInfo.skillsDir
    // The CLI (driven via SDK) only discovers skills under <cwd>/.claude/skills and
    // <additionalDirectory>/.claude/skills — never under ~/.claude/skills. Hand it a
    // root whose .claude/skills is a junction to the cache skills. See skillManager.
    const nativeRoot = ensureNativeSkillRoot(cacheInfo.dir, cacheSkillsDir)
    if (nativeRoot.errors.length > 0) console.warn('[skills] native skill root:', nativeRoot.errors.join('\n'))
    const nativeSkillDirs = nativeRoot.errors.length === 0 ? [nativeRoot.root] : []
    // O seletor do TypeSafe substitui o catálogo: com ele no ar, nem o índice
    // completo entra no system prompt nem as versões são marcadas como
    // entregues — desligar o recurso no meio da conversa faz o próximo despacho
    // injetar o catálogo inteiro.
    const memorySelectorActive = await typeSafeMemorySelectionActive()
    const memorySnapshot = memorySelectorActive ? null : this.readMemoryCatalogSnapshot(memoriesDir)
    this.memoryFilesystemVersion = memorySnapshot?.filesystemVersion ?? ''
    this.memoryCatalogVersion = memorySnapshot?.version ?? ''
    this.skillFilesystemVersion = skillCatalogFilesystemVersion(this.opts.cwd, this.skillRuntime?.userHome)
    const skillSnapshot = this.readSkillCatalogSnapshot()
    // The authoritative filesystem catalog is injected with the first user
    // dispatch, only after reloadSkills() confirms the same names.
    this.skillCatalogVersion = ''
    // The filesystem catalog and the CLI's native Skill registry are separate
    // states. Never mark the native registry as loaded before reloadSkills()
    // has actually confirmed it for this SDK process.
    this.nativeSkillRegistryVersion = ''
    const skillRoots = [...new Set(skillSnapshot.skills.map((skill) => skill.root))]
    let append = `${BROWSER_HINT}\n\n${ANDROID_HINT}\n\n${DOWNLOAD_HINT}\n\n${buildMemoryHint(memoriesDir)}`
    if (memorySnapshot) append += `\n\n${memorySnapshot.catalog}`
    append += `\n\n${APP_RESTART_HINT}`
    if (ledger) append += `\n\n${TASKS_HINT}`
    // Senhas em texto puro no prompt, só com o interruptor ligado. Vai no system
    // prompt, e não anexado a cada mensagem, para a senha aparecer UMA vez por
    // sessão em vez de ser recopiada em todo turno do histórico.
    append += await buildSecretsHint()
    if (process.platform === 'win32') append += `\n\n${WINDOWS_CONTROL_HINT}`

    // Modo econômico: when the user toggled it on for THIS conversation, tell the
    // model to skip validation/build/tests for trivial tasks to save tokens.
    if (this.opts.economyMode) {
      append += `\n\n${ECONOMY_HINT}`
    } else if (this.opts.loopEnabled) {
      append += `\n\n${LOOP_HINT}`
    }
    // Conversa nascida de um handoff do planejamento: de onde veio, onde está o
    // plano e que o roteiro vira o plano dela. `null` em qualquer outra sessão.
    const handoffBlock = handoffAppendBlock(this.opts)
    if (handoffBlock) append += `\n\n${handoffBlock}`

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
    // A rota Ollama precisa do mesmo isolamento. A rota GPT prepara esse
    // diretório dentro de `prepareGptRuntime`, compartilhada pelo PO Luna.
    if (ollamaOn) await localLeftoversSettled()
    const foreignCliConfigDir = ollamaOn ? cliConfigDirWithoutStoredLogin(cacheInfo.localDir) : undefined

    let openaiEnv: typeof process.env | undefined
    if (openaiOn) {
      let detail = ''
      const runtime = await prepareGptRuntime(
        this.opts.model ?? '',
        this.opts.fastMode === true,
        (cause) => {
          detail = cause
        }
      )
      if (!runtime) {
        this.emit({
          kind: 'error',
          id: nextId(),
          text: detail
            ? `Não consegui iniciar o proxy do Codex: ${detail}`
            : 'Não consegui iniciar o proxy do Codex.'
        })
        return false
      }
      openaiEnv = runtime.env
    }

    let env = ollamaOn
      ? {
          ...process.env,
          ...(foreignCliConfigDir ? { CLAUDE_CONFIG_DIR: foreignCliConfigDir } : {}),
          ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: ollamaKey,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_DEFAULT_SONNET_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: this.opts.model,
          ANTHROPIC_DEFAULT_FABLE_MODEL: this.opts.model,
          CLAUDE_CODE_SUBAGENT_MODEL: this.opts.model
        }
      : openaiEnv

    // Economy mode leans on the `rtk` proxy binary, which is installed per-user
    // and put on the user PATH — but a PATH change only reaches processes
    // started after it, so a running app would need a restart to see it.
    // Resolve the install dir and prepend it to the subprocess PATH instead.
    // Nothing changes when rtk is not installed (the skill degrades on its own).
    if (this.opts.economyMode) {
      const rtkPath = pathWithRtk()
      if (rtkPath) env = { ...(env ?? process.env), PATH: rtkPath }
    }

    // The bundled CLI receives this environment rather than inheriting our
    // process. Task snapshots must resolve from that same effective root.
    this.sessionTasksRoot = env?.CLAUDE_CONFIG_DIR

    const options: Options = {
      cwd: this.opts.cwd,
      model: this.opts.model,
      ...(this.opts.effort ? { effort: this.opts.effort as Options['effort'] } : {}),
      // Modo rápido: only sent when the chosen model actually supports it — the
      // API rejects a fast-mode request on an unsupported model instead of
      // quietly serving it at standard speed.
      // GPT models carry fast mode in the Codex request body instead (see the
      // ANTHROPIC_AUTH_TOKEN suffix below) — `settings.fastMode` is Anthropic-only.
      ...(this.opts.fastMode && fastModeTransport(this.opts.model) === 'anthropic-setting'
        ? { settings: { fastMode: true } }
        : {}),
      ...(env ? { env } : {}),
      ...(openaiOn ? { maxTurns: OPENAI_MAX_TURNS } : {}),
      // The memories folder lives outside the project cwd, so allow it explicitly —
      // otherwise the workspace boundary would block reading/writing memory files.
      additionalDirectories: [...new Set([memoriesDir, cacheSkillsDir, ...nativeSkillDirs, ...skillRoots])],
      skills: 'all',
      // Resume a previous SDK session (loads its history) when continuing an old chat.
      ...(this.opts.resume ? { resume: this.opts.resume } : {}),
      ...(this.sessionStore
        ? { sessionStore: this.sessionStore, sessionStoreFlush: 'eager' as const, loadTimeoutMs: 30_000 }
        : {}),
      // Run the bundled Claude Code CLI under system Node rather than the
      // Electron binary, which would otherwise be picked up as the runtime.
      executable: 'node',
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      // O time de especialistas. Cada um só entra com o serviço de que depende
      // no ar — anunciar um crítico sem registro de tarefas seria oferecer ao
      // modelo um papel que falha na primeira chamada.
      agents: buildSpecialistAgents({ ledger: !!ledger, memory: !!memory }),
      mcpServers,
      hooks: {
        // `additionalContext` is the Agent SDK's supported live injection
        // channel. It reaches the request without being written into the user's
        // message history, unlike prefixing the SDK user payload.
        UserPromptSubmit: [{ hooks: [async () => {
          if (appRestart?.reserved) return { decision: 'block' as const, reason: 'Reinício reservado; novo turno recusado.' }
          this.beginTurn()
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit' as const,
              additionalContext: await this.buildLiveRequestContext()
            }
          }
        }] }],
        // A tool batch is the Agent SDK's documented point immediately before
        // the following model call. Rebuild here so a docs edit made while a
        // tool ran is present on that provider request as well.
        PostToolBatch: [{ hooks: [async () => ({
          hookSpecificOutput: {
            hookEventName: 'PostToolBatch' as const,
            additionalContext: await this.buildLiveRequestContext()
          }
        })] }],
        PreToolUse: [{ hooks: [async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {}
          const name = input.tool_name
          if (appRestart?.reserved && name !== 'mcp__app__app_restart') {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
              permissionDecisionReason: 'Reinício preparado. Termine o turno sem iniciar outro trabalho.' } }
          }
          // Agent Manager: a política do planejamento também aqui, não só no
          // canUseTool — um `allow` do settings.json pula o canUseTool, não o
          // PreToolUse. Negada, a ferramenta não roda e o SDK não dispara
          // PostToolUse nem PostToolUseFailure para ela: registrá-la em voo a
          // deixaria presa (e o reinício bloqueado). Com `ask` ela ainda pode
          // rodar, então segue o registro de sempre abaixo. Assíncrona: confere o
          // caminho REAL das escritas (junction/symlink para fora do _sandbox).
          const planning = await planningPreToolDecision(this.opts, name, input.tool_input)
          if (planning?.decision === 'deny') {
            this.markActivity()
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
              permissionDecisionReason: planning.reason } }
          }
          // SDK task-level snapshots cover managed tasks, but arbitrary shell,
          // remote agents, custom MCPs and cron may outlive that registry.
          if (!VERIFIED_TOOLS.includes(name)) this.restartOpaqueCalls.add(input.tool_use_id)
          // Trabalho lançado DESTACADO não termina quando a chamada retorna, então
          // aqui a incerteza é permanente na sessão — é o caso que o booleano
          // antigo tratava certo e o único que precisa dele.
          if (startsDetachedWork(name, input.tool_input)) this.restartUncertain = true
          // Qualquer ferramenta (verificável ou não) estende a tolerância de
          // silêncio: build e download legítimos passam minutos sem emitir.
          this.toolsInFlight.add(input.tool_use_id)
          this.markActivity()
          if (planning) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: planning.decision,
              permissionDecisionReason: planning.reason } }
          }
          return {}
        }] }],
        // Uma ferramenta que retornou (com sucesso ou erro) acabou. Sem estes dois,
        // a incerteza nunca é retirada e o reinício fica bloqueado para sempre.
        PostToolUse: [{ hooks: [async (input) => {
          if (input.hook_event_name === 'PostToolUse') {
            this.restartOpaqueCalls.delete(input.tool_use_id)
            this.toolsInFlight.delete(input.tool_use_id)
            this.markActivity()
          }
          return {}
        }] }],
        PostToolUseFailure: [{ hooks: [async (input) => {
          if (input.hook_event_name === 'PostToolUseFailure') {
            this.restartOpaqueCalls.delete(input.tool_use_id)
            this.toolsInFlight.delete(input.tool_use_id)
            this.markActivity()
          }
          return {}
        }] }]
      },
      // Always route through our gate. "Allow all" is handled inside
      // handlePermission via the bypassAll flag so it can be toggled live.
      canUseTool: async (toolName, input, options) => {
        const result = await this.handlePermission(toolName, input, options?.agentID)
        // Negada aqui, a ferramenta não roda e o SDK não dispara PostToolUse nem
        // PostToolUseFailure: o registro feito no PreToolUse ficaria preso (o
        // watchdog tolerando silêncio e o reinício bloqueado para sempre).
        if (result.behavior === 'deny' && options?.toolUseID) {
          this.restartOpaqueCalls.delete(options.toolUseID)
          this.toolsInFlight.delete(options.toolUseID)
        }
        return result
      }
    }
    // Sessão do Agent Manager (Tela de Planejamento): só `planning` + `memory`,
    // o prompt dele + a memória, sem subagentes — ver planning/planningSession.ts.
    if (this.opts.planning) {
      applyPlanningSessionOptions(options, {
        projectCwd: this.opts.cwd,
        slug: this.opts.planning.slug,
        memoryBlocks: [memory ? buildMemoryHint(memoriesDir) : '', memorySnapshot?.catalog ?? '']
      })
    }

    if (this.disposed) return false
    try {
      this.q = query({ prompt: this.input, options })
    } catch (err) {
      this.emit({ kind: 'error', id: nextId(), text: `Agent failed to start: ${String(err)}` })
      return false
    }
    void this.consumeMessages(this.q)
    // Processing rows left by a crashed/restarted session is safe: the queue
    // claims in sequence order and rows are completed only after handing the
    // exact SDK message to the input stream.
    if (this.inputQueueRepository) {
      void this.inputQueueRepository.recoverAgentInput(this.opts.convId)
        .then(() => this.drainPersistedInputs())
        .catch((error) => console.warn('[agent-input-queue] recovery failed:', error))
    }
    return true
  }

  private async drainPersistedInputs(): Promise<void> {
    if (!this.inputQueueRepository || this.disposed) return
    const run = this.inputDrain.then(async () => {
      // The SDK may still be processing the item previously pushed. Keep the
      // durable queue strictly FIFO: only the terminal result for that item
      // may clear currentInputId and schedule the next claim.
      if (this.currentInputId !== null) return
      const item = await this.inputQueueRepository!.claimNextAgentInput(this.opts.convId)
      if (!item || this.disposed) return
      try {
        // Reserve the slot before handing the message to the SDK. A synchronous
        // push/result callback must observe the same item, and no other drain
        // may claim the next row until this one reaches a terminal result.
        this.currentInputId = item.id
        this.input.push(item.message)
      } catch (error) {
        if (this.currentInputId === item.id) this.currentInputId = null
        await this.inputQueueRepository!.requeueAgentInput(item.id, String(error)).catch(() => undefined)
        void this.drainPersistedInputs()
      }
    })
    this.inputDrain = run.catch(() => undefined)
    await run
  }

  private async enqueueInput(message: SDKUserMessage, messageUuid: string): Promise<void> {
    if (!this.inputQueueRepository) {
      this.input.push(message)
      return
    }
    await this.inputQueueRepository.enqueueAgentInput(this.opts.convId, message, messageUuid)
    await this.drainPersistedInputs()
  }

  private async consumeMessages(q: NonNullable<typeof this.q>): Promise<void> {
    try {
      for await (const message of q) {
        if (!this.disposed) this.handleMessage(message)
      }
    } catch (err) {
      if (!this.disposed) this.emit({ kind: 'error', id: nextId(), text: `Agent stopped: ${String(err)}`, usageExhausted: isUsageExhausted(err) || this.quotaRejected })
      // Erro também encerra o turno: o primeiro turno de um handoff acabou.
      this.handoffFirstTurnDone = true
    } finally {
      this.markTurnIdle()
      if (this.q === q) this.q = null
    }
  }

  async send(
    text: string,
    images?: ImageAttachment[],
    messageUuid?: string,
    origin: MessageOrigin = 'pc',
    messageKind: AgentMessageKind = 'normal'
  ): Promise<void> {
    appRestart?.assertOpen()
    // "/compact" only exists as a command in Claude Code's own terminal UI — the
    // Agent SDK's streaming-input mode (what this app uses) never intercepts it;
    // a literal "/compact" message is just sent to the model, which replies that
    // it doesn't recognize the command. Verified against a real session before
    // writing this: no compact_boundary event, no local-command handling exists
    // in the SDK's Query interface. So this short-circuits it locally instead of
    // wasting a turn on a reply nobody wants. Manual compaction isn't available
    // in this integration; autoCompactEnabled (see the Options below) is the only
    // real compaction this app gets, and it's automatic, not on-demand.
    if (messageKind === 'normal' && text.trim() === '/compact') {
      this.emit({
        kind: 'status',
        id: nextId(),
        text: 'Compactação manual não está disponível aqui: o SDK usado por este app não expõe esse comando (ele só existe no terminal do Claude Code). A conversa é compactada automaticamente quando o contexto enche.'
      })
      return
    }
    this.beginTurn()
    await this.handoffReady
    this.quotaRejected = false
    if (this.mirrorFailed) {
      this.emit({
        kind: 'error',
        id: nextId(),
        text: 'A sessão não está pronta para retomada: o espelhamento do transcript falhou. Reconecte após corrigir a persistência.'
      })
      return
    }
    const memoryCatalogUpdate = await this.refreshMemoriesIfChanged()
    const skillCatalogUpdate = await this.refreshSkillsIfChanged()
    const projectsCatalogUpdate = await this.refreshProjectsIfChanged()
    // A real user dispatch starts a fresh loop budget. Dynamic wakeups are
    // injected by the CLI and do not pass through this method. Internal
    // recovery prompts must never start a fresh loop just because the toggle
    // remains enabled.
    const trimmed = text.trimStart()
    const startsWithSlashCommand = trimmed.startsWith('/')
    const shouldAutoLoop =
      messageKind === 'normal' &&
      this.opts.loopEnabled === true &&
      this.opts.economyMode !== true &&
      !startsWithSlashCommand
    const explicitLoop = /^\/loop(?:\s|$)/iu.test(trimmed)
    if (!this.providerContinuation) {
      this.loopActive = this.opts.loopEnabled === true && this.opts.economyMode !== true && (shouldAutoLoop || explicitLoop)
      this.loopCycles = 0
      this.loopLimit = loopLimitFromPrompt(text)
      this.loopScheduledThisIteration = false
    }
    this.providerContinuation = false
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
    let taskText = text
    if (this.canceledPending) {
      this.canceledPending = false
      const note =
        '[Observação do sistema: o usuário CANCELOU manualmente a solicitação anterior e a resposta parcial a ela. ' +
        'Desconsidere por completo aquela solicitação cancelada e a resposta interrompida — trate como se nunca ' +
        'tivessem existido — e atenda apenas à mensagem a seguir.]'
      taskText = text ? `${note}\n\n${text}` : note
    }
    let outText = shouldAutoLoop ? `/loop ${taskText}` : taskText
    if (explicitLoop && taskText !== text) {
      const loopPrefix = text.match(/^\s*\/loop(?:\s+|$)/iu)?.[0] ?? '/loop '
      const loopBody = text.slice(loopPrefix.length)
      outText = `${loopPrefix.trimEnd()} ${taskText.slice(0, taskText.length - text.length)}${loopBody}`
    }
    // Keep only user-owned material in the SDK's persisted user turn. The
    // complete docs outline and bounded relevant-memory excerpts are generated
    // by live request hooks, not copied into history or passed to vision relay.
    const stamp = buildContextStamp(origin)
    this.activeMemoryQuery = outText
    // UMA decisão por mensagem do usuário. Disparada aqui, e não no hook de
    // request, porque o hook roda outra vez a cada volta do loop de ferramentas.
    const selectionTurn = ++this.memorySelectionTurn
    this.activeMemorySelection = selectMemoriesWithTypeSafe(getCacheInfo().memoriesDir, outText)
      .catch(() => null)
      .then(async (selection) => {
        // O gate do memorista precisa saber o que o agente JÁ tinha em mãos
        // neste turno — é aqui, e só aqui, que a escolha e a conversa coexistem.
        // Grava sempre: turno sem seleção é LISTA VAZIA, não a lista do turno
        // anterior. Uma decisão atrasada não escreve por cima de uma mensagem
        // mais nova que já decidiu.
        if (selectionTurn === this.memorySelectionTurn) {
          recordUsedMemories(this.opts.convId, selection?.relPaths ?? [])
          await this.warnMemorySelectorDown(selectionTurn, selection)
        }
        return selection
      })
    const economyReminder = this.opts.economyMode ? ECONOMY_TURN_REMINDER : ''
    const stamped = (body: string): string => composeUserPrompt(body, {
      stamp, memory: memoryCatalogUpdate, skills: skillCatalogUpdate, projects: projectsCatalogUpdate, reminder: economyReminder
    })

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
      this.beginTurn()
      await this.enqueueInput({
        type: 'user',
        message: { role: 'user', content: stamped(merged) },
        parent_tool_use_id: null,
        uuid
      } as SDKUserMessage, uuid)
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
    this.beginTurn()
    await this.enqueueInput(msg, uuid)
  }

  async waitForIdle(): Promise<void> {
    if (this.turnActive) await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
    await this.handoffReady
  }

  async resumeAfterQuota(): Promise<string> {
    await this.waitForIdle()
    if (this.mirrorFailed || !this.watchedSessionId) {
      throw new Error('Não foi possível verificar o histórico para trocar de provedor com segurança. A tarefa foi preservada.')
    }
    // Also verify abnormal iterator termination, which may have no SDK result.
    await this.onTurnDurable?.(this.watchedSessionId, this.mirrorFailed)
    return this.watchedSessionId
  }

  continuationState(): AgentContinuationState {
    return { approvedTools: [...this.approvedTools], loopActive: this.loopActive, loopCycles: this.loopCycles,
      loopLimit: this.loopLimit, loopScheduledThisIteration: this.loopScheduledThisIteration }
  }

  restoreContinuation(state: AgentContinuationState): void {
    this.approvedTools = new Set(state.approvedTools)
    this.loopActive = state.loopActive
    this.loopCycles = state.loopCycles
    this.loopLimit = state.loopLimit
    this.loopScheduledThisIteration = state.loopScheduledThisIteration
    this.providerContinuation = true
  }

  async interrupt(): Promise<AgentInterruptResult> {
    this.windowsControlScope.cancel()
    this.clearLoopState()
    const q = this.q
    if (!q) {
      this.releasePendingPermissions('O usuário parou o turno.')
      return { stillQueued: [] }
    }

    // O pedido sai ANTES do await e ANTES de soltar as permissões, nesta ordem
    // de propósito. Um turno parado num pedido de permissão não está rodando do
    // ponto de vista do CLI — ele está pendurado na promessa do `canUseTool`
    // deste processo, que o `interrupt()` sozinho não resolve. Soltar primeiro
    // daria ao modelo o resultado da ferramenta e ele emendaria a próxima
    // chamada antes de o abort chegar; soltar só depois do await trava, porque
    // o recibo não vem enquanto o CLI espera a permissão.
    const receipt = (async () => q.interrupt())().then(
      (value) => ({ ok: true as const, value: value as { still_queued?: string[] } | undefined }),
      () => ({ ok: false as const, value: undefined }) // fora de turno: não havia o que cancelar
    )
    this.releasePendingPermissions('O usuário parou o turno.')

    let timer: NodeJS.Timeout | undefined
    const ack = await Promise.race([
      receipt,
      new Promise<{ ok: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: 'timeout' }), INTERRUPT_ACK_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)

    // Manual cancel: flag the conversation so the next message tells the model
    // to disregard the canceled request. Vale também quando o recibo não veio a
    // tempo — o pedido de interrupção foi enviado do mesmo jeito; só o `false`
    // (o CLI recusou porque não havia turno) é que não cancela nada.
    if (ack.ok === false) return { stillQueued: [] }
    this.canceledPending = true
    const stillQueued = ack.ok === 'timeout' ? [] : ack.value?.still_queued ?? []
    // Nada sobreviveu: acabou aqui. Quando o Stop pega a mensagem ANTES de o
    // turno começar, o SDK a descarta e não emite `result` nenhum — sem isto,
    // `turnActive` ficava de pé para sempre e com ele o bloqueio de suspensão e
    // o "tem agente ocupado" do relançador. Se o CLI ainda estiver produzindo,
    // o primeiro sinal de vida religa o turno (mesmo autocorretor da tela).
    if (stillQueued.length === 0) this.markTurnIdle()
    return {
      stillQueued: stillQueued.map((messageId: string) => ({
        messageId,
        text: this.submittedMessages.get(messageId)
      }))
    }
  }

  /** Solta toda permissão/pergunta pendente com uma NEGATIVA. Chamado pelo Stop:
   *  enquanto uma dessas promessas estiver de pé, o turno do CLI não termina —
   *  é o caso em que o botão parecia não fazer nada. */
  private releasePendingPermissions(reason: string): void {
    if (this.pendingPermissions.size === 0) return
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer)
      pending.resolve({ behavior: 'deny', message: reason })
      this.pendingPermissions.delete(id)
      this.onPermissionExpire(id) // fecha o modal: a pergunta morreu com o turno
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
      // AskUserQuestion, which still needs a real answer (it isn't a permission),
      // and the Agent Manager's Bash, which the user approves one by one.
      for (const [id, pending] of this.pendingPermissions) {
        if (pending.toolName === 'AskUserQuestion') continue
        if (planningRequiresBashApproval(this.opts, pending.toolName)) continue
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
    const restartState = this.restartActivity()
    if (!restartState.busy && !restartState.unsafe) this.restartRegistration?.remove()
    else this.restartUncertain = true // Closing SDK is not proof detached work ended.
    this.disposed = true
    this.clearLoopState()
    // O registro de memórias usadas é do turno corrente desta conversa: some com
    // ela. O ordinal avança para que uma decisão ainda em voo não repovoe o
    // registro depois do fim — seria vazamento por conversa morta.
    this.memorySelectionTurn++
    this.activeMemorySelection = null
    forgetUsedMemories(this.opts.convId)
    // Antes do resto: um intervalo sobrevivendo à sessão emitiria evento de uma
    // conversa que já não existe.
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = undefined
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
    this.markTurnIdle()
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
    const items = readSessionTasks(sessionId, this.sessionTasksRoot)
    if (items) this.emit({ kind: 'task-list', items })
    this.stopTaskWatch = watchSessionTasks(
      sessionId,
      (list) => this.emit({ kind: 'task-list', items: list }),
      this.sessionTasksRoot
    )
  }

  // ---- internals ----

  private synchronizeManagedSkills(cacheDir: string, cacheSkillsDir: string): boolean {
    const runtime = this.skillRuntime
    if (!runtime) return false
    const sourceVersion = managedSkillsFilesystemVersion(runtime.appRoot)
    const sourceChanged = sourceVersion !== this.managedSkillSourceVersion
    const result = sourceChanged
      ? syncCacheSkills(runtime.appRoot, cacheDir, runtime.userHome)
      : exposeCacheSkills(cacheSkillsDir, runtime.userHome)
    if (result.errors.length === 0) {
      this.managedSkillSourceVersion = sourceVersion
      if (sourceChanged) this.managedSkillReloadPending = true
      return this.managedSkillReloadPending
    }
    console.warn('[skills] managed skill synchronization failed:', result.errors.join('\n'))
    return this.managedSkillReloadPending
  }

  private readSkillCatalogSnapshot(): SkillCatalogSnapshot {
    return createSkillCatalogSnapshot(discoverSkills(this.opts.cwd, this.skillRuntime?.userHome))
  }

  private readMemoryCatalogSnapshot(memoriesDir: string = getCacheInfo().memoriesDir): MemoryCatalogSnapshot {
    return createMemoryCatalogSnapshot(memoriesDir)
  }

  /**
   * Recreate host-owned context at the two documented request boundaries. This
   * is deliberately independent from the persisted SDK user messages: hooks
   * provide the full current docs block to Claude, the Codex proxy and Ollama
   * through the same Agent SDK request path without bloating history.
   */
  private async buildLiveRequestContext(): Promise<string> {
    let docs: string
    try {
      docs = await buildProjectOutline(this.opts.cwd)
    } catch {
      docs = '[PROJECT_DOCS_CONTEXT]\ndocs/ [context unavailable for this request]\n[/PROJECT_DOCS_CONTEXT]'
    }

    let memory = ''
    try {
      // Do not inject the memory index here: this runs for every provider
      // request. The selector is capped and redacts vault references/secrets.
      //
      // A decisão do TypeSafe, quando existe, é soberana: `''` significa "este
      // turno não precisa de memória nenhuma" e nada é injetado. Só a AUSÊNCIA
      // de decisão (`null` — desligado, sem chave, timeout, erro) volta ao
      // caminho lexical de sempre.
      const selected = this.activeMemorySelection ? await this.activeMemorySelection : null
      // `selected?.block` preserva a distinção: `''` (decidiu zero) NÃO aciona o
      // `??`; só a ausência de decisão (`null`) cai no caminho lexical.
      memory = selected?.block ?? buildDynamicMemoryContext(getCacheInfo().memoriesDir, this.activeMemoryQuery, false)
    } catch {
      // Memory recall is optional context; docs and the user request still run.
    }
    return composeRequestContext({ docs, memory })
  }

  /**
   * Avisa que o turno perdeu o seletor de memória e caiu na busca lexical.
   *
   * Sem isto a degradação é INVISÍVEL: a abertura da conversa já suprimiu o
   * catálogo por haver chave, e quando a decisão não vem o turno roda com
   * excertos lexicais sem que nada apareça na tela — só um `console.error` que
   * ninguém lê. O usuário precisa saber que a memória daquele turno foi montada
   * por outro critério.
   *
   * `null` também é o estado normal de quem não configurou o recurso, e ali não
   * há nada a anunciar: por isso o aviso depende de o seletor estar ATIVO.
   * Uma nota por turno, e nenhuma para uma mensagem que já foi superada por
   * outra mais nova (mesma guarda do ordinal que protege `recordUsedMemories`).
   */
  private async warnMemorySelectorDown(selectionTurn: number, selection: MemorySelection | null): Promise<void> {
    if (selection !== null) return
    try {
      if (!(await typeSafeMemorySelectionActive())) return
    } catch {
      return
    }
    if (selectionTurn !== this.memorySelectionTurn || this.disposed) return
    this.emit({
      kind: 'status',
      id: nextId(),
      text: 'Memória: decisão indisponível neste turno — usando busca local nas memórias.'
    })
  }

  private async refreshMemoriesIfChanged(): Promise<string> {
    // Com o seletor no ar, o catálogo inteiro não vai ao prompt: mandar os 227
    // cabeçalhos aqui anularia o objetivo de só o escolhido aparecer. As versões
    // ficam deliberadamente sem atualizar — se o usuário desligar o recurso no
    // meio da conversa, o próximo despacho vê a divergência e entrega o catálogo
    // completo de uma vez.
    if (await typeSafeMemorySelectionActive()) return ''
    const memoriesDir = getCacheInfo().memoriesDir
    const filesystemVersion = memoryCatalogFilesystemVersion(memoriesDir)
    if (filesystemVersion === this.memoryFilesystemVersion) return ''

    const snapshot = this.readMemoryCatalogSnapshot(memoriesDir)
    this.memoryFilesystemVersion = snapshot.filesystemVersion
    if (snapshot.version === this.memoryCatalogVersion) return ''

    this.memoryCatalogVersion = snapshot.version
    return renderMemoryCatalogUpdate(snapshot)
  }

  private async refreshSkillsIfChanged(): Promise<string> {
    const cacheInfo = getCacheInfo()
    const managedChanged = this.synchronizeManagedSkills(cacheInfo.dir, cacheInfo.skillsDir)
    const filesystemVersion = skillCatalogFilesystemVersion(this.opts.cwd, this.skillRuntime?.userHome)
    if (
      !managedChanged &&
      this.skillCatalogVersion !== '' &&
      filesystemVersion === this.skillFilesystemVersion &&
      this.nativeSkillRegistryVersion === this.skillCatalogVersion
    ) return ''

    const snapshot = this.readSkillCatalogSnapshot()
    const confirmed = await this.reloadNativeSkillsIfNeeded(snapshot, managedChanged)
    if (!confirmed) {
      if (this.skillCatalogVersion === '') {
        this.skillCatalogVersion = EMPTY_SKILL_CATALOG.version
        return renderSkillCatalogUpdate(EMPTY_SKILL_CATALOG)
      }
      return ''
    }

    this.skillFilesystemVersion = filesystemVersion
    if (confirmed.version === this.skillCatalogVersion) return ''

    this.skillCatalogVersion = confirmed.version
    return renderSkillCatalogUpdate(confirmed)
  }

  /**
   * The list of every project folder with at least one conversation on this
   * machine (name + absolute path) — so the model knows these are real local
   * projects, not remote/hypothetical ones, and can act on one named by the
   * user without being told the path. Same "only when it changes" rule as
   * memory/skills: recomputed before every dispatch, but only returned (and
   * so only added to history) when the set of projects actually changed.
   *
   * Read failures (storage offline, still booting) degrade to no update —
   * this is a convenience, not something worth blocking the turn over.
   */
  private async refreshProjectsIfChanged(): Promise<string> {
    let projects: ProjectConversationCount[]
    try {
      projects = await storageLifecycle.repository().countConversationsByProject()
    } catch {
      return ''
    }

    const sorted = [...projects].sort((a, b) => a.cwd.localeCompare(b.cwd))
    const version = sorted.map((p) => p.cwd).join('\u001f')
    if (version === this.projectsCatalogVersion) return ''
    this.projectsCatalogVersion = version

    if (sorted.length === 0) return ''
    const lines = sorted.map((p) => `- ${basename(p.cwd)} — ${p.cwd}`).join('\n')
    return `[PROJECTS_ON_THIS_MACHINE]
Every project folder Agent Code has a conversation with, on THIS machine — real local
folders, not remote or hypothetical ones. The user may refer to one by name ("abre o
outro projeto", "olha no <nome>") without giving the path.

${lines}
[/PROJECTS_ON_THIS_MACHINE]`
  }

  /**
   * Reload the CLI's native Skill registry and return the catalog to announce:
   * exactly the discovered skills the SDK confirmed as invocable.
   *
   * A skill the SDK did not load (e.g. one that only exists in `~/.claude/skills`,
   * a root the SDK-driven CLI does not scan) is dropped from the announcement
   * and logged — it must NOT poison the rest. The previous all-or-nothing rule
   * announced "no skills available" whenever a single expected name was missing,
   * which hid every working skill from the model (measured: one stray user
   * skill silenced the whole managed kit, including the economy-mode pair).
   *
   * Returns null only when the reload itself fails or the session has no query.
   */
  private async reloadNativeSkillsIfNeeded(
    snapshot: SkillCatalogSnapshot,
    force: boolean = false
  ): Promise<SkillCatalogSnapshot | null> {
    const q = this.q
    if (!q) return null
    if (!force && snapshot.version === this.nativeSkillRegistryVersion && this.nativeConfirmedSnapshot) {
      return this.nativeConfirmedSnapshot
    }
    try {
      const response = await q.reloadSkills()
      const loaded = new Set(response.skills.map((skill) => skill.name))
      const missing = snapshot.skills.map((skill) => skill.name).filter((name) => !loaded.has(name))
      let confirmed = snapshot
      // Retry on the next dispatch only for skills the CLI is known to scan
      // (project .claude/skills, or the managed cache exposed through the native
      // root) — an omission there is usually a race with a file still being
      // written. A skill that lives only in ~/.claude/skills is never going to
      // load through the SDK, so retrying would just spam reloadSkills().
      let retry = false
      if (missing.length > 0) {
        console.warn(`[skills] native registry omitted expected skills: ${missing.join(', ')}`)
        const cacheSkillsDir = getCacheInfo().skillsDir
        retry = snapshot.skills.some(
          (skill) =>
            !loaded.has(skill.name) &&
            (skill.source === 'project-claude' || existsSync(join(cacheSkillsDir, skill.name, 'SKILL.md')))
        )
        confirmed = createSkillCatalogSnapshot(snapshot.skills.filter((skill) => loaded.has(skill.name)))
      }
      this.nativeSkillRegistryVersion = snapshot.version
      this.nativeConfirmedSnapshot = confirmed
      this.managedSkillReloadPending = retry
      return confirmed
    } catch (error) {
      console.warn('[skills] native reload failed; catalog remains unchanged:', error)
      return null
    }
  }

  private clearLoopState(): void {
    this.loopActive = false
    this.loopScheduledThisIteration = false
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    /** `undefined` quando quem chama é o agente principal; id do subagente quando é um filho. */
    agentId?: string
  ): Promise<PermissionResult> {
    // Agent Manager: allowlist de ferramentas, antes de tudo (inclusive do
    // reinício e do "Permitir tudo"). O hook PreToolUse já nega o mesmo; aqui é
    // a segunda porta, para o caso de a chamada chegar ao gate sem passar nele.
    const planningDenial = planningToolDenial(this.opts, toolName)
    if (planningDenial) return Promise.resolve({ behavior: 'deny', message: planningDenial })
    if (toolName === 'mcp__app__app_restart' && this.restartRegistration && !this.disposed) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (appRestart?.reserved) return Promise.resolve({ behavior: 'deny', message: 'Reinício reservado; finalize o turno.' })
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
      // Planejamento, ANTES do bypassAll: o Agent Manager não roda skill de
      // execução/replanejamento, e o handoff não replaneja no primeiro turno.
      const planningSkillDenial = sessionSkillDenial(this.opts, skill, this.handoffFirstTurnDone)
      if (planningSkillDenial) return Promise.resolve({ behavior: 'deny', message: planningSkillDenial })
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
      // Same reasoning for the two economy-mode skills: the toggle IS the user's
      // grant, and ECONOMY_HINT asks for both at the start of every turn — without
      // this the user would face two permission modals per session. Read-only by
      // nature (they only change how the model writes and which command prefix it
      // uses), and denied outright when the toggle is off, so the model cannot
      // opt into the compressed style behind the user's back.
      if (/^(?:[^:]+:)?(?:caveman|rtk)$/iu.test(skill.trim())) {
        if (this.opts.economyMode !== true) {
          return Promise.resolve({
            behavior: 'deny',
            message: `Skill "${skill}" só é usada com o toggle "Econômico" ligado nesta conversa.`
          })
        }
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
        this.clearLoopState()
        return Promise.resolve({ behavior: 'allow', updatedInput: { stop: true } })
      }
      if (this.loopCycles >= this.loopLimit) {
        this.clearLoopState()
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
    // Checked BEFORE bypassAll: whether MEMORY.md matches the database must not
    // depend on the permission toggle. Reading the folder stays allowed.
    const memoryDenial = memoryWriteDenial(getCacheInfo().memoriesDir, toolName, input)
    if (memoryDenial) return Promise.resolve({ behavior: 'deny', message: memoryDenial })
    // Escopo de escrita da tarefa reivindicada: contrato do time, imposto fora do
    // modelo. Também ANTES do bypassAll — "Permitir tudo" é o usuário confiando
    // no modelo; não anula o que a tarefa declarou que pode ser tocado.
    // No Agent Manager soma-se o escopo do _sandbox do planejamento.
    const scopeDenial = writeScopeDenial(sessionWriteScopes(this.opts, this.activeScopedTasks(agentId ?? null)), toolName, input)
    if (scopeDenial) return Promise.resolve({ behavior: 'deny', message: scopeDenial })
    // A trava do quadro, também ANTES do bypassAll: "Permitir tudo" é o usuário
    // confiando no modelo para executar, não dispensa de dizer o que vai fazer.
    // Desligada no Agent Manager, que planeja e só escreve no _sandbox.
    const planDenial = planGateApplies(this.opts) && planGateDenial(this.planGate, toolName, {
      // Grupo aninhado ausente (config antiga/parcial vinda do banco) cai no
      // padrão em vez de derrubar o gate — que roda em TODA chamada de
      // ferramenta e levaria a conversa junto.
      enabled: loadConfig().board?.requirePlan ?? DEFAULT_CONFIG.board.requirePlan,
      // `Boolean`, não `!== undefined`: as linhas vizinhas normalizam com
      // `agentId ?? null`, ou seja, o SDK pode devolver `null` para a thread
      // principal — e aí `!== undefined` classificaria o agente principal como
      // subagente e desligaria a trava inteira, sem sintoma nenhum.
      isSubagent: Boolean(agentId),
      inTurn: this.turnActive
    })
    if (planDenial) return Promise.resolve({ behavior: 'deny', message: planDenial })
    // O servidor MCP não recebe o agentID; o gate sim, e roda imediatamente
    // antes da ferramenta. É aqui que se sabe a quem o escopo vai pertencer.
    if (toolName === 'mcp__tasks__task_claim') this.claimingAgent = agentId ?? null
    // The memory tools are the sanctioned replacement for the blocked direct
    // writes, and they only touch the user's own memory store — prompting for
    // each one would just train the user to click through. The vault switch in
    // Configurações, not this gate, is what authorizes reading a secret.
    if (toolName.startsWith('mcp__memory__')) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // O registro de tarefas é contabilidade interna do time de agentes: só
    // escreve no banco do próprio app, nunca no projeto. Lease, fence e máquina
    // de estados são impostos pelo repositório, não por um clique do usuário —
    // um modal aqui só ensinaria a clicar sem ler.
    if (toolName.startsWith('mcp__tasks__')) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // As plan_* do Agent Manager só gravam pelo planningStore (validação, rev,
    // caminho preso em docs/spec/<slug>/) — mesmo motivo das de memória e tarefas.
    if (this.opts.planning && toolName.startsWith('mcp__planning__')) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // No Agent Manager, o Bash vai SEMPRE ao usuário: nem "Permitir tudo", nem
    // "sempre permitir", nem lista de leitura o liberam. O que escreve fora do
    // _sandbox já foi negado acima, sem perguntar.
    if (
      !planningRequiresBashApproval(this.opts, toolName) &&
      (this.bypassAll ||
        READ_ONLY.has(toolName) ||
        toolName.startsWith('mcp__browser__') ||
        ANDROID_AUTO.has(toolName) ||
        this.approvedTools.has(toolName))
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
    this.pendingPermissions.set(id, { toolName, input, resolve, timer: this.armExpiry(id) })
  }

  private armExpiry(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.expirePermission(id), PERMISSION_TIMEOUT_MS)
    // Don't let a pending prompt keep the process alive (e.g. on quit).
    timer.unref?.()
    return timer
  }

  /** Pergunta (AskUserQuestion) minimizada espera sem prazo — o usuário só a
   *  deixou para depois; reaberta ou tocada no modal, ganha o prazo inteiro de
   *  novo. Devolve o novo deadline (null: pausada, ou não é uma pergunta pendente). */
  holdQuestion(id: string, paused: boolean): number | null {
    const pending = this.pendingPermissions.get(id)
    if (!pending || pending.toolName !== 'AskUserQuestion') return null
    clearTimeout(pending.timer)
    pending.timer = paused ? undefined : this.armExpiry(id)
    return paused ? null : Date.now() + PERMISSION_TIMEOUT_MS
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
    // Toda mensagem do SDK é sinal de vida — inclusive um delta de streaming,
    // que é o que mantém um turno longo e saudável fora do estado "travado".
    this.markActivity()
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.restartInitializing = false
          if (!this.opts.resume && !this.restartUncertain) this.restartBackground = 0
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
        } else if ((message as { subtype?: string }).subtype === 'mirror_error') {
          this.mirrorFailed = true
          const mirrorError = message as unknown as { error?: string; key?: { sessionId?: string; subpath?: string } }
          console.warn(
            `[session-store] mirror_error conversation=${this.opts.convId} session=${mirrorError.key?.sessionId ?? '?'}` +
              (mirrorError.key?.subpath ? ` subpath=${mirrorError.key.subpath}` : '') +
              `: ${mirrorError.error ?? '(sem detalhe)'}`
          )
          this.emit({
            kind: 'error',
            id: nextId(),
            text: `Falha ao espelhar o transcript no backend autoritativo. Novos envios foram bloqueados.${
              mirrorError.error ? ` Detalhe: ${mirrorError.error}` : ''
            }`
          })
        } else if ((message as { subtype?: string }).subtype === 'compact_boundary') {
          // The CLI already knows how to compact (manual `/compact` or automatic
          // when the context window fills up) — it rewrites its own transcript
          // and keeps going. This app only translates that into a visible line,
          // like the real Claude Code CLI shows "Conversation compacted".
          const meta = (message as unknown as {
            compact_metadata?: { trigger?: 'manual' | 'auto'; pre_tokens?: number; post_tokens?: number }
          }).compact_metadata
          const trigger = meta?.trigger === 'auto' ? 'automática (contexto cheio)' : 'manual'
          const savings =
            typeof meta?.pre_tokens === 'number' && typeof meta?.post_tokens === 'number'
              ? ` — ${meta.pre_tokens.toLocaleString('pt-BR')} → ${meta.post_tokens.toLocaleString('pt-BR')} tokens`
              : ''
          this.emit({
            kind: 'status',
            id: nextId(),
            text: `Conversa compactada (${trigger})${savings}`
          })
        } else if ((message as { subtype?: string }).subtype === 'background_tasks_changed') {
          const tasks = (message as unknown as {
            tasks: Array<{ task_id: string; task_type: string; description: string }>
          }).tasks
          this.restartBackground = Array.isArray(tasks) ? tasks.length : null
          appRestart?.changed()
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
        if (!(message as { parent_tool_use_id?: string | null }).parent_tool_use_id && sdkUsageExhausted(message)) {
          this.quotaRejected = true
          break
        }
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
        const blocks = message.message.content as unknown as AssistantBlock[]
        const track = trackOf(message, parentToolUseId)
        this.recordLlmCall(message, blocks, track)
        this.handleAssistant(blocks, (message as { aborted?: boolean }).aborted === true, track)
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
          modelUsage?: Record<string, {
            inputTokens?: number
            outputTokens?: number
            cacheReadInputTokens?: number
            cacheCreationInputTokens?: number
          }>
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
        // Fim do turno principal (sucesso ou erro): o 1º turno de um handoff acabou.
        this.handoffFirstTurnDone = true
        const usageExhausted = this.quotaRejected || sdkUsageExhausted(message)
        if (this.currentInputId !== null && this.inputQueueRepository) {
          const inputId = this.currentInputId
          this.currentInputId = null
          if (r.is_error || usageExhausted) {
            void this.inputQueueRepository.requeueAgentInput(inputId, r.result ?? 'Agent turn failed')
              .then(() => this.drainPersistedInputs())
              .catch((error) => console.warn('[agent-input-queue] requeue failed:', error))
          } else {
            void this.inputQueueRepository.completeAgentInput(inputId)
              .then(() => this.drainPersistedInputs())
              .catch((error) => console.warn('[agent-input-queue] completion failed:', error))
          }
        }
        if (this.watchedSessionId && this.onTurnDurable) {
          const sessionId = this.watchedSessionId
          this.handoffReady = this.onTurnDurable(sessionId, this.mirrorFailed).catch((error) => {
            this.mirrorFailed = true
            this.emit({
              kind: 'error',
              id: nextId(),
              text: `A verificação da sessão falhou: ${error instanceof Error ? error.message : String(error)}`
            })
          })
        }
        this.restartPersisting = true
        this.markTurnIdle()
        // If an active loop iteration reaches a successful terminal result
        // without requesting another wakeup, its condition is complete. The CLI
        // has nothing pending and the local guard must not authorize a stale call.
        if (this.loopActive && !r.is_error && !usageExhausted && !this.loopScheduledThisIteration) {
          this.loopActive = false
          console.log(`[loop] conversation=${this.opts.convId} completed after ${this.loopCycles} cycle(s)`)
        }
        this.loopScheduledThisIteration = false
        // Belt-and-braces re-read at the end of every turn: if the folder watcher
        // ever misses a write (network drive, antivirus, watcher limits), the card
        // still lands on the truth instead of drifting for the rest of the chat.
        if (this.watchedSessionId) {
          const tasks = readSessionTasks(this.watchedSessionId, this.sessionTasksRoot)
          if (tasks) this.emit({ kind: 'task-list', items: tasks })
        }
        const reconciledUsage = reconcileResultUsage(r.usage, r.modelUsage)
        this.reconcileLiveLlmCalls(r.modelUsage)
        this.emit({
          kind: 'result',
          id: nextId(),
          isError: r.is_error || usageExhausted,
          usageExhausted,
          text: r.result ?? (r.subtype === 'success' ? 'Done.' : r.subtype),
          durationMs: r.duration_ms,
          costUsd: r.total_cost_usd,
          // `|| undefined` so the renderer's `?? fallback` kicks in if we never
          // saw a main-thread assistant usage (0 would otherwise stick).
          contextTokens: this.lastContextTokens || undefined,
          usage: reconciledUsage
        })
        // A lease protects one active turn, not an idle conversation. Release it
        // as soon as the SDK is done so another process cannot be blocked by an
        // abandoned writer; the next send reacquires it in the main process.
        void this.handoffReady.then(async () => {
          await this.onTurnComplete?.()
          this.restartPersisting = false
          appRestart?.changed()
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

  private markTurnIdle(): void {
    if (!this.turnActive && this.idleWaiters.size === 0) return
    this.turnActive = false
    // Nada mais deve rodar: fora do turno, silêncio é o normal.
    this.stopStallWatch()
    this.toolsInFlight.clear()
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
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
        // O plano declarado abre a trava do quadro. Marcado aqui, e não no gate,
        // porque a ferramenta de plano é auto-aprovada e pode nem chegar lá.
        if (!track.parentToolUseId) notePlanTool(this.planGate, block.name ?? '')
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
    // Whatever came in feeds `inputPreview` of the NEXT llm-call on this same
    // node — the user's own message for the root, or a tool result for a
    // node whose last turn was a tool call.
    const nodeId = parentToolUseId ?? this.getTurnId()
    if (typeof content === 'string') {
      if (content) this.llmNodeInputPreview.set(nodeId, content.slice(0, 4000))
      return
    }
    const previewParts: string[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        const raw = (block as unknown as { content?: unknown; tool_use_id?: string; is_error?: boolean })
        const text = stringifyToolResult(raw.content)
        previewParts.push(text)
        this.emit({
          kind: 'tool-result',
          id: nextId(),
          toolUseId: raw.tool_use_id ?? '',
          isError: Boolean(raw.is_error),
          text,
          parentToolUseId
        })
      } else if (block.type === 'text' && block.text) {
        previewParts.push(block.text)
      }
    }
    if (previewParts.length > 0) this.llmNodeInputPreview.set(nodeId, previewParts.join('\n').slice(0, 4000))
  }

  /**
   * One row for the "Tokens" panel's usage tree — a real call to the model,
   * attributed to the node (turn root or subagent) that made it. See
   * docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md.
   */
  private reconcileLiveLlmCalls(modelUsage: Record<string, {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }> | undefined): void {
    if (!modelUsage) return
    for (const [key, call] of this.turnLlmCalls) {
      const totals = modelUsage[call.model]
      if (!totals) continue
      const tokens: TokenUsage = {
        input: totals.inputTokens ?? 0,
        output: totals.outputTokens ?? 0,
        cacheRead: totals.cacheReadInputTokens ?? 0,
        cacheWrite: totals.cacheCreationInputTokens ?? 0
      }
      this.turnLlmCalls.set(key, { ...call, tokens })
      if (call.persistentId) {
        void this.tokenUsageRepository
          ?.updateLlmCall(call.persistentId, {
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead,
            cacheWriteTokens: tokens.cacheWrite
          })
          .catch((error) => {
            console.warn(`[token-usage] falha ao corrigir llm_call id=${call.persistentId}: ${error instanceof Error ? error.message : String(error)}`)
          })
      }
      this.emit({
        kind: 'llm-call',
        node_id: call.nodeId,
        parent_node_id: this.llmNodeParents.get(call.nodeId) ?? null,
        seq: call.seq,
        model: call.model,
        tokens,
        inputPreview: '',
        outputPreview: '',
        createdAt: Date.now()
      })
    }
  }

  private recordLlmCall(message: unknown, blocks: AssistantBlock[], track: TrackInfo): void {
    const m = message as {
      message?: {
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
    }
    const usage = m.message?.usage
    const model = m.message?.model ?? this.opts.model ?? ''
    const nodeId = track.parentToolUseId ?? this.getTurnId()
    const parentNodeId = this.llmNodeParents.get(nodeId) ?? null

    // A `Task`/`Agent` tool-use spawns a new node whose parent is THIS node —
    // registered before the seq/preview bookkeping below so a subagent's
    // future calls can already resolve their parent.
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && SPAWN_TOOLS.has(block.name ?? '')) {
        this.llmNodeParents.set(block.id, nodeId)
      }
    }

    const seq = (this.llmNodeSeq.get(nodeId) ?? 0) + 1
    this.llmNodeSeq.set(nodeId, seq)

    const tokens: TokenUsage = {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0
    }
    const outputPreview = buildOutputPreview(blocks)
    const inputPreview = this.llmNodeInputPreview.get(nodeId) ?? ''
    const createdAt = Date.now()

    this.turnLlmCalls.set(`${nodeId}\u0000${seq}`, { nodeId, seq, model, tokens })
    this.emit({
      kind: 'llm-call',
      node_id: nodeId,
      parent_node_id: parentNodeId,
      seq,
      model,
      tokens,
      inputPreview,
      outputPreview,
      ...(track.subagentType ? { subagentType: track.subagentType } : {}),
      ...(track.taskDescription ? { taskDescription: track.taskDescription } : {}),
      createdAt
    })

    void this.tokenUsageRepository
      ?.insertLlmCall({
        convId: this.opts.convId,
        turnId: this.getTurnId(),
        nodeId,
        parentNodeId,
        subagentType: track.subagentType ?? null,
        taskDescription: track.taskDescription ?? null,
        seq,
        model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        inputPreview,
        outputPreview
      })
      .then((stored) => {
        const key = `${nodeId}\u0000${seq}`
        const current = this.turnLlmCalls.get(key)
        if (current) {
          this.turnLlmCalls.set(key, { ...current, persistentId: stored.id })
          {
            void this.tokenUsageRepository
              ?.updateLlmCall(stored.id, {
                inputTokens: current.tokens.input,
                outputTokens: current.tokens.output,
                cacheReadTokens: current.tokens.cacheRead,
                cacheWriteTokens: current.tokens.cacheWrite
              })
              .catch((error) => console.warn(`[token-usage] falha ao corrigir llm_call id=${stored.id}: ${error instanceof Error ? error.message : String(error)}`))
          }
        }
      })
      .catch((error) => {
        console.warn(
          `[token-usage] falha ao gravar llm_calls conv=${this.opts.convId} node=${nodeId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }
}

function reconcileResultUsage(
  usage:
    | {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    | undefined,
  modelUsage:
    | Record<string, {
        inputTokens?: number
        outputTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
      }>
    | undefined
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!usage && !modelUsage) return undefined

  const reconciled = {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0
  }

  // Claude Code's final result can report zeros while modelUsage contains the
  // authoritative per-model totals. Sum all models because a turn may include
  // both the main model and subagents; never discard already-populated fields.
  if (modelUsage) {
    const final = Object.values(modelUsage).reduce(
      (totals, model) => ({
        input: totals.input + (model.inputTokens ?? 0),
        output: totals.output + (model.outputTokens ?? 0),
        cacheRead: totals.cacheRead + (model.cacheReadInputTokens ?? 0),
        cacheWrite: totals.cacheWrite + (model.cacheCreationInputTokens ?? 0)
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    )
    if (reconciled.input === 0) reconciled.input = final.input
    if (reconciled.output === 0) reconciled.output = final.output
    if (reconciled.cacheRead === 0) reconciled.cacheRead = final.cacheRead
    if (reconciled.cacheWrite === 0) reconciled.cacheWrite = final.cacheWrite
  }

  return reconciled
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
