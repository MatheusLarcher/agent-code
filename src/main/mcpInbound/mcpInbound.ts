/**
 * O MCP de entrada montado: servidor HTTP + ferramentas + registro de tarefas,
 * e os ganchos que o index.ts chama nos pontos que já existem (agentStart,
 * agent:send, o tee de eventos, perguntas, Stop, descarte da sessão).
 *
 * A tarefa anda pelo MESMO caminho de uma mensagem do celular: o main a leva
 * ao renderer, que cria/abre a conversa e despacha pela fila de espera normal.
 * Enquanto o renderer não avisou que está pronto (app abrindo), as entregas
 * esperam aqui — o `send()` do index descartaria sem janela.
 */
import { randomBytes } from 'node:crypto'
import {
  AUTO_MODEL,
  isAutoModel,
  type AutoPromptTurn,
  type ChatEvent,
  type PermissionRequest,
  type PermissionResponse,
  type StartAgentOptions
} from '../../shared/ipc'
import { selectableModelIds } from '../../shared/selectableModels'
import { MCP_NO_AUTO_RETRY, MCP_PLANNING_REFUSED, MCP_SESSION_REPLACED, MCP_TASK_GONE, MCP_TASK_MODEL } from './mcpConstants'
import { McpHttpServer, type McpReadiness } from './mcpHttpServer'
import { applyInboundMcpOptions } from './mcpSessionOptions'
import { McpTaskRegistry, type McpTask } from './mcpTasks'
import { createMcpTools, type McpDelivery } from './mcpTools'

export interface McpInboundDeps {
  version: string
  conversationExists: (convId: string) => Promise<boolean>
  /** A conversa é do Agent Manager? (destino recusado no tools/call) */
  conversationIsPlanning?: (convId: string) => Promise<boolean>
  /** Canais main → renderer. */
  deliverToRenderer: (d: McpDelivery) => void
  dropQueuedInRenderer: (convId: string, taskId: string) => void
  interruptInRenderer: (convId: string) => void
  answerInRenderer: (convId: string, res: PermissionResponse) => void
  /** Os modelos que o seletor da conversa oferece agora (shared/selectableModels).
   *  `now`: leitura síncrona e barata; `fresh`: a que espera a carga do login do
   *  ChatGPT. Quem usa é `models()`, a MESMA lista para o GET e o tools/call. */
  models?: { now: () => string[]; fresh: () => Promise<string[]> }
  log?: (line: string) => void
  /** Teto da espera pela carga do login em `models()` (padrão: MODELS_WAIT_MS). */
  modelsWaitMs?: number
}

/** O que o `GET /agent-code` anuncia além da identificação. */
export const MCP_RECURSOS = ['modelo', 'imagens'] as const

/**
 * Quanto `models()` espera a carga do login do ChatGPT antes de responder com a
 * leitura síncrona. Curto de propósito: a varredura do Forgia dá ~300 ms por
 * porta ao `GET /agent-code`; esperar 1–2 s ali faria o Forgia pular o app.
 * Depois da carga (uma leitura do banco, logo no boot) a resposta é imediata.
 */
export const MODELS_WAIT_MS = 200

/** O estado REAL da sessão viva de uma conversa (o index lê da sessão). */
export interface LiveSessionState {
  model?: string
  /** A sessão subiu com a config MCP do chamador (servidores, "Permitir tudo"). */
  mcp: boolean
}

/** `agent:send` normal (usuário, fila, tarefa) ou retomada automática de erro transitório. */
export type SendKind = 'normal' | 'recovery'

/**
 * Um envio como o main o vê: o texto, o id da tarefa MCP do item (a tela sabe
 * de qual tarefa é cada item da fila; ausente = mensagem do usuário, mesmo com
 * texto igual ao de uma tarefa) e o tipo. O texto nunca identifica tarefa.
 */
export interface McpSend {
  text: string
  taskId?: string
  kind?: SendKind
  /** O `messageUuid` do envio (o eco do CLI nos `turnIds`): diz de qual turno é cada terminal. */
  messageUuid?: string
}

/** Quantas falas (e quantos caracteres de cada) o `autoPrompt` da troca leva —
 *  o mesmo recorte do `autoPromptFor` da tela. */
const HISTORY_TURNS = 6
const HISTORY_CHARS = 1000

/** O que um envio exige da sessão: modelo e, para tarefa MCP, a config MCP. */
interface SessionNeed {
  task?: McpTask
  model: string
  mcp: boolean
}

