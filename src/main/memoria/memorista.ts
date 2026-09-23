import { prepareGptRuntime } from '../agentSession'
import {
  askObserver,
  runObserverAttempt,
  type ObserverAttempt,
  type SafeProviderReason
} from '../observerQuery'
import { isAutoModel, MEMORISTA_AUTO_MODELS } from '../../shared/ipc'
import type {
  AutoPrompt,
  ChatEvent,
  MemoristaConfig,
  MemoristaProviderDiagnostic
} from '../../shared/ipc'
import type { MemoryProposeInput } from '../memory/memoryModel'
import type { MemoryService } from '../memory/memoryService'
import { sanitizeProposal, type SecretSink } from '../memory/memorySecrets'
import { buildDocsIndex, buildProjectOutline } from '../projectOutline'
import {
  chooseAutoExecution,
  memoryGateActive,
  shouldSaveMemory,
  type MemoryGateInput
} from '../typesafe'
import {
  appendFact,
  buildMemoristaPrompt,
  buildMemoryBody,
  MEMORISTA_COOLDOWN_MS,
  MEMORISTA_MAX_CALLS,
  MEMORISTA_MAX_USER_CHARS,
  parseMemoristaVerdict,
  summarizeCall,
  type MemoristaCall,
  type MemoristaMemory,
  type MemoristaOp
} from './memoristaPrompt'

export const MEMORISTA_LUNA_MODEL = 'gpt-6-luna'

/** Como o memorista se identifica no acervo — é o que permite, depois, saber
 *  qual memória veio do observador e qual veio do usuário pedindo. */
export const MEMORISTA_AGENT = 'memorista'

/**
 * O memorista: o terceiro observador independente do app, no molde do vigia e
 * do PO. Ele lê o fim de cada turno e grava o que vale lembrar amanhã.
 *
 * Três invariantes, as mesmas dos irmãos:
 *
 * 1. **Não fala com o agente principal.** O que ele escreve vai para o acervo de
 *    memórias; nunca vira `ChatEvent`, nunca entra no histórico do turno.
 * 2. **Não interrompe nada.** Nenhum caminho daqui derruba o turno observado:
 *    modelo fora do ar, acervo indisponível ou proposta recusada degradam em
 *    silêncio.
 * 3. **Escreve pouco e pelo caminho de todo mundo.** Teto de operações por
 *    análise, cooldown por conversa, e a escrita passa SEMPRE pelo serviço de
 *    memória (o mesmo caminho do `memory_propose`): `Write`/`Edit` na pasta de
 *    memórias pulariam a fila de propostas, o CAS e a varredura de segredos.
 *
 * A quarta, mais nova: **o modelo caro só roda quando vale.** Antes de montar o
 * digest, um gate `noul` do TypeSafe (~100ms) responde "isso merece virar
 * memória?" — uma vez na mensagem do usuário e outra na resposta final. "Não"
 * encerra a análise sem consultar o LLM. "Sem decisão" (desligado, sem chave,
 * timeout, erro) NÃO encerra nada: cai no comportamento de sempre, em que o
 * próprio memorista decide. Falha do gate nunca pode virar "parou de salvar".
 */

/** Pedido imutável, criado uma vez e usado pelas duas tentativas de provedor. */
export interface MemoristaObserverRequest {
  prompt: string
  model: string
  conversationId: string
  cwd: string
  correlationId: string
}

/**
 * A fatia do serviço de memória que o memorista usa.
 *
 * É um `Pick` do serviço real, e não uma interface solta, de propósito: assim o
 * compilador garante que o observador escreve pela MESMA porta que o
 * `memory_propose` do chat — se a assinatura do serviço mudar, isto quebra aqui
 * em vez de silenciosamente divergir.
 */
export type MemoristaMemoryPort = Pick<MemoryService, 'listEntries' | 'propose' | 'applyPending'>

