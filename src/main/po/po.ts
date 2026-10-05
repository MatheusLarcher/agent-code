import { askObserver } from '../observerQuery'
import type { BoardConfig, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { applyPoVerdict, type PoApplyProgress } from './poApply'
import { listConvTasks, type PoLedgerDeps } from './poLedger'
import {
  buildPoPrompt,
  PO_COOLDOWN_MS,
  PO_MAX_CALLS,
  PO_MAX_RETRIES,
  PO_RETRY_DELAY_MS,
  summarizeCall,
  type PoCall,
  type PoPhase
} from './poPrompt'
import type { PoLogEntry, PoLogOutcome, PoLogWriter } from './poLog'
import { askBoardGate, consultWithFailover, diagnostic, type PoObserverRequest, type PoProviderDeps } from './poProviders'
import { defer, mergeDeferred, requeueTurn, restoreTaken, type PoDeferred, type PoTurnSnapshot } from './poQueue'

// A API pública do PO continua saindo daqui, mesmo com as partes em módulos
// próprios: quem importa de './po' não precisa saber como ele foi dividido.
export { PO_LUNA_MODEL, type PoObserverRequest } from './poProviders'
export { PO_MAX_RETRIES, PO_RETRY_DELAY_MS } from './poPrompt'
export type { PoLinkableTask } from './poLedger'

/**
 * O PO: acompanha o quadro em DUAS rodadas por turno, sem falar com o agente
 * principal — abre o cartão quando o pedido chega e audita quando o turno
 * termina. Claude é sempre a primeira tentativa. Somente uma falha Claude
 * estruturada e elegível pode disparar uma única consulta Luna, antes de
 * qualquer escrita.
 *
 * As rotas de modelo (`ask`, `runClaude`, `runLuna`, `diagnose`) e o gate do
 * TypeSafe (`gate`, `gateActive`) vêm de `PoProviderDeps` (poProviders.ts) e as
 * pontes com o registro de tarefas
 * (`listConvTasks`, `linkableLedgerTasks`, `linkedBoardItemsFor`,
 * `linkTaskToBoardItem`) de `PoLedgerDeps` (poLedger.ts) — cada módulo declara
 * o que consome, e aqui fica a soma.
 */
export interface PoDeps extends PoProviderDeps, PoLedgerDeps {
  /** Lido uma vez por análise: mudanças durante o fallback não trocam a rota. */
  config(): BoardConfig
  board: BoardService
  now?(): number
  newCorrelationId?(): string
  /**
   * Agenda `fn` para depois de `delayMs` e devolve um cancelador. Produção usa
   * `setTimeout`/`clearTimeout` reais (sem segurar o processo vivo — `unref`);
   * testes injetam a própria implementação para disparar o flush do cooldown
   * (e a retentativa, que usa o mesmo caminho) sob controle, sem esperar de
   * verdade, no mesmo espírito de `now`.
   */
  scheduleFlush?(delayMs: number, fn: () => void): () => void
  /** O diário do PO (uma linha por rodada, ver poLog.ts). Opcional para o
   *  teste não tocar disco; nunca pode lançar para dentro do PO. */
  decisionLog?: PoLogWriter
}

interface ConvState {
  userText: string | null
  cwd: string
  calls: PoCall[]
  fired: boolean
  /** O último texto final do agente. Durante o turno é a resposta DELE (vai
   *  para o fechamento); quando a próxima mensagem chega, é a do turno anterior
   *  (vai para a abertura) e zera. Mesma regra do memorista: vale o último
   *  bloco fechado, e o texto do `result` tem preferência quando vem. */
  reply: string | null
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
   *  de outro temporizador. A retentativa de uma análise que falhou usa este
   *  MESMO lugar: as duas coisas são "julgar a fila desta fase mais tarde", e
   *  dois temporizadores para isso só disputariam a mesma fila. */
  flushCancel: Record<PoPhase, (() => void) | null>
  /** Retentativas SEGUIDAS já agendadas nesta fase (teto: PO_MAX_RETRIES).
   *  Zera numa auditoria que chega ao fim — inclusive o "não" do gate — e
   *  quando um turno real dispara a análise: aí a falha anterior é passado. */
  retries: Record<PoPhase, number>
  /** O que ainda roda em SEGUNDO PLANO (descrições do último snapshot
   *  `background-tasks`, vazio = nada). Estado vivo, não evidência de turno:
   *  o fechamento real o congela no `result`; o flush usa o de agora. */
  background: readonly string[]
}

/** `PoDeps.scheduleFlush` padrão: `setTimeout`/`clearTimeout` reais, sem
 *  segurar o processo vivo (`unref`) — um flush pendente não pode ser o que
 *  impede o app de fechar. */
function defaultScheduleFlush(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(fn, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class Po {
  private readonly state = new Map<string, ConvState>()
  /** As análises em voo por conversa — é o que `settled` espera. */
  private readonly inFlight = new Map<string, Set<Promise<void>>>()
  private correlations = 0

  constructor(private readonly deps: PoDeps) {}

  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    // A resposta que o usuário está respondendo agora ("pode fazer" só faz
    // sentido com ela) — sai com a abertura e dá lugar à deste turno.
    const previousReply = conv.reply
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
    conv.reply = null
    // A ABERTURA: o pedido tem que virar cartão antes de o trabalho começar.
    // Deixar só a auditoria do fim significa que o pedido que o agente nunca
    // declarou não deixa rastro nenhum no quadro — quando o PO olha, já não há
    // o que reconhecer. Em `void`, como todo o resto do observador: ele nunca
    // segura nem derruba o turno do usuário.
    this.start(
      convId,
      'open',
      Object.freeze({ userText: text, cwd, calls: Object.freeze([] as PoCall[]), reply: previousReply })
    )
  }

  observe(convId: string, event: ChatEvent): void {
    const conv = this.conv(convId)
    // O snapshot vale a qualquer momento — inclusive fora de turno (antes do
    // pedido, depois do `result`): é quando o subagente delegado costuma mudar.
    if (event.kind === 'background-tasks') {
      conv.background = Object.freeze(event.tasks.map((task) => task.description.trim() || task.type))
      return
    }
    if (conv.userText === null || conv.fired) return
    if (event.kind === 'tool-use') {
      conv.calls.push({ tool: event.name, detail: summarizeCall(event.name, event.input) })
      if (conv.calls.length > PO_MAX_CALLS) conv.calls.shift()
      return
    }
    if (event.kind === 'assistant-text') {
      if (event.final && event.text) conv.reply = event.text
      return
    }
    if (event.kind === 'result') {
      if (event.text) conv.reply = event.text
      // A later user message resets the mutable conversation accumulator while
      // this audit awaits board ingestion. Preserve this turn's evidence now.
      const turn: PoTurnSnapshot = Object.freeze({
        userText: conv.userText,
        cwd: conv.cwd,
        calls: Object.freeze([...conv.calls]),
        reply: conv.reply,
        background: conv.background
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

  /** Agenda o flush desta fase daqui a `delayMs` — para quando o cooldown que
   *  acabou de adiá-la terminar, ou para a retentativa de uma análise que
   *  falhou. Sem isso, o acumulado só é julgado se um PRÓXIMO turno chegar.
   *  Uma conversa que termina sem mais mensagens (o caso comum: o usuário viu
   *  o trabalho pronto e foi embora) nunca teria esse próximo turno, e a
   *  evidência ficava presa na fila para sempre — inclusive some no restart do
   *  app, porque a fila só vive em memória. Devolve `false` quando já havia um
   *  flush agendado nesta fase: ele é reaproveitado, nunca duplicado. */
  private armFlush(convId: string, phase: PoPhase, conv: ConvState, delayMs: number): boolean {
    if (conv.flushCancel[phase]) return false
    const schedule = this.deps.scheduleFlush ?? defaultScheduleFlush
    conv.flushCancel[phase] = schedule(delayMs, () => {
      conv.flushCancel[phase] = null
      // Um turno real pode ter chegado nesse meio-tempo e já drenado a fila
      // (ou disparado ela por conta própria) — só dispara se sobrou algo.
      // `force`: este flush É a resposta ao cooldown que adiou a fase (ou à
      // falha que pediu a retentativa): rodar `run` sem ele reavaliaria o
      // mesmo cooldown (com o relógio de agora) e poderia adiar de novo —
      // inclusive na hora, se `dispose` disparar isto antes da janela terminar.
      if (conv.deferred[phase]) this.start(convId, phase, this.emptyTurn(conv), true)
    })
    return true
  }

  /**
   * Agenda a retentativa de uma análise que passou do cooldown e não chegou ao
   * fim. Pelo MESMO caminho do flush do cooldown (turno vazio, `force`), então o
   * `dispose` a cancela e faz a última chance como já fazia com o flush.
   *
   * Três casos em que não agenda nada: a conversa não é mais esta (descartada
   * ou recriada enquanto a análise rodava — não há "depois" para ela, e um
   * temporizador aqui reviveria uma conversa morta); a fila ficou vazia (não
   * há o que julgar); ou o teto de retentativas seguidas já foi gasto. Já
   * havendo um flush agendado nesta fase, ele leva a evidência — sem segundo
   * temporizador, e sem gastar uma retentativa que não foi agendada.
   */
  private armRetry(convId: string, phase: PoPhase, conv: ConvState): void {
    if (this.state.get(convId) !== conv) return
    if (!conv.deferred[phase] || conv.retries[phase] >= PO_MAX_RETRIES) return
    if (this.armFlush(convId, phase, conv, PO_RETRY_DELAY_MS)) conv.retries[phase] += 1
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = {
        userText: null,
        cwd: '',
        calls: [],
        fired: false,
        reply: null,
        lastRunAt: { open: 0, close: 0 },
        deferred: { open: null, close: null },
        flushCancel: { open: null, close: null },
        retries: { open: 0, close: 0 },
        background: []
      }
      this.state.set(convId, conv)
    }
    return conv
  }

  /** Dispara uma análise e a registra como em voo até o fim das escritas.
   *  `force` pula o cooldown — só usado pelo próprio flush do cooldown
   *  (automático, retentativa ou última chance no `dispose`), nunca por um
   *  turno real; é também como `run` distingue um turno real de um flush.
   *  O registro em `inFlight` é SÍNCRONO, ainda no tick de quem chamou, sem
   *  `await` nenhum antes: é nisso que o `po.settled` do fechamento do quadro
   *  se apoia (ver o comentário em `po.observe`, no index.ts). */
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

  /** Uma linha no diário por rodada. Nunca lança: o diário é observação da
   *  observação, e não pode ser o que derruba a auditoria. */
  private logRound(entry: Omit<PoLogEntry, 'at' | 'durationMs'>, startedAt: number): void {
    try {
      const now = this.deps.now?.() ?? Date.now()
      this.deps.decisionLog?.({ at: new Date(now).toISOString(), durationMs: Math.max(0, now - startedAt), ...entry })
    } catch {
      // Diário que falha não é motivo para nada além de uma linha a menos.
    }
  }

  private nextCorrelationId(): string {
    return this.deps.newCorrelationId?.() ?? `po-${Date.now().toString(36)}-${this.correlations++}`
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
      conv.deferred[phase] = defer(conv.deferred[phase], turn)
      this.armFlush(convId, phase, conv, Math.max(0, PO_COOLDOWN_MS - (now - conv.lastRunAt[phase])))
      this.logRound({ conversationId: convId, phase, outcome: 'cooldown', route: null, cards: [] }, now)
      return
    }
    conv.lastRunAt[phase] = now
    // Esta análise já vai drenar a fila (real ou vazia) — um flush agendado
    // para o mesmo motivo (cooldown ou retentativa) não tem mais o que fazer.
    conv.flushCancel[phase]?.()
    conv.flushCancel[phase] = null
    // Um turno REAL rodando é a prova de que a conversa seguiu: a sequência de
    // falhas anterior não é mais "seguida", e esta análise ganha o teto inteiro.
    if (!force) conv.retries[phase] = 0

    // O acumulado sai da fila para entrar nesta análise, mas continua sendo
    // dela só enquanto ela andar: se não chegar ao fim, volta para a fila.
    // `tookQueue` separa "retirou uma fila vazia" (`taken` null) de "saiu antes
    // de retirar" — os dois devolvem o turno em lugares diferentes da fila.
    let taken: PoDeferred | null = null
    let tookQueue = false
    let audited = false
    // O que o diário registra desta rodada. `falha` é o padrão porque todo
    // caminho que não o sobrescreve é uma análise que não chegou ao fim
    // (consulta sem resposta, exceção).
    let outcome: PoLogOutcome = 'falha'
    let route: PoLogEntry['route'] = null
    const touched: string[] = []
    try {
      await this.deps.board.settled(convId)
      const cards = await this.deps.board.list(turn.cwd, { conversationId: convId })
      // `null` é quadro INDISPONÍVEL (sem repositório, pasta fora do ar): não há
      // o que ler nem onde escrever. `[]` é quadro VAZIO, e esse é justamente o
      // caso que a abertura existe para consertar — desistir dele era desistir
      // do pedido que nunca virou tarefa.
      if (!cards) {
        outcome = 'quadro-indisponivel'
        return
      }
      // O id do projeto não pode sair de `cards[0]`: no quadro vazio não existe
      // cards[0]. Vem da mesma identidade que o `list` usou, e sem ela não dá
      // para criar cartão nenhum.
      const projectId = await this.deps.board.projectId(turn.cwd)
      if (!projectId) {
        outcome = 'quadro-indisponivel'
        return
      }

      taken = conv.deferred[phase]
      conv.deferred[phase] = null
      tookQueue = true
      const merged = mergeDeferred(taken, turn)
      const ledgerTasks = await listConvTasks(this.deps, convId)
      const digestCards = cards.map((card) => ({
        id: card.id,
        title: card.poTitle ?? card.sourceTitle,
        status: card.poStatus ?? card.sourceStatus
      }))

      // O gate do TypeSafe vê o MESMO material que o modelo veria (pedido
      // mesclado, quadro, ações, registro, resposta) e roda antes de qualquer rota. Um
      // "não" é uma decisão sobre esta evidência: ela foi julgada, não volta
      // para a fila, e nada é escrito nem anunciado — o elenco não mostra uma
      // auditoria que não aconteceu. `null` (sem chave, desligado, erro) é
      // ausência de decisão, não "não": segue exatamente como sempre seguiu.
      const worthIt = await askBoardGate(this.deps, {
        phase,
        userText: merged.userText,
        cards: digestCards.map(({ title, status }) => ({ title, status })),
        calls: merged.calls,
        ledgerTasks,
        agentReply: merged.reply ?? null
      })
      if (worthIt === false) {
        audited = true
        outcome = 'gate-nao'
        return
      }

      const prompt = buildPoPrompt({
        userText: merged.userText,
        cards: digestCards,
        calls: [...merged.calls],
        phase,
        ledgerTasks,
        agentReply: merged.reply,
        // O turno real traz o snapshot do seu `result`; o sintético (flush,
        // retentativa, `dispose`) não tem instante próprio e usa o de agora.
        background: turn.background ?? conv.background
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

      diagnostic(this.deps, request, 'claude-started', 'claude')
      // From here the audit has started, so it must also announce its END —
      // otherwise the crew panel would show the PO working forever on any of
      // the early returns below. `provider` follows whichever route ran.
      let provider: 'claude' | 'gpt-luna' = 'claude'
      const progress: PoApplyProgress = { applied: 0, touched }
      try {
        // Claude primeiro; a Luna só numa falha Claude elegível (poProviders.ts).
        // A troca de rota é avisada ANTES da consulta à Luna, para o
        // `audit-finished` abaixo sair com a rota certa até se a Luna lançar.
        const text = await consultWithFailover(this.deps, request, () => {
          provider = 'gpt-luna'
        })
        if (text === null) return
        // Desligado DURANTE a consulta: o veredito chega, mas não escreve nada —
        // com o PO desligado o quadro é só do agente principal.
        if (!this.deps.config().po.enabled) {
          outcome = 'desligado'
          return
        }

        // A lista que o modelo julgou é de antes da consulta: criar e pôr em
        // andamento são conferidos de novo contra o quadro de agora (poApply.ts).
        const target = { convId, cwd: turn.cwd, projectId, phase, startedAt: now }
        await applyPoVerdict(this.deps, target, text, cards, progress)
        // Daqui em diante a análise chegou ao fim: o que ela tirou da fila foi
        // julgado e escrito, e não volta.
        audited = true
        outcome = progress.applied > 0 ? `ops=${progress.applied}` : 'ok'
      } finally {
        route = provider
        diagnostic(this.deps, request, 'audit-finished', provider, undefined, progress.applied)
      }
    } catch {
      // The observer cannot take down the observed turn or write a partial board.
    } finally {
      this.logRound({ conversationId: convId, phase, outcome, route, cards: touched }, now)
      if (audited) {
        conv.retries[phase] = 0
      } else {
        // Nem o acumulado nem o turno que disparou esta análise passaram pelo
        // PO: os dois voltam para a fila, na ordem cronológica (ver
        // `restoreTaken` e `requeueTurn`, em poQueue.ts, para o porquê de cada
        // caso). E voltar para a fila não basta: sem retentativa, a evidência
        // só seria julgada no PRÓXIMO turno — que o turno que encerrou a
        // conversa nunca tem.
        conv.deferred[phase] = tookQueue
          ? restoreTaken(conv.deferred[phase], taken, turn)
          : requeueTurn(conv.deferred[phase], turn)
        this.armRetry(convId, phase, conv)
      }
    }
  }
}

/** Compatibility alias used by existing tests and external imports. */
export const askPo = askObserver