export class McpInbound {
  readonly registry = new McpTaskRegistry()
  private readonly server: McpHttpServer
  private claudeReady: boolean | null = null
  private rendererReady = false
  private readonly waiting: McpDelivery[] = []
  /** As opções da tela no último `agentStart` de cada conversa (sem o que o MCP
   *  põe): é com elas que a sessão é refeita, e o modelo delas é o da conversa. */
  private readonly base = new Map<string, StartAgentOptions>()
  /** Sessão que o `restartForSend` pediu: sobe para ESTA tarefa (ou, `null`, para
   *  a mensagem do usuário), não para a cabeça da fila. Consumido no `sessionOptions`. */
  private readonly forced = new Map<string, McpTask | null>()
  /** Último `sessionId` do SDK por conversa (evento `system`): o resume da troca de modelo. */
  private readonly sdkSessions = new Map<string, string>()
  /** A cauda da conversa para o Automático da troca: a que a tela mandou no último
   *  `autoPrompt`, mais o que passou por aqui depois (envios e respostas). */
  private readonly history = new Map<string, AutoPromptTurn[]>()

  constructor(private readonly deps: McpInboundDeps) {
    const tools = createMcpTools({
      registry: this.registry,
      conversationExists: deps.conversationExists,
      ...(deps.conversationIsPlanning ? { conversationIsPlanning: deps.conversationIsPlanning } : {}),
      deliver: (d) => this.deliver(d),
      interrupt: deps.interruptInRenderer,
      dropQueued: deps.dropQueuedInRenderer,
      answer: deps.answerInRenderer,
      newConversationId: () => `c-${randomBytes(6).toString('hex')}`,
      // A mesma lista que o GET publica: o que o GET anuncia é o que o tools/call aceita.
      availableModels: () => this.models()
    })
    this.server = new McpHttpServer({
      version: deps.version,
      readiness: () => this.readiness(),
      info: () => this.info(),
      tools,
      log: deps.log
    })
  }

  /** Recursos, modelos aceitos agora e o padrão — nada de segredo. */
  async info(): Promise<Record<string, unknown>> {
    return {
      recursos: [...MCP_RECURSOS],
      modelos: await this.models(),
      modelo_padrao: MCP_TASK_MODEL
    }
  }