export interface MemoristaDeps {
  /** Lido uma vez por análise: mudar a configuração no meio não troca a rota. */
  config(): MemoristaConfig
  /** `null` quando o armazenamento está offline — aí não há onde escrever. */
  memory(): MemoristaMemoryPort | null
  /** O cofre para os segredos que a varredura encontrar. `null` = indisponível
   *  neste dispositivo; o texto continua sendo limpo, o valor é que não sobrevive. */
  vault?(): SecretSink | null
  /** Injetável para o teste; padrão é o `sanitizeProposal` de memorySecrets. */
  sanitize?: typeof sanitizeProposal
  /** Compatibilidade e testes: uma chamada simples ao modelo. */
  ask?(prompt: string, model: string): Promise<string>
  runClaude?(request: MemoristaObserverRequest): Promise<ObserverAttempt>
  runLuna?(request: MemoristaObserverRequest, onStarted: () => void): Promise<ObserverAttempt>
  diagnose?(diagnostic: MemoristaProviderDiagnostic): void
  now?(): number
  newCorrelationId?(): string
  /**
   * O gate do TypeSafe. `true` = vale gastar o modelo, `false` = não gaste,
   * `null` = NÃO houve decisão e o memorista segue como sempre seguiu.
   *
   * Sem injeção (produção), é o `shouldSaveMemory` da pasta typesafe.
   */
  gate?(input: MemoryGateInput): Promise<boolean | null>
  /** O gate está de pé nesta máquina? Sem ele, nem o índice do docs/ é lido —
   *  varrer a pasta para ninguém perguntar nada é I/O jogado fora. */
  gateActive?(): Promise<boolean>
  /** O ÍNDICE do docs/ — caminhos e títulos — para o gate. Nunca o conteúdo:
   *  o `state` do Jev aceita 32k tokens e o docs/ deste projeto passa de 85k. */
  docsIndex?(cwd: string): Promise<string>
  /** O docs/ COMPLETO, para o memorista aprovado: ali é um Claude de 200k. */
  docs?(cwd: string): Promise<string>
  /** As memórias que entraram no prompt do agente nesta conversa (ver
   *  `memoriasUsadas.ts`). Vazio quando ninguém registrou. */
  usedMemories?(convId: string): readonly string[]
  /**
   * O modelo do turno quando a configuração do memorista está em Automático.
   * Mesma decisão que escolhe o modelo da conversa, pelo mesmo caminho — aqui
   * só o modelo importa: o esforço de raciocínio do memorista não é
   * configurável, ele faz uma leitura curta e sem ferramentas.
   *
   * Sem injeção (produção), é o `chooseAutoExecution` da pasta typesafe.
   */
  autoModel?(prompt: AutoPrompt): Promise<string>
}

/** A fila dos turnos que ainda não passaram pelo memorista. */
interface MemoristaDeferred {
  texts: string[]
  calls: MemoristaCall[]
}

interface ConvState {
  userText: string | null
  cwd: string
  calls: MemoristaCall[]
  /** O último bloco de texto que o agente fechou neste turno. Reserva para
   *  quando o `result` chega sem texto. */
  answerText: string
  fired: boolean
  lastRunAt: number
  /** Os turnos que ainda não foram lidos — pulados pelo cooldown ou com a
   *  análise falha. Eles não somem: entram no digest da próxima análise desta
   *  conversa, porque um turno que nunca foi lido é exatamente o conhecimento
   *  que este recurso existe para não perder. */
  deferred: MemoristaDeferred | null
  /** O gate disparado na MENSAGEM DO USUÁRIO, ainda em voo. Nunca rejeita. */
  gate: Promise<boolean | null> | null
}

/** Evidência capturada junto com o `result`, antes de qualquer await. */
interface MemoristaTurnSnapshot {
  userText: string
  cwd: string
  calls: readonly MemoristaCall[]
  /** A resposta final do agente neste turno. */
  answerText: string
  /** O gate disparado na mensagem que abriu ESTE turno. Congelado junto com o
   *  resto: a próxima mensagem do usuário troca o da conversa, e a análise em
   *  voo estaria esperando o veredito de outro turno. */
  gate: Promise<boolean | null> | null
}

/** Vários turnos num digest só, numerados: sem a numeração o modelo lê a emenda
 *  como uma fala única e junta dois assuntos numa memória só. */
function joinTexts(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? ''
  return texts.map((text, index) => `(${index + 1}) ${text}`).join(' ')
}

export class Memorista {
  private readonly state = new Map<string, ConvState>()
  /** O trabalho de fundo em voo por conversa — análises e os gates disparados
   *  na mensagem do usuário. É o que `settled` espera. */
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>()
  private correlations = 0

  constructor(private readonly deps: MemoristaDeps) {}

