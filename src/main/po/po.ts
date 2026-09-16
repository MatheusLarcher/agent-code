import { prepareGptRuntime } from '../agentSession'
import {
  askObserver,
  runObserverAttempt,
  type ObserverAttempt,
  type SafeProviderReason
} from '../observerQuery'
import type { BoardConfig, BoardItem, ChatEvent, PoProviderDiagnostic } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import {
  buildPoPrompt,
  parsePoVerdict,
  PO_COOLDOWN_MS,
  PO_MAX_CALLS,
  PO_MAX_USER_CHARS,
  rejectUnsafeOps,
  summarizeCall,
  type PoCall,
  type PoOp,
  type PoPhase
} from './poPrompt'

export const PO_LUNA_MODEL = 'gpt-5.6-luna'

/** Immutable, provider-neutral intent created once for both observer attempts. */
export interface PoObserverRequest {
  prompt: string
  model: string
  conversationId: string
  cwd: string
  projectId: string
  /** Abertura (o pedido chegou) ou fechamento (o turno acabou). */
  phase: PoPhase
  cards: readonly Pick<BoardItem, 'id' | 'projectId' | 'projectCwd' | 'conversationId' | 'sourceTitle' | 'sourceStatus' | 'poTitle' | 'poStatus'>[]
  correlationId: string
}

/**
 * O PO: acompanha o quadro em DUAS rodadas por turno, sem falar com o agente
 * principal — abre o cartão quando o pedido chega e audita quando o turno
 * termina. Claude é sempre a primeira tentativa. Somente uma falha Claude
 * estruturada e elegível pode disparar uma única consulta Luna, antes de
 * qualquer escrita.
 */
export interface PoDeps {
  /** Lido uma vez por análise: mudanças durante o fallback não trocam a rota. */
  config(): BoardConfig
  board: BoardService
  /** Compatibilidade para testes e consumidores do PO original. */
  ask?(prompt: string, model: string): Promise<string>
  runClaude?(request: PoObserverRequest): Promise<ObserverAttempt>
  runLuna?(request: PoObserverRequest, onStarted: () => void): Promise<ObserverAttempt>
  diagnose?(diagnostic: PoProviderDiagnostic): void
  now?(): number
  newCorrelationId?(): string
}

/** A fila dos turnos que ainda não passaram pelo PO. */
interface PoDeferred {
  texts: string[]
  calls: PoCall[]
}

interface ConvState {
  userText: string | null
  cwd: string
  calls: PoCall[]
  fired: boolean
  /** Uma janela de cooldown por FASE: a abertura não pode gastar a do
   *  fechamento, senão o turno que acabou de ser aberto nunca seria auditado. */
  lastRunAt: Record<PoPhase, number>
  /** O turno que o cooldown de fechamento pulou. Ele não some: entra no digest
   *  da próxima auditoria desta conversa, porque um pedido que nunca passou
   *  pelo PO é exatamente o buraco que este recurso existe para fechar. */
  deferred: PoDeferred | null
}

/** Evidence captured synchronously with a result, before board ingestion yields. */
interface PoTurnSnapshot {
  userText: string
  cwd: string
  calls: readonly PoCall[]
}

/** Vários pedidos num digest só, numerados: sem a numeração o modelo lê a
 *  emenda como um pedido único e responde por um só. */
function joinRequests(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? ''
  return texts.map((text, index) => `(${index + 1}) ${text}`).join(' ')
}

export class Po {
  private readonly state = new Map<string, ConvState>()
  /** As análises em voo por conversa — é o que `settled` espera. */
  private readonly inFlight = new Map<string, Set<Promise<void>>>()
  private correlations = 0