  /**
   * Os modelos aceitos agora — a fonte ÚNICA do `GET /agent-code` e da validação
   * do `modelo` no tools/call, para os dois nunca discordarem. Espera a carga do
   * login do ChatGPT por no máximo `MODELS_WAIT_MS`; passou disso (boot), vale a
   * leitura síncrona para os dois — os GPT entram assim que a carga termina.
   */
  async models(): Promise<string[]> {
    const m = this.deps.models
    if (!m) return selectableModelIds({ ollama: false, codex: false })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.modelsWaitMs ?? MODELS_WAIT_MS)
    })
    try {
      const fresh = await Promise.race([m.fresh().catch(() => null), late])
      return fresh ?? m.now()
    } finally {
      clearTimeout(timer)
    }
  }

  get port(): number {
    return this.server.port
  }

  async start(): Promise<number> {
    const port = await this.server.start()
    this.deps.log?.(`[mcp-inbound] ouvindo em http://127.0.0.1:${port}`)
    return port
  }

  stop(): Promise<void> {
    return this.server.stop()
  }

  /** Última leitura do login (o `GET /agent-code` tem de responder em ~300 ms:
   *  nunca espera o CLI). Desconhecido conta como sem login. */
  setClaudeReady(ready: boolean): void {
    this.claudeReady = ready
  }

  /** A última leitura do login; `null` enquanto a primeira não voltou. */
  get claudeReadyNow(): boolean | null {
    return this.claudeReady
  }

  readiness(): McpReadiness {
    return this.claudeReady ? { pronto: true, motivo: null } : { pronto: false, motivo: 'login' }
  }

  /** O renderer montou o ouvinte e carregou as conversas: entrega o que esperava. */
  markRendererReady(): void {
    this.rendererReady = true
    for (const d of this.waiting.splice(0)) this.deps.deliverToRenderer(d)
  }

  /** Recarregou (F5) ou fechou: até avisar de novo, as entregas esperam. */
  markRendererGone(): void {
    this.rendererReady = false
  }

  private deliver(d: McpDelivery): void {
    if (this.rendererReady) this.deps.deliverToRenderer(d)
    else this.waiting.push(d)
  }

  // ---- ganchos do index.ts ----
  /**
   * A sessão da conversa MCP sobe no modelo da tarefa que ela vai rodar (a que o
   * `agent:send` pediu pelo id, pela troca do `restartForSend`); sem tarefa (o
   * usuário escrevendo nela, a tela reconectando), no modelo da própria
   * conversa — o `modelo` de uma tarefa vale só para ela, e uma sessão nova
   * nunca continua o turno de uma tarefa (ver `onSessionInstalled`).
   */
  sessionOptions(opts: StartAgentOptions): StartAgentOptions {
    const { convId } = opts
    const { inboundMcp: _fromRenderer, ...screen } = opts
    const config = this.registry.configFor(convId)
    const task = this.forced.get(convId) ?? undefined
    this.forced.delete(convId)
    // A cauda que a tela mandou é a verdade da conversa até aqui.
    if (opts.autoPrompt?.history) this.history.set(convId, trimHistory(opts.autoPrompt.history))
    // Conversa do Agent Manager: o modelo dela é o do planejamento (sobrescreve
    // o da tarefa). O tools/call já recusa esse destino; se uma tarefa chegar
    // mesmo assim, erro claro — nunca roda no modelo do planejamento nem entra
    // em laço de troca de sessão. Mensagem do usuário no Manager sobe como
    // conversa comum: sem os servidores nem o "Permitir tudo" do chamador.
    if (config && opts.planning) {
      if (!task) {
        this.base.set(convId, screen)
        return applyInboundMcpOptions(opts, undefined)
      }
      this.registry.fail(task.id, MCP_PLANNING_REFUSED)
      throw new Error(MCP_PLANNING_REFUSED)
    }
    this.base.set(convId, screen)
    return applyInboundMcpOptions(opts, config, task ? (task.model ?? MCP_TASK_MODEL) : null)
  }

  /** A tarefa viva deste envio: a do id do item (da fila, ou a aberta que ele
   *  reenvia). A retomada automática (`recovery`) nunca é de tarefa. */
  private taskOf(convId: string, send: McpSend): McpTask | undefined {
    return this.registry.taskFor(convId, send.taskId)
  }

  /**
   * O envio tem de ser RECUSADO? Devolve o motivo (erro claro para o
   * `agent:send`/"agora"), ou `null`.
   * - Regra 1: leva o id de uma tarefa que não está viva nesta conversa
   *   (terminou, foi cancelada, deu erro, é de outra conversa, ou o app
   *   reiniciou e o registro — só em memória — não a conhece). Nunca é rebaixado
   *   a mensagem do usuário: rodaria no modelo da conversa, com os servidores do
   *   chamador e sem pin. Vale mesmo sem config MCP (ela também some ao reiniciar).
   * - Regra 2 (defesa): retomada automática (`recovery`) depois de um turno de
   *   tarefa. O app não repete turno de tarefa MCP; quem repete é o chamador.
   */
  refusal(convId: string, send: McpSend): string | null {
    if (send.taskId) return this.registry.taskFor(convId, send.taskId) ? null : MCP_TASK_GONE
    if (send.kind === 'recovery' && this.registry.lastTurnWasTask(convId)) return MCP_NO_AUTO_RETRY
    return null
  }

  /** O que este envio exige da sessão; `null`: nada (conversa comum etc.). */
  private need(convId: string, send: McpSend): SessionNeed | null {
    if (!this.registry.configFor(convId)) return null
    // A tarefa do id (começando, ou o reenvio da aberta): no modelo dela. Envio
    // sem id é do usuário e nunca herda tarefa (o registro encerra a aberta).
    const task = this.taskOf(convId, send)
    if (task) return { task, model: task.model ?? MCP_TASK_MODEL, mcp: true }
    // Mensagem do usuário depois de uma tarefa: volta ao modelo da conversa.
    // Automático e Agent Manager escolhem o modelo a cada subida — nada a exigir.
    const base = this.base.get(convId)
    if (!base?.model || isAutoModel(base.model) || base.planning) return null
    return { model: base.model, mcp: false }
  }

  /**
   * A sessão viva serve para o `agent:send` deste texto? Compara o que o envio
   * exige (modelo da tarefa + config MCP, ou o modelo da conversa) com o estado
   * REAL da sessão — inclusive a aberta antes de a conversa ter config MCP.
   * Devolve as opções para refazer a sessão (as da tela, retomando a conversa do
   * SDK); `null`: nada a fazer.
   */
  restartForSend(convId: string, send: McpSend, live: LiveSessionState | null): StartAgentOptions | null {
    // Envio recusado (regras 1 e 2) não sobe sessão nenhuma: o index recusa antes.
    if (this.refusal(convId, send)) return null
    const need = live ? this.need(convId, send) : null
    const base = this.base.get(convId)
    if (!live || !need || !base) return null
    if (need.model === live.model && (!need.mcp || live.mcp)) return null
    this.forced.set(convId, need.task ?? null)
    const resume = this.sdkSessions.get(convId) ?? base.resume
    // O Automático (modelo ou esforço) decide pela mensagem que está saindo, com
    // a cauda real da conversa como contexto (a do último `autoPrompt` da tela
    // mais os envios e respostas que passaram por aqui depois).
    const autoPrompt = { message: send.text, history: [...(this.history.get(convId) ?? [])] }
    return { ...base, ...(resume ? { resume } : {}), autoPrompt }
  }

  /** A sessão subiu? Descarta o pedido do `restartForSend` que não foi consumido. */
  clearRestart(convId: string): void {
    this.forced.delete(convId)
  }

  /** O envio é de uma tarefa MCP? Todo envio que leva id é — viva ou não (a
   *  que não está viva é recusada pela regra 1, nunca tratada como do usuário). */
  isTaskSend(_convId: string, send: McpSend): boolean {
    return !!send.taskId
  }

  /** O turno deste envio é de uma tarefa que pediu o modelo: fixa o modelo do
   *  turno (a troca por cota troca de conta, não de modelo). */
  pinForSend(convId: string, send: McpSend): boolean {
    return !!this.need(convId, send)?.task?.model
  }

  /** Uma sessão nova assumiu a conversa (agent:start ou a troca do agent:send):
   *  o turno de tarefa que estava aberto na anterior se perdeu e termina em erro
   *  — nunca fica `rodando` para sempre nem é retomado sozinho. */
  onSessionInstalled(convId: string): void {
    this.registry.onSessionReplaced(convId, MCP_SESSION_REPLACED)
  }

  /**
   * Botão "agora": a tarefa MCP do item clicado (pelo id) pode entrar no turno
   * em andamento? Só se a sessão viva já está no modelo DELA e com a config MCP
   * — senão ela fica na fila e sai no fim do turno, com a sessão refeita. Item
   * sem id é mensagem do usuário: o "agora" de sempre. Devolve o motivo da
   * recusa, ou `null`.
   */
  injectBlocked(convId: string, taskId: string | undefined, live: LiveSessionState | null): string | null {
    if (!this.registry.configFor(convId)) return null
    const task = this.registry.queuedTask(convId, taskId)
    if (!task) return null
    const model = task.model ?? MCP_TASK_MODEL
    if (live && live.model === model && live.mcp) return null
    return `A tarefa pede o modelo ${model}: ela continua na fila e sai quando o turno terminar, com a sessão trocada.`
  }

  onAgentSend(convId: string, send: McpSend): void {
    this.registry.noteSend(convId, send.taskId, send.kind ?? 'normal', send.messageUuid)
    if (send.kind !== 'recovery') this.remember(convId, 'user', send.text)
  }

  /** Entrou pelo "agora"; `true` se a tarefa pediu o modelo (fixa o modelo do turno). */
  onInjected(convId: string, taskId: string | undefined): boolean {
    return !!this.registry.noteInjected(convId, taskId)?.model
  }

  /** A tarefa que este envio ia começar (ou continuar) não pôde (troca de modelo falhou). */
  failStart(convId: string, send: McpSend, erro: string): void {
    const task = this.taskOf(convId, send)
    if (task) this.registry.fail(task.id, erro)
  }

  private remember(convId: string, who: AutoPromptTurn['who'], text: string | undefined): void {
    if (!text) return
    this.history.set(convId, trimHistory([...(this.history.get(convId) ?? []), { who, text }]))
  }

  onEvent(convId: string, event: ChatEvent): void {
    if (event.kind === 'system' && event.sessionId) this.sdkSessions.set(convId, event.sessionId)
    if (event.kind === 'result' && !event.isError) this.remember(convId, 'agent', event.text)
    // Troca por cota: a tela passa a mostrar o modelo novo como o da conversa;
    // aqui também, para a mensagem seguinte não ser "devolvida" ao antigo.
    if (event.kind === 'provider-switch' && event.fromModel !== AUTO_MODEL) {
      const base = this.base.get(convId)
      if (base) this.base.set(convId, { ...base, model: event.model })
    }
    this.registry.observe(convId, event)
  }

  onPermissionRequest(convId: string, req: PermissionRequest): void {
    this.registry.onQuestion(convId, req)
  }

  onPermissionClosed(convId: string, requestId: string): void {
    this.registry.onQuestionClosed(convId, requestId)
  }

  onInterrupt(convId: string): void {
    this.registry.onInterrupt(convId)
  }

  onDispose(convId: string): void {
    this.base.delete(convId)
    this.forced.delete(convId)
    this.sdkSessions.delete(convId)
    this.history.delete(convId)
    this.registry.onDispose(convId)
  }

  /** O renderer não entregou a tarefa (`erro`) ou a tirou da fila (`cancelada`). */
  onRendererReport(taskId: string, erro: string, cancelada: boolean): void {
    if (cancelada) this.registry.dropped(taskId, erro)
    else this.registry.fail(taskId, erro)
  }
}

/** As últimas falas, cada uma cortada — o recorte do `autoPromptFor` da tela. */
function trimHistory(turns: readonly AutoPromptTurn[]): AutoPromptTurn[] {
  return turns.slice(-HISTORY_TURNS).map((t) => ({ who: t.who, text: t.text.slice(0, HISTORY_CHARS) }))
}