  /** Um turno começou. O cooldown e a fila são da CONVERSA e sobrevivem ao
   *  turno novo; o texto e as ações são do turno. */
  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.answerText = ''
    conv.fired = false
    // Zerado ANTES de qualquer saída: o gate é do turno, e deixar aqui o da
    // mensagem anterior faria a análise deste turno esperar o veredito de outro.
    conv.gate = null
    // Dentro do cooldown, o fim do turno vai cair em `defer()` e o veredito seria
    // jogado fora. A chamada ao TypeSafe é paga; não se faz uma pergunta cuja
    // resposta já se sabe que ninguém vai ler. O turno não fica sem julgamento:
    // ele volta no digest da próxima análise, que roda o gate com o texto
    // acumulado e a resposta do agente em mãos.
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt < MEMORISTA_COOLDOWN_MS) return
    // O primeiro dos dois gates do turno, com o que existe AGORA: a mensagem do
    // usuário ainda sem resposta. Ele NÃO pode ser disparado e esquecido: a
    // análise do fim do turno só aguarda `turn.gate` quando chega até lá, e o
    // caminho do cooldown retorna antes disso. Registrado como trabalho em voo,
    // `settled` passa a esperar por ele — hoje é o que o app usa para saber que
    // o memorista acabou — e `dispose` não deixa a promise pendurada.
    const gate = this.askGate(convId, cwd, text, '')
    conv.gate = gate
    this.track(convId, gate)
  }

  /** Alimentado pelo tee de eventos do main. Nunca lança. */
  observe(convId: string, event: ChatEvent): void {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    if (event.kind === 'tool-use') {
      conv.calls.push({ tool: event.name, detail: summarizeCall(event.name, event.input) })
      if (conv.calls.length > MEMORISTA_MAX_CALLS) conv.calls.shift()
      return
    }
    // A resposta do agente é metade do que o gate julga — é nela que aparece o
    // fato de infraestrutura que o turno descobriu. Vale o ÚLTIMO bloco fechado;
    // o `result` costuma trazer o mesmo texto e tem preferência quando traz.
    if (event.kind === 'assistant-text') {
      if (event.final && event.text) conv.answerText = event.text
      return
    }
    if (event.kind === 'result') {
      // A próxima mensagem do usuário reinicia o acumulador desta conversa
      // enquanto a análise ainda espera o modelo. Congela a evidência agora.
      const turn: MemoristaTurnSnapshot = Object.freeze({
        userText: conv.userText,
        cwd: conv.cwd,
        calls: Object.freeze([...conv.calls]),
        answerText: event.text || conv.answerText,
        gate: conv.gate
      })
      conv.fired = true
      this.start(convId, turn)
      return
    }
    // Turno que morreu não ensinou nada — é falha, não conhecimento. Fecha sem
    // analisar (e sem enfileirar: não há o que guardar de um turno que não foi).
    if (event.kind === 'error') conv.userText = null
  }

  /**
   * Resolve quando as análises em voo desta conversa terminarem, escritas
   * incluídas. Nunca rejeita: esperar por um observador não pode ser um jeito
   * novo de derrubar quem esperou.
   */
  async settled(convId: string): Promise<void> {
    const inFlight = this.inFlight.get(convId)
    if (!inFlight || inFlight.size === 0) return
    await Promise.all([...inFlight].map((work) => work.catch(() => undefined)))
  }

  dispose(convId: string): void {
    this.state.delete(convId)
    this.inFlight.delete(convId)
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = {
        userText: null,
        cwd: '',
        calls: [],
        answerText: '',
        fired: false,
        lastRunAt: 0,
        deferred: null,
        gate: null
      }
      this.state.set(convId, conv)
    }
    return conv
  }

  /** Dispara uma análise e a registra como em voo até o fim das escritas. */
  private start(convId: string, turn: MemoristaTurnSnapshot): void {
    this.track(convId, this.run(convId, turn))
  }

  /** Registra um trabalho de fundo da conversa: é o conjunto que `settled`
   *  espera e que `dispose` descarta. */
  private track(convId: string, work: Promise<unknown>): void {
    const inFlight = this.inFlight.get(convId) ?? new Set<Promise<unknown>>()
    this.inFlight.set(convId, inFlight)
    inFlight.add(work)
    const forget = (): void => {
      inFlight.delete(work)
      if (inFlight.size === 0 && this.inFlight.get(convId) === inFlight) this.inFlight.delete(convId)
    }
    // `then(forget, forget)` e não `finally`: aqui é onde a rejeição do
    // observador morre, para ela não virar unhandled rejection no processo.
    void work.then(forget, forget)
  }

  /** Guarda o turno que o cooldown pulou, com os mesmos tetos do digest — o
   *  acumulado não pode crescer com o número de turnos pulados. */
  private defer(conv: ConvState, turn: MemoristaTurnSnapshot): void {
    const deferred = conv.deferred ?? { texts: [], calls: [] }
    deferred.texts.push(turn.userText)
    deferred.calls.push(...turn.calls)
    while (deferred.texts.length > 1 && deferred.texts.join(' ').length > MEMORISTA_MAX_USER_CHARS) deferred.texts.shift()
    if (deferred.calls.length > MEMORISTA_MAX_CALLS) deferred.calls.splice(0, deferred.calls.length - MEMORISTA_MAX_CALLS)
    conv.deferred = deferred
  }

  /**
   * Junta os turnos pulados ao turno de agora, DENTRO do orçamento do digest.
   *
   * O corte é do mais ANTIGO para o mais novo: o `clamp` do digest corta pela
   * cauda, então entregar tudo concatenado faria o acumulado cheio empurrar
   * para fora justamente o que o usuário acabou de dizer. O turno de AGORA
   * entra sempre, mesmo quando sozinho já estoura o teto.
   */
  private mergeDeferred(deferred: MemoristaDeferred | null, turn: MemoristaTurnSnapshot): MemoristaTurnSnapshot {
    if (!deferred || (deferred.texts.length === 0 && deferred.calls.length === 0)) return turn
    const kept = [...deferred.texts, turn.userText].filter((text) => text.trim().length > 0)
    while (kept.length > 1 && joinTexts(kept).length > MEMORISTA_MAX_USER_CHARS) kept.shift()
    return Object.freeze({
      ...turn,
      userText: joinTexts(kept) || turn.userText,
      calls: Object.freeze([...deferred.calls, ...turn.calls].slice(-MEMORISTA_MAX_CALLS))
    })
  }

  /**
   * Devolve à fila tudo que esta análise pegou e não chegou a ler: o acumulado
   * que ela tirou da fila (`taken`) e o próprio turno que a disparou.
   *
   * O turno de agora volta junto porque, diferente do PO, o memorista não tem
   * uma rodada de abertura atrás dele: esta é a ÚNICA leitura daquele turno. Se
   * ela falha (modelo fora do ar, acervo offline ou lançando), o que o usuário
   * ensinou ali some para sempre — exatamente o buraco que a fila tapa. Tirar
   * da fila é empréstimo até a análise terminar, não baixa.
   */
  private restoreDeferred(conv: ConvState, taken: MemoristaDeferred | null, turn: MemoristaTurnSnapshot): void {
    const queue = conv.deferred ?? { texts: [], calls: [] }
    // O que volta é mais ANTIGO do que o que entrou na fila enquanto a análise
    // rodava, então volta na frente — e os mesmos tetos continuam valendo.
    queue.texts.unshift(...(taken?.texts ?? []), turn.userText)
    queue.calls.unshift(...(taken?.calls ?? []), ...turn.calls)
    while (queue.texts.length > 1 && queue.texts.join(' ').length > MEMORISTA_MAX_USER_CHARS) queue.texts.shift()
    if (queue.calls.length > MEMORISTA_MAX_CALLS) queue.calls.splice(0, queue.calls.length - MEMORISTA_MAX_CALLS)
    conv.deferred = queue
  }

  /**
   * Os dois vereditos do turno viram um.
   *
   * "Sim" de qualquer um dos dois basta: o usuário pode ensinar na pergunta e a
   * resposta pode revelar o fato, e perder qualquer um dos dois é perder
   * memória. Só quando NENHUM dos dois decidiu (`null` nos dois) o resultado é
   * "sem decisão" — e aí o memorista roda, como sempre rodou.
   */
  private static combine(early: boolean | null, late: boolean | null): boolean | null {
    if (early === null && late === null) return null
    return early === true || late === true
  }

  /**
   * Uma rodada do gate. Nunca lança, nunca bloqueia: qualquer tropeço vira
   * `null`, e `null` é "siga como antes".
   *
   * A ordem das checagens é econômica — `gateActive` vem antes de listar o
   * acervo e de varrer o docs/, porque sem serviço configurado nada disso seria
   * lido por ninguém.
   */
  private async askGate(
    convId: string,
    cwd: string,
    userText: string,
    answerText: string,
    knownHeaders?: readonly string[]
  ): Promise<boolean | null> {
    try {
      if (!this.deps.config().enabled) return null
      // Um gate injetado dispensa a sonda de produção: quem injetou já decidiu
      // que há a quem perguntar.
      const active = this.deps.gateActive ?? (this.deps.gate ? async () => true : memoryGateActive)
      if (!(await active())) return null

      const memoryHeaders = knownHeaders ?? (await this.readHeaders())
      const gate = this.deps.gate ?? shouldSaveMemory
      return await gate({
        userText,
        ...(answerText ? { answerText } : {}),
        usedMemories: this.deps.usedMemories?.(convId) ?? [],
        memoryHeaders,
        // O ÍNDICE, nunca o docs completo: o `state` do Jev aceita 32k tokens.
        docsIndex: await this.fetchDocs(cwd, 'index')
      })
    } catch {
      // Gate indisponível não é "não". O memorista segue e decide sozinho.
      return null
    }
  }

  /** Os cabeçalhos de TODAS as memórias ativas — o que o gate vê do acervo. */
  private async readHeaders(): Promise<string[]> {
    const memory = this.deps.memory()
    if (!memory) return []
    const entries = await memory.listEntries({ status: 'active' })
    return entries.filter((entry) => entry.status === 'active').map(Memorista.header)
  }

  private static header(entry: { relPath: string; title: string; hook: string }): string {
    return `${entry.relPath} — ${entry.title}: ${entry.hook}`
  }

  /** Docs do projeto, no recorte pedido. Falha vira string vazia: o observador
   *  perde uma seção do contexto, nunca a análise. */
  private async fetchDocs(cwd: string, mode: 'index' | 'full'): Promise<string> {
    if (!cwd) return ''
    try {
      const build = mode === 'index' ? (this.deps.docsIndex ?? buildDocsIndex) : (this.deps.docs ?? buildProjectOutline)
      return await build(cwd)
    } catch {
      return ''
    }
  }

  private nextCorrelationId(): string {
    return this.deps.newCorrelationId?.() ?? `memorista-${Date.now().toString(36)}-${this.correlations++}`
  }

  /**
   * O modelo desta análise. Fora do Automático é o da configuração, sem
   * chamada nenhuma; nele, sai do MESMO caminho que escolhe o modelo da
   * conversa — o que o memorista lê é o que o agente acabou de fazer, então o
   * turno que merecia o modelo caro é o mesmo cuja leitura merece.
   *
   * Roda depois do gate de propósito: o gate já recusou os turnos que não vão
   * virar memória, e perguntar qual modelo usar num turno que não vai rodar
   * seria gastar uma chamada para jogar fora. Falha vira par padrão — a
   * decisão nunca lança.
   */
  private async resolveModel(cfg: MemoristaConfig, userText: string, answerText: string): Promise<string> {
    if (!isAutoModel(cfg.model)) return cfg.model
    const prompt: AutoPrompt = {
      message: userText,
      history: answerText ? [{ who: 'agent', text: answerText }] : []
    }
    if (this.deps.autoModel) return this.deps.autoModel(prompt)
    // Sobre a lista DELE, não sobre a da conversa: o memorista é um leitor
    // barato, e escolher sobre CLAUDE_MODELS o deixaria cair num modelo acima
    // do teto que o seletor dele oferece ao usuário.
    return (await chooseAutoExecution(prompt, { models: MEMORISTA_AUTO_MODELS })).model
  }

  private async runClaude(request: MemoristaObserverRequest): Promise<ObserverAttempt> {
    if (this.deps.runClaude) return this.deps.runClaude(request)
    if (this.deps.ask) {
      try {
        return { provider: 'claude', state: 'completed', text: await this.deps.ask(request.prompt, request.model) }
      } catch {
        return { provider: 'claude', state: 'failed' }
      }
    }
    return runObserverAttempt({ prompt: request.prompt, model: request.model, provider: 'claude', cwd: request.cwd })
  }

  private async runLuna(request: MemoristaObserverRequest, onStarted: () => void): Promise<ObserverAttempt> {
    if (this.deps.runLuna) return this.deps.runLuna(request, onStarted)
    const runtime = await prepareGptRuntime(MEMORISTA_LUNA_MODEL)
    if (!runtime) return { provider: 'gpt-luna', state: 'not-started' }
    onStarted()
    return runObserverAttempt({
      prompt: request.prompt,
      model: MEMORISTA_LUNA_MODEL,
      provider: 'gpt-luna',
      cwd: request.cwd,
      env: runtime.env
    })
  }

  private diagnostic(
    request: MemoristaObserverRequest,
    phase: MemoristaProviderDiagnostic['phase'],
    actualProvider: 'claude' | 'gpt-luna',
    fallbackReason?: SafeProviderReason,
    savedMemories?: number
  ): void {
    this.deps.diagnose?.({
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      phase,
      requestedProvider: 'claude',
      actualProvider,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(savedMemories === undefined ? {} : { savedMemories })
    })
  }

  /**
   * Transforma uma operação do modelo em proposta para o serviço.
   *
   * `entries` é a lista FRESCA, relida imediatamente antes de escrever: entre o
   * digest e este ponto passou a consulta ao modelo, e nesses segundos o próprio
   * usuário (ou o curador diário) pode ter mexido no mesmo arquivo. O
   * `expectedRevision` tem que vir dessa leitura, senão o CAS do serviço recusa
   * a proposta por conflito — e a memória se perderia calada.
   */
  private buildProposal(
    op: MemoristaOp,
    entries: Awaited<ReturnType<MemoristaMemoryPort['listEntries']>>,
    convId: string
  ): MemoryProposeInput | null {
    const base = {
      proposedBy: `${MEMORISTA_AGENT}:${convId}`,
      originConversationId: convId,
      originAgent: MEMORISTA_AGENT
    }
    if (op.kind === 'create') {
      // Nasceu enquanto o modelo pensava: complementar exigiria a revisão e o
      // corpo que esta análise não viu. Falha fechada — volta no próximo turno.
      if (entries.some((entry) => entry.relPath.toLowerCase() === op.relPath.toLowerCase())) return null
      return {
        op: 'create',
        relPath: op.relPath,
        title: op.title,
        hook: op.hook,
        body: buildMemoryBody(op),
        // Escopo "user", como o curador: o acervo é do usuário, e um escopo de
        // projeto mal atribuído esconde a memória de onde ela seria útil.
        scope: 'user',
        ...base
      }
    }
    const entry = entries.find((item) => item.relPath.toLowerCase() === op.relPath.toLowerCase())
    if (!entry || entry.status !== 'active') return null
    const body = appendFact(entry.body, op.fact)
    if (body === null) return null
    return {
      op: 'update',
      relPath: entry.relPath,
      title: entry.title,
      hook: entry.hook,
      body,
      expectedRevision: entry.revision,
      ...base
    }
  }

  private async run(convId: string, turn: MemoristaTurnSnapshot): Promise<void> {
    const conv = this.conv(convId)

    // Snapshot lógico do pedido: não reler a configuração entre provedores, uma
    // mudança na tela não redireciona uma análise em voo.
    const cfg = this.deps.config()
    if (!cfg.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt < MEMORISTA_COOLDOWN_MS) {
      // Turno pulado não é turno perdido: volta no digest da próxima análise.
      this.defer(conv, turn)
      return
    }

    // O acumulado sai da fila para entrar nesta análise, mas continua sendo
    // dela só enquanto ela andar: se não chegar ao fim, volta para a fila.
    let taken: MemoristaDeferred | null = null
    let analyzed = false
    try {
      const memory = this.deps.memory()
      // Sem serviço não há índice para ler nem porta para escrever. Consultar o
      // modelo aqui seria gastar uma chamada para jogar o resultado fora.
      if (!memory) return
      const entries = (await memory.listEntries({ status: 'active' })).filter((entry) => entry.status === 'active')

      taken = conv.deferred
      conv.deferred = null
      const merged = this.mergeDeferred(taken, turn)

      // O segundo gate do turno, agora com a resposta final em mãos, somado ao
      // que a mensagem do usuário já tinha respondido.
      const verdict = Memorista.combine(
        await (turn.gate ?? Promise.resolve(null)),
        await this.askGate(convId, turn.cwd, merged.userText, turn.answerText, entries.map(Memorista.header))
      )
      if (verdict === false) {
        // O turno FOI julgado. Não volta para a fila — repeti-lo seria fazer a
        // mesma pergunta de novo — e não consome o cooldown, que existe para
        // limitar chamadas ao LLM e nenhuma foi feita.
        analyzed = true
        return
      }

      // Daqui em diante o modelo caro entra em cena: é este o ponto que o
      // cooldown protege.
      conv.lastRunAt = now

      const memories: MemoristaMemory[] = entries.map((entry) => ({
        relPath: entry.relPath,
        title: entry.title,
        hook: entry.hook
      }))
      const request: MemoristaObserverRequest = Object.freeze({
        prompt: buildMemoristaPrompt({
          userText: merged.userText,
          calls: [...merged.calls],
          memories,
          answerText: turn.answerText,
          usedMemories: this.deps.usedMemories?.(convId) ?? [],
          // Aprovado, o memorista recebe o docs COMPLETO: ele roda num Claude de
          // 200k, onde os ~85k tokens do docs/ cabem — ao contrário do gate.
          docs: await this.fetchDocs(turn.cwd, 'full')
        }),
        model: await this.resolveModel(cfg, merged.userText, turn.answerText),
        conversationId: convId,
        cwd: turn.cwd,
        correlationId: this.nextCorrelationId()
      })

      this.diagnostic(request, 'claude-started', 'claude')
      // Daqui em diante a análise começou, então ela também tem que anunciar o
      // FIM — senão o painel do elenco mostra o memorista trabalhando para
      // sempre em qualquer uma das saídas antecipadas abaixo.
      let provider: 'claude' | 'gpt-luna' = 'claude'
      let saved = 0
      try {
        let attempt = await this.runClaude(request)
        if (attempt.provider === 'claude' && attempt.state !== 'completed' && attempt.reason) {
          const fallbackReason = attempt.reason
          this.diagnostic(request, 'claude-unavailable', 'claude', fallbackReason)
          this.diagnostic(request, 'memorista-provider-switch', 'gpt-luna', fallbackReason)
          provider = 'gpt-luna'
          let lunaStarted = false
          attempt = await this.runLuna(request, () => {
            lunaStarted = true
            this.diagnostic(request, 'gpt-luna-started', 'gpt-luna', fallbackReason)
          })
          if (attempt.state !== 'completed') {
            this.diagnostic(request, 'gpt-luna-unavailable', 'gpt-luna', fallbackReason)
            return
          }
          // Defensivo: um runner injetado tem que anunciar o início real antes
          // de afirmar que a Luna respondeu.
          if (!lunaStarted) return
        }
        if (attempt.state !== 'completed') return

        const ops = parseMemoristaVerdict(attempt.text, entries.map((entry) => entry.relPath))
        if (ops.length === 0) {
          // O turno foi lido e não ensinou nada: não volta para a fila.
          analyzed = true
          return
        }

        // A lista fresca: o `expectedRevision` do update e a barreira contra
        // criar por cima de um arquivo que apareceu durante a consulta.
        const fresh = await memory.listEntries({ status: 'active' })
        const vault = this.deps.vault?.() ?? null
        const sanitize = this.deps.sanitize ?? sanitizeProposal
        for (const op of ops) {
          const input = this.buildProposal(op, fresh, convId)
          if (!input) continue
          try {
            // A varredura de segredos é obrigatória e vem antes da fila: uma
            // credencial que o usuário citou de passagem não pode chegar ao .md
            // nem ao índice. O valor vai para o cofre, o texto fica com o marcador.
            const sanitized = await sanitize(input, { vault })
            await memory.propose(sanitized.input)
            saved++
          } catch {
            // Uma proposta recusada (caminho inválido, colisão) não cancela as
            // outras nem derruba a análise.
          }
        }
        // Um drain só para o lote: `applyPending` é serializado por pasta, e
        // chamá-lo por proposta só multiplicaria a espera.
        if (saved > 0) await memory.applyPending()
        // Daqui em diante a análise chegou ao fim: o que ela tirou da fila foi
        // lido e não volta.
        analyzed = true
      } finally {
        this.diagnostic(request, 'analysis-finished', provider, undefined, saved)
      }
    } catch {
      // O observador não derruba o turno observado nem deixa o acervo pela metade.
    } finally {
      // Análise que não chegou ao fim não leu nada: nem o acumulado que tirou
      // da fila, nem o turno que a disparou. Os dois voltam, na ordem em que
      // aconteceram. O caminho do cooldown sai antes daqui, então nenhum turno
      // é enfileirado duas vezes.
      if (!analyzed) this.restoreDeferred(conv, taken, turn)
    }
  }
}

/** A chamada real é a mesma de todo observador do app (ver observerQuery.ts). */
export const askMemorista = askObserver
