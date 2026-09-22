import { prepareGptRuntime } from '../agentSession'
import {
  askObserver,
  runObserverAttempt,
  type ObserverAttempt,
  type SafeProviderReason
} from '../observerQuery'
import type { BoardConfig, BoardItem, ChatEvent, PoProviderDiagnostic } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { taskLedger } from '../tasks/taskRuntime'
import {
  buildPoPrompt,
  parsePoVerdict,
  PO_COOLDOWN_MS,
  PO_MAX_CALLS,
  PO_MAX_LEDGER_TASKS,
  PO_MAX_USER_CHARS,
  rejectUnsafeOps,
  summarizeCall,
  type PoCall,
  type PoLedgerTask,
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
  /**
   * As tarefas do registro (mcp__tasks) ligadas a esta conversa — evidência
   * que sobrevive ao teto de PO_MAX_CALLS porque não depende do histórico de
   * ações. Sem injeção (produção), consulta o registro ativo; sem registro,
   * ou se a consulta falhar, devolve vazio — o PO nunca quebra por causa
   * disso, só perde a seção extra do digest.
   */
  listConvTasks?(convId: string): Promise<PoLedgerTask[]>
  /**
   * Todas as tarefas do registro (mcp__tasks) desta conversa, para a heurística
   * de vínculo automático tarefa↔cartão — sem filtro de status ou data, quem
   * filtra é `Po` (assim o teste exercita a regra real, não uma cópia dela no
   * dublê). Mesmo contrato de tolerância a falha de `listConvTasks`: sem
   * injeção consulta o registro ativo, e sem registro ou com a consulta
   * falhando devolve vazio — nunca quebra o PO.
   */
  linkableLedgerTasks?(convId: string): Promise<PoLinkableTask[]>
  /** `task_id -> board_item_id` já vinculados, para não vincular de novo.
   *  Mesmo contrato de tolerância a falha das outras pontes com o registro. */
  linkedBoardItemsFor?(taskIds: string[]): Promise<Map<string, string>>
  /** Vincula (upsert) uma tarefa do registro a um cartão do quadro. Mesmo
   *  contrato de tolerância a falha das outras pontes com o registro. */
  linkTaskToBoardItem?(taskId: string, boardItemId: string): Promise<void>
  /**
   * Agenda `fn` para depois de `delayMs` e devolve um cancelador. Produção usa
   * `setTimeout`/`clearTimeout` reais (sem segurar o processo vivo — `unref`);
   * testes injetam a própria implementação para disparar o flush do cooldown
   * sob controle, sem esperar de verdade, no mesmo espírito de `now`.
   */
  scheduleFlush?(delayMs: number, fn: () => void): () => void
}

/** Uma tarefa do registro, reduzida ao que a heurística de vínculo precisa. */
export interface PoLinkableTask {
  id: string
  status: string
  createdAt: string
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
  /** Uma fila por FASE, pelo mesmo motivo do cooldown ser por fase: o turno
   *  que a abertura pulou tem que voltar numa abertura futura, não ser
   *  engolido pelo fechamento que rodar primeiro (e vice-versa) — cada fase
   *  audita a evidência da SUA fila, nunca a da outra. Um pedido que nunca
   *  passou pelo PO é exatamente o buraco que este recurso existe para fechar. */
  deferred: Record<PoPhase, PoDeferred | null>
  /** Cancelador do flush agendado para quando o cooldown desta fase terminar
   *  — null quando não há nada agendado. Existe para o acumulado não ficar
   *  preso para sempre esperando um próximo turno que pode nunca chegar (o
   *  turno que terminou a conversa, por exemplo). Um só por fase: o turno que
   *  chega ENQUANTO o flush está agendado só se soma à mesma fila, não precisa
   *  de outro temporizador. */
  flushCancel: Record<PoPhase, (() => void) | null>
}

/** `PoDeps.scheduleFlush` padrão: `setTimeout`/`clearTimeout` reais, sem
 *  segurar o processo vivo (`unref`) — um flush pendente não pode ser o que
 *  impede o app de fechar. */