  constructor(private readonly deps: PoDeps) {}

  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
    // A ABERTURA: o pedido tem que virar cartão antes de o trabalho começar.
    // Deixar só a auditoria do fim significa que o pedido que o agente nunca
    // declarou não deixa rastro nenhum no quadro — quando o PO olha, já não há
    // o que reconhecer. Em `void`, como todo o resto do observador: ele nunca
    // segura nem derruba o turno do usuário.
    this.start(convId, 'open', Object.freeze({ userText: text, cwd, calls: Object.freeze([] as PoCall[]) }))
  }

  observe(convId: string, event: ChatEvent): void {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    if (event.kind === 'tool-use') {
      conv.calls.push({ tool: event.name, detail: summarizeCall(event.name, event.input) })
      if (conv.calls.length > PO_MAX_CALLS) conv.calls.shift()
      return
    }
    if (event.kind === 'result') {
      // A later user message resets the mutable conversation accumulator while
      // this audit awaits board ingestion. Preserve this turn's evidence now.
      const turn: PoTurnSnapshot = Object.freeze({
        userText: conv.userText,
        cwd: conv.cwd,
        calls: Object.freeze([...conv.calls])
      })
      conv.fired = true
      this.start(convId, 'close', turn)
      return
    }
    if (event.kind === 'error') conv.userText = null
  }

  /**
   * Resolve quando as análises em voo desta conversa terminarem — as escritas no
   * quadro incluídas. Existe para quem precisa agir DEPOIS do PO (a reabertura
   * determinística do que ficou "fazendo") não competir com ele pelo mesmo
   * cartão. Sem análise em voo resolve na hora, e nunca rejeita: esperar por um
   * observador não pode ser um jeito novo de derrubar quem esperou.
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
      conv = { userText: null, cwd: '', calls: [], fired: false, lastRunAt: { open: 0, close: 0 }, deferred: null }
      this.state.set(convId, conv)
    }
    return conv
  }

  /** Dispara uma análise e a registra como em voo até o fim das escritas. */
  private start(convId: string, phase: PoPhase, turn: PoTurnSnapshot): void {
    const work = this.run(convId, phase, turn)
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
  private defer(conv: ConvState, turn: PoTurnSnapshot): void {
    const deferred = conv.deferred ?? { texts: [], calls: [] }
    deferred.texts.push(turn.userText)
    deferred.calls.push(...turn.calls)
    while (deferred.texts.length > 1 && deferred.texts.join(' ').length > PO_MAX_USER_CHARS) deferred.texts.shift()
    if (deferred.calls.length > PO_MAX_CALLS) deferred.calls.splice(0, deferred.calls.length - PO_MAX_CALLS)
    conv.deferred = deferred
  }

  /**
   * Junta os turnos pulados ao turno de agora, DENTRO do orçamento do digest.
   *
   * O teto tem que ser aplicado aqui, e descartando do mais ANTIGO para o mais
   * novo: o `clamp` do digest corta pela cauda, então entregar tudo concatenado
   * faria o acumulado cheio empurrar para fora justamente o pedido que acabou
   * de chegar — o oposto do que este acúmulo existe para fazer. O pedido de
   * AGORA entra sempre, mesmo quando sozinho já estoura o teto (aí ele é
   * truncado, mas continua sendo ele). Nas ações vale o mesmo critério: as
   * mais recentes sobrevivem, porque a evidência do fim é a que decide o que
   * terminou.
   */
  private mergeDeferred(deferred: PoDeferred | null, turn: PoTurnSnapshot): PoTurnSnapshot {
    if (!deferred || (deferred.texts.length === 0 && deferred.calls.length === 0)) return turn
    const kept = [...deferred.texts, turn.userText].filter((text) => text.trim().length > 0)
    while (kept.length > 1 && joinRequests(kept).length > PO_MAX_USER_CHARS) kept.shift()
    return Object.freeze({
      userText: joinRequests(kept) || turn.userText,
      cwd: turn.cwd,
      calls: Object.freeze([...deferred.calls, ...turn.calls].slice(-PO_MAX_CALLS))
    })
  }

  /**
   * Devolve à fila o acumulado que esta análise pegou e não chegou a auditar.
   *
   * Sem isso, uma falha depois da retirada (Claude indisponível, Luna sem
   * configuração, quadro rejeitando a escrita) apaga para sempre turnos que
   * NUNCA passaram pelo PO — exatamente o buraco que o acúmulo tapa. Tirar da
   * fila é um empréstimo até a análise terminar, não uma baixa.
   */
  private restoreDeferred(conv: ConvState, taken: PoDeferred): void {
    if (taken.texts.length === 0 && taken.calls.length === 0) return
    const queue = conv.deferred ?? { texts: [], calls: [] }
    // O que volta é mais ANTIGO do que o que entrou na fila enquanto a análise
    // rodava, então volta na frente — e os mesmos tetos continuam valendo.
    queue.texts.unshift(...taken.texts)
    queue.calls.unshift(...taken.calls)
    while (queue.texts.length > 1 && queue.texts.join(' ').length > PO_MAX_USER_CHARS) queue.texts.shift()
    if (queue.calls.length > PO_MAX_CALLS) queue.calls.splice(0, queue.calls.length - PO_MAX_CALLS)
    conv.deferred = queue
  }

  /**
   * Relê o quadro imediatamente antes de escrever, quando há criação.
   *
   * Entre o `list` que montou o digest e este ponto passou a consulta ao
   * modelo — segundos em que a ABERTURA desta mesma conversa pode ter criado o
   * cartão que o fechamento está prestes a criar de novo. `board.settled` não
   * cobre isso: ele é a fila de ingestão do snapshot, e o PO escreve direto no
   * repositório. Criar é a única operação irreversível daqui (cartão duplicado
   * fica no quadro e ninguém sabe qual seguir), então vale reaplicar as
   * barreiras contra a lista FRESCA: a janela cai para o tempo de um `list` e
   * o custo é uma leitura só quando há criação — diferente de esperar a
   * abertura terminar, que atrasaria toda auditoria e comeria a janela que o
   * quadro espera pelo PO.
   */
  private async confirmCreates(ops: PoOp[], convId: string, cwd: string): Promise<PoOp[]> {
    if (!ops.some((op) => op.kind === 'create')) return ops
    const fresh = await this.deps.board.list(cwd, { conversationId: convId })
    // Sem lista fresca não dá para afirmar que o cartão não existe. Falha
    // fechada: duplicar é pior do que registrar depois, e o que ficou de fora
    // volta na próxima auditoria.
    if (!fresh) return ops.filter((op) => op.kind !== 'create')
    return rejectUnsafeOps(ops, fresh)
  }

  private nextCorrelationId(): string {
    return this.deps.newCorrelationId?.() ?? `po-${Date.now().toString(36)}-${this.correlations++}`
  }

  private async runClaude(request: PoObserverRequest): Promise<ObserverAttempt> {
    if (this.deps.runClaude) return this.deps.runClaude(request)
    if (this.deps.ask) {
      try {
        return { provider: 'claude', state: 'completed', text: await this.deps.ask(request.prompt, request.model) }
      } catch {
        return { provider: 'claude', state: 'failed' }
      }
    }
    return runObserverAttempt({
      prompt: request.prompt,
      model: request.model,
      provider: 'claude',
      cwd: request.cwd
    })
  }

  private async runLuna(request: PoObserverRequest, onStarted: () => void): Promise<ObserverAttempt> {
    if (this.deps.runLuna) return this.deps.runLuna(request, onStarted)
    const runtime = await prepareGptRuntime(PO_LUNA_MODEL)
    if (!runtime) return { provider: 'gpt-luna', state: 'not-started' }
    onStarted()
    return runObserverAttempt({
      prompt: request.prompt,
      model: PO_LUNA_MODEL,
      provider: 'gpt-luna',
      cwd: request.cwd,
      env: runtime.env
    })
  }

  private diagnostic(
    request: PoObserverRequest,
    phase: PoProviderDiagnostic['phase'],
    actualProvider: 'claude' | 'gpt-luna',
    fallbackReason?: SafeProviderReason,
    appliedOps?: number
  ): void {
    this.deps.diagnose?.({
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      // A rodada sai do próprio pedido, e não de um parâmetro novo: assim NENHUM
      // diagnóstico pode ser emitido sem ela. Sem isso o elenco mostra os dois
      // ciclos do turno com a mesma frase, e o usuário vê o PO trabalhar duas
      // vezes sem saber o que mudou entre elas.
      round: request.phase,
      phase,
      requestedProvider: 'claude',
      actualProvider,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(appliedOps === undefined ? {} : { appliedOps })
    })
  }

  private async run(convId: string, phase: PoPhase, turn: PoTurnSnapshot): Promise<void> {
    const conv = this.conv(convId)

    // This is the logical-request snapshot. Do not reread config between
    // providers; a settings change cannot redirect an in-flight audit.
    const cfg = this.deps.config()
    if (!cfg.po.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt[phase] < PO_COOLDOWN_MS) {
      // Turno pulado não é turno perdido: o pedido e as ações esperam a próxima
      // auditoria desta conversa. (A abertura não acumula — o pedido dela volta
      // inteiro no digest do fechamento.)
      if (phase === 'close') this.defer(conv, turn)
      return
    }
    conv.lastRunAt[phase] = now

    // O acumulado sai da fila para entrar nesta análise, mas continua sendo
    // dela só enquanto ela andar: se não chegar ao fim, volta para a fila.
    let taken: PoDeferred | null = null
    let audited = false
    try {
      await this.deps.board.settled(convId)
      const cards = await this.deps.board.list(turn.cwd, { conversationId: convId })
      // `null` é quadro INDISPONÍVEL (sem repositório, pasta fora do ar): não há
      // o que ler nem onde escrever. `[]` é quadro VAZIO, e esse é justamente o
      // caso que a abertura existe para consertar — desistir dele era desistir
      // do pedido que nunca virou tarefa.
      if (!cards) return
      // O id do projeto não pode sair de `cards[0]`: no quadro vazio não existe
      // cards[0]. Vem da mesma identidade que o `list` usou, e sem ela não dá
      // para criar cartão nenhum.
      const projectId = await this.deps.board.projectId(turn.cwd)
      if (!projectId) return

      if (phase === 'close') {
        taken = conv.deferred
        conv.deferred = null
      }
      const merged = phase === 'close' ? this.mergeDeferred(taken, turn) : turn
      const prompt = buildPoPrompt({
        userText: merged.userText,
        cards: cards.map((card) => ({
          id: card.id,
          title: card.poTitle ?? card.sourceTitle,
          status: card.poStatus ?? card.sourceStatus
        })),
        calls: [...merged.calls],
        phase
      })
      const request: PoObserverRequest = Object.freeze({
        prompt,
        model: cfg.po.model,
        conversationId: convId,
        cwd: turn.cwd,
        projectId,
        phase,
        cards: Object.freeze(cards.map((card) => Object.freeze({
          id: card.id,
          projectId: card.projectId,
          projectCwd: card.projectCwd,
          conversationId: card.conversationId,
          sourceTitle: card.sourceTitle,
          sourceStatus: card.sourceStatus,
          poTitle: card.poTitle,
          poStatus: card.poStatus
        }))),
        correlationId: this.nextCorrelationId()
      })

      this.diagnostic(request, 'claude-started', 'claude')
      // From here the audit has started, so it must also announce its END —
      // otherwise the crew panel would show the PO working forever on any of
      // the early returns below. `provider` follows whichever route ran.
      let provider: 'claude' | 'gpt-luna' = 'claude'
      let applied = 0
      try {
        let attempt = await this.runClaude(request)
        if (attempt.provider === 'claude' && attempt.state !== 'completed' && attempt.reason) {
          const fallbackReason = attempt.reason
          this.diagnostic(request, 'claude-unavailable', 'claude', fallbackReason)
          this.diagnostic(request, 'po-provider-switch', 'gpt-luna', fallbackReason)
          provider = 'gpt-luna'
          let lunaStarted = false
          attempt = await this.runLuna(request, () => {
            lunaStarted = true
            this.diagnostic(request, 'gpt-luna-started', 'gpt-luna', fallbackReason)
          })
          if (attempt.state !== 'completed') {
            // Setup failure has no preceding Luna-started notice; a started Luna
            // gets an error after its own failed attempt. Both are safe and transient.
            this.diagnostic(request, 'gpt-luna-unavailable', 'gpt-luna', fallbackReason)
            return
          }
          // Defensive: injected runners must announce their actual start before
          // claiming a completed Luna response.
          if (!lunaStarted) return
        }
        if (attempt.state !== 'completed') return

        const verdict = rejectUnsafeOps(
          parsePoVerdict(attempt.text, cards.map((card) => card.id), phase),
          cards
        )
        // A lista que o modelo julgou é de antes da consulta. Antes de criar,
        // confere contra o quadro de agora — a outra fase deste mesmo turno
        // pode ter criado o cartão nesse meio-tempo.
        const ops = await this.confirmCreates(verdict, convId, turn.cwd)

        for (const op of ops) {
          if (op.kind === 'complete') {
            await this.deps.board.applyPo({ id: op.id, poStatus: 'completed', poReason: op.reason })
          } else if (op.kind === 'start') {
            await this.deps.board.applyPo({ id: op.id, poStatus: 'in_progress', poReason: op.reason })
          } else if (op.kind === 'retitle') {
            await this.deps.board.applyPo({ id: op.id, poTitle: op.title })
          } else {
            await this.deps.board.createPoItem({
              projectId,
              projectCwd: turn.cwd,
              conversationId: convId,
              title: op.title,
              status: op.status,
              reason: op.reason
            })
          }
          applied++
        }
        // Daqui em diante a análise chegou ao fim: o que ela tirou da fila foi
        // julgado e escrito, e não volta.
        audited = true
      } finally {
        this.diagnostic(request, 'audit-finished', provider, undefined, applied)
      }
    } catch {
      // The observer cannot take down the observed turn or write a partial board.
    } finally {
      if (!audited && taken) this.restoreDeferred(conv, taken)
    }
  }
}

/** Compatibility alias used by existing tests and external imports. */
export const askPo = askObserver
