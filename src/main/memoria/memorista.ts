import { prepareGptRuntime } from '../agentSession'
import {
  askObserver,
  runObserverAttempt,
  type ObserverAttempt,
  type SafeProviderReason
} from '../observerQuery'
import type { ChatEvent, MemoristaConfig, MemoristaProviderDiagnostic } from '../../shared/ipc'
import type { MemoryProposeInput } from '../memory/memoryModel'
import type { MemoryService } from '../memory/memoryService'
import { sanitizeProposal, type SecretSink } from '../memory/memorySecrets'
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
  type MemoristaOp
} from './memoristaPrompt'

export const MEMORISTA_LUNA_MODEL = 'gpt-5.6-luna'

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
  fired: boolean
  lastRunAt: number
  /** Os turnos que ainda não foram lidos — pulados pelo cooldown ou com a
   *  análise falha. Eles não somem: entram no digest da próxima análise desta
   *  conversa, porque um turno que nunca foi lido é exatamente o conhecimento
   *  que este recurso existe para não perder. */
  deferred: MemoristaDeferred | null
}

/** Evidência capturada junto com o `result`, antes de qualquer await. */
interface MemoristaTurnSnapshot {
  userText: string
  cwd: string
  calls: readonly MemoristaCall[]
}

/** Vários turnos num digest só, numerados: sem a numeração o modelo lê a emenda
 *  como uma fala única e junta dois assuntos numa memória só. */
function joinTexts(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? ''
  return texts.map((text, index) => `(${index + 1}) ${text}`).join(' ')
}

export class Memorista {
  private readonly state = new Map<string, ConvState>()
  /** As análises em voo por conversa — é o que `settled` espera. */
  private readonly inFlight = new Map<string, Set<Promise<void>>>()
  private correlations = 0

  constructor(private readonly deps: MemoristaDeps) {}

  /** Um turno começou. O cooldown e a fila são da CONVERSA e sobrevivem ao
   *  turno novo; o texto e as ações são do turno. */
  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
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
    if (event.kind === 'result') {
      // A próxima mensagem do usuário reinicia o acumulador desta conversa
      // enquanto a análise ainda espera o modelo. Congela a evidência agora.
      const turn: MemoristaTurnSnapshot = Object.freeze({
        userText: conv.userText,
        cwd: conv.cwd,
        calls: Object.freeze([...conv.calls])
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
      conv = { userText: null, cwd: '', calls: [], fired: false, lastRunAt: 0, deferred: null }
      this.state.set(convId, conv)
    }
    return conv
  }

  /** Dispara uma análise e a registra como em voo até o fim das escritas. */
  private start(convId: string, turn: MemoristaTurnSnapshot): void {
    const work = this.run(convId, turn)
    const inFlight = this.inFlight.get(convId) ?? new Set<Promise<void>>()
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
      userText: joinTexts(kept) || turn.userText,
      cwd: turn.cwd,
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

  private nextCorrelationId(): string {
    return this.deps.newCorrelationId?.() ?? `memorista-${Date.now().toString(36)}-${this.correlations++}`
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
    conv.lastRunAt = now

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

      const request: MemoristaObserverRequest = Object.freeze({
        prompt: buildMemoristaPrompt({
          userText: merged.userText,
          calls: [...merged.calls],
          memories: entries.map((entry) => ({ relPath: entry.relPath, title: entry.title, hook: entry.hook }))
        }),
        model: cfg.model,
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