function defaultScheduleFlush(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(fn, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
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
    const conv = this.state.get(convId)
    if (conv) {
      for (const phase of ['open', 'close'] as const) {
        conv.flushCancel[phase]?.()
        conv.flushCancel[phase] = null
        // Última chance: a conversa está indo embora, e não existe "próximo
        // turno" nenhum depois disto para carregar o que ficou na fila — ou
        // esta evidência é julgada agora, ou some para sempre. `force`: o
        // cooldown pode nem ter terminado ainda (dispose pode acontecer a
        // qualquer momento), e reavaliá-lo aqui só adiaria de novo o que já
        // não tem mais para onde ser adiado.
        if (conv.deferred[phase]) this.start(convId, phase, this.emptyTurn(conv), true)
      }
    }
    this.state.delete(convId)
    this.inFlight.delete(convId)
  }

  /** Um turno "vazio": só carrega o acumulado da fila, sem pedido novo nenhum
   *  próprio. Usado pelo flush automático e pelo flush de última chance do
   *  `dispose`, onde não existe um turno real disparando a análise. */
  private emptyTurn(conv: ConvState): PoTurnSnapshot {
    return Object.freeze({ userText: '', cwd: conv.cwd, calls: Object.freeze([] as PoCall[]) })
  }

  /** Agenda (ou reaproveita) o flush desta fase para quando o cooldown que
   *  acabou de adiá-la terminar — sem isso, o acumulado só é julgado se um
   *  PRÓXIMO turno chegar. Uma conversa que termina sem mais mensagens (o
   *  caso comum: o usuário viu o trabalho pronto e foi embora) nunca teria
   *  esse próximo turno, e a evidência ficava presa na fila para sempre —
   *  inclusive some no restart do app, porque a fila só vive em memória. */
  private armFlush(convId: string, phase: PoPhase, conv: ConvState, now: number): void {
    if (conv.flushCancel[phase]) return
    const delay = Math.max(0, PO_COOLDOWN_MS - (now - conv.lastRunAt[phase]))
    const schedule = this.deps.scheduleFlush ?? defaultScheduleFlush
    conv.flushCancel[phase] = schedule(delay, () => {
      conv.flushCancel[phase] = null
      // Um turno real pode ter chegado nesse meio-tempo e já drenado a fila
      // (ou disparado ela por conta própria) — só dispara se sobrou algo.
      // `force`: este flush É a resposta ao cooldown que adiou a fase: rodar
      // `run` sem ele reavaliaria o mesmo cooldown (com o relógio de agora) e
      // poderia adiar de novo — inclusive na hora, se `dispose` disparar isto
      // antes da janela realmente terminar.
      if (conv.deferred[phase]) this.start(convId, phase, this.emptyTurn(conv), true)
    })
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = {
        userText: null,
        cwd: '',
        calls: [],
        fired: false,
        lastRunAt: { open: 0, close: 0 },
        deferred: { open: null, close: null },
        flushCancel: { open: null, close: null }
      }
      this.state.set(convId, conv)
    }
    return conv
  }

  /** Dispara uma análise e a registra como em voo até o fim das escritas.
   *  `force` pula o cooldown — só usado pelo próprio flush do cooldown
   *  (automático ou de última chance no `dispose`), nunca por um turno real. */
  private start(convId: string, phase: PoPhase, turn: PoTurnSnapshot, force = false): void {
    const work = this.run(convId, phase, turn, force)
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

  /** Guarda o turno que o cooldown pulou, na fila DESSA fase — com os mesmos
   *  tetos do digest, para o acumulado não crescer com o número de turnos
   *  pulados. */
  private defer(conv: ConvState, phase: PoPhase, turn: PoTurnSnapshot): void {
    const deferred = conv.deferred[phase] ?? { texts: [], calls: [] }
    deferred.texts.push(turn.userText)
    deferred.calls.push(...turn.calls)
    while (deferred.texts.length > 1 && deferred.texts.join(' ').length > PO_MAX_USER_CHARS) deferred.texts.shift()
    if (deferred.calls.length > PO_MAX_CALLS) deferred.calls.splice(0, deferred.calls.length - PO_MAX_CALLS)
    conv.deferred[phase] = deferred
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
  private restoreDeferred(conv: ConvState, phase: PoPhase, taken: PoDeferred): void {
    if (taken.texts.length === 0 && taken.calls.length === 0) return
    const queue = conv.deferred[phase] ?? { texts: [], calls: [] }
    // O que volta é mais ANTIGO do que o que entrou na fila enquanto a análise
    // rodava, então volta na frente — e os mesmos tetos continuam valendo.
    queue.texts.unshift(...taken.texts)
    queue.calls.unshift(...taken.calls)
    while (queue.texts.length > 1 && queue.texts.join(' ').length > PO_MAX_USER_CHARS) queue.texts.shift()
    if (queue.calls.length > PO_MAX_CALLS) queue.calls.splice(0, queue.calls.length - PO_MAX_CALLS)
    conv.deferred[phase] = queue
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
   *
   * A fase segue para `rejectUnsafeOps`: é ela quem decide se um `create`
   * duplicado contra a lista fresca vira `start` (só faz sentido na abertura).
   */
  private async confirmCreates(ops: PoOp[], convId: string, cwd: string, phase: PoPhase): Promise<PoOp[]> {
    if (!ops.some((op) => op.kind === 'create')) return ops
    const fresh = await this.deps.board.list(cwd, { conversationId: convId })
    // Sem lista fresca não dá para afirmar que o cartão não existe. Falha
    // fechada: duplicar é pior do que registrar depois, e o que ficou de fora
    // volta na próxima auditoria.
    if (!fresh) return ops.filter((op) => op.kind !== 'create')
    return rejectUnsafeOps(ops, fresh, phase)
  }

  /** Consulta o registro de tarefas ativo. Nunca lança: sem registro ou com a
   *  consulta falhando, o PO segue só com a evidência de ações — degrada, não
   *  quebra. */
  private async listConvTasks(convId: string): Promise<PoLedgerTask[]> {
    // O catch cobre as DUAS origens (a injetada e o registro real): uma
    // consulta injetada em produção pode falhar tanto quanto o registro em
    // si, e das duas formas o PO segue só sem a seção extra, nunca aborta.
    try {
      if (this.deps.listConvTasks) return await this.deps.listConvTasks(convId)
      const ledger = taskLedger()
      if (!ledger) return []
      const tasks = await ledger.listTasks({ conversationId: convId, limit: PO_MAX_LEDGER_TASKS })
      return tasks.map((task) => ({ title: task.title, status: task.status }))
    } catch {
      return []
    }
  }

  /** Todas as tarefas do registro desta conversa, sem filtro — quem filtra é
   *  `linkLedgerTaskToCard`. Nunca lança: mesma tolerância de `listConvTasks`. */
  private async linkableLedgerTasks(convId: string): Promise<PoLinkableTask[]> {
    try {
      if (this.deps.linkableLedgerTasks) return await this.deps.linkableLedgerTasks(convId)
      const ledger = taskLedger()
      if (!ledger) return []
      const tasks = await ledger.listTasks({ conversationId: convId })
      return tasks.map((task) => ({ id: task.id, status: task.status, createdAt: task.createdAt }))
    } catch {
      return []
    }
  }

  /** `task_id -> board_item_id` já vinculados dentre os candidatos. Nunca lança. */
  private async linkedBoardItemsFor(taskIds: string[]): Promise<Map<string, string>> {
    if (taskIds.length === 0) return new Map()
    try {
      if (this.deps.linkedBoardItemsFor) return await this.deps.linkedBoardItemsFor(taskIds)
      const ledger = taskLedger()
      if (!ledger) return new Map()
      return await ledger.boardItemIdsForTasks(taskIds)
    } catch {
      return new Map()
    }
  }

  /** Grava o vínculo. Nunca lança: um vínculo perdido não é motivo para
   *  derrubar a análise que já escreveu o cartão no quadro. */
  private async linkTaskToBoardCard(taskId: string, boardItemId: string): Promise<void> {
    try {
      if (this.deps.linkTaskToBoardItem) {
        await this.deps.linkTaskToBoardItem(taskId, boardItemId)
        return
      }
      const ledger = taskLedger()
      if (!ledger) return
      await ledger.linkTaskToBoardItem({ taskId, boardItemId, linkedBy: 'po' })
    } catch {
      // O vínculo é conveniência, não fonte da verdade: falhar aqui não pode
      // derrubar a auditoria que já promoveu o cartão.
    }
  }

  /**
   * Tenta vincular uma tarefa do registro ao cartão que ACABOU de entrar em
   * andamento nesta mesma conversa.
   *
   * Critério deliberadamente conservador: só vincula quando sobra EXATAMENTE
   * UMA candidata. Zero candidatas é "nada para vincular ainda"; mais de uma é
   * "não dá para saber qual" — nos dois casos, não vincular é o correto, porque
   * um vínculo errado é pior do que nenhum (o `critico` julgaria a tarefa
   * errada pelo cartão errado).
   *
   * `promotedAt` é o instante em que ESTA análise decidiu promover o cartão —
   * não existe, no que chega até aqui, um timestamp mais preciso do próprio
   * evento de promoção (o quadro guarda o cartão, não o "quando" da escrita do
   * PO). Usar o início da análise como aproximação é seguro na direção que
   * importa: uma tarefa aberta antes deste turno nunca é candidata, mesmo que
   * o registro e o quadro tenham relógios levemente diferentes.
   */
  private async linkLedgerTaskToCard(convId: string, boardItemId: string, promotedAt: number): Promise<void> {
    try {
      const tasks = await this.linkableLedgerTasks(convId)
      const candidates = tasks.filter(
        (task) =>
          (task.status === 'running' || task.status === 'pending' || task.status === 'review') &&
          Date.parse(task.createdAt) > promotedAt
      )
      if (candidates.length === 0) return
      const linked = await this.linkedBoardItemsFor(candidates.map((task) => task.id))
      const unlinked = candidates.filter((task) => !linked.has(task.id))
      if (unlinked.length !== 1) return
      await this.linkTaskToBoardCard(unlinked[0].id, boardItemId)
    } catch {
      // Best-effort: o vínculo nunca deve derrubar a auditoria do PO.
    }
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

  private async run(convId: string, phase: PoPhase, turn: PoTurnSnapshot, force = false): Promise<void> {
    const conv = this.conv(convId)

    // This is the logical-request snapshot. Do not reread config between
    // providers; a settings change cannot redirect an in-flight audit.
    const cfg = this.deps.config()
    if (!cfg.po.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (!force && now - conv.lastRunAt[phase] < PO_COOLDOWN_MS) {
      // Turno pulado não é turno perdido: o pedido e as ações esperam a
      // PRÓXIMA análise DESTA FASE. Sem isso, um pedido que caísse no cooldown
      // da abertura (ex.: mensagens em sequência rápida) sumia sem nunca mover
      // cartão nenhum para "fazendo" — e por fila SEPARADA por fase, porque a
      // abertura e o fechamento rodam em cadências diferentes; se dividissem
      // uma fila só, quem rodasse primeiro esvaziaria o que era da outra.
      this.defer(conv, phase, turn)
      this.armFlush(convId, phase, conv, now)
      return
    }
    conv.lastRunAt[phase] = now
    // Esta análise já vai drenar a fila (real ou vazia) — um flush agendado
    // para o mesmo motivo não tem mais o que fazer.
    conv.flushCancel[phase]?.()
    conv.flushCancel[phase] = null

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

      taken = conv.deferred[phase]
      conv.deferred[phase] = null
      const merged = this.mergeDeferred(taken, turn)
      const ledgerTasks = await this.listConvTasks(convId)
      const prompt = buildPoPrompt({
        userText: merged.userText,
        cards: cards.map((card) => ({
          id: card.id,
          title: card.poTitle ?? card.sourceTitle,
          status: card.poStatus ?? card.sourceStatus
        })),
        calls: [...merged.calls],
        phase,
        ledgerTasks
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
          cards,
          phase
        )
        // A lista que o modelo julgou é de antes da consulta. Antes de criar,
        // confere contra o quadro de agora — a outra fase deste mesmo turno
        // pode ter criado o cartão nesse meio-tempo.
        const ops = await this.confirmCreates(verdict, convId, turn.cwd, phase)

        for (const op of ops) {
          if (op.kind === 'complete') {
            await this.deps.board.applyPo({ id: op.id, poStatus: 'completed', poReason: op.reason })
          } else if (op.kind === 'start') {
            await this.deps.board.applyPo({ id: op.id, poStatus: 'in_progress', poReason: op.reason })
            // O cartão acabou de entrar em andamento: tenta achar a tarefa do
            // registro que é este mesmo trabalho, para o quadro e o registro
            // apontarem para a mesma coisa sem depender de o agente lembrar.
            await this.linkLedgerTaskToCard(convId, op.id, now)
          } else if (op.kind === 'retitle') {
            await this.deps.board.applyPo({ id: op.id, poTitle: op.title })
          } else {
            const created = await this.deps.board.createPoItem({
              projectId,
              projectCwd: turn.cwd,
              conversationId: convId,
              title: op.title,
              status: op.status,
              reason: op.reason
            })
            if (created && op.status === 'in_progress') await this.linkLedgerTaskToCard(convId, created.id, now)
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
      if (!audited && taken) this.restoreDeferred(conv, phase, taken)
    }
  }
}

/** Compatibility alias used by existing tests and external imports. */
export const askPo = askObserver
