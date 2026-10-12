import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { ChatEvent } from '../../shared/ipc'
import type { HandoffRepository } from '../persistence/types'
import type { EntregaEstimateOutcome, EntregaEstimateRequest, EntregaTimeOutcome } from './entregaEstimate'
import { DEADLINE_NOTICE_TIMEOUT_MS, queuedNotice, type DeadlineFollowUp } from './handoffDeadline'
import { HandoffJobs, type HandoffBoard, type HandoffCorrection } from './handoffJobs'
import { handoffContentHash } from './handoffModel'
import { HandoffReconciler } from './handoffReconcile'
import * as rules from './handoffRules'
import { setActiveHandoffTracker } from './handoffRuntime'
import { closeSlice, ConvQueues, newConvState, rememberSend, resetTurnMarks, turnEnd, type ConvState } from './handoffState'
import { BOOT_GRACE_MS, loadKnownConversations, sweepConversations, type SweepContext } from './handoffTrackerSweep'

export type { HandoffBoard, HandoffCorrection } from './handoffJobs'
export { BOOT_GRACE_MS } from './handoffTrackerSweep'

/** Eventos de atividade do turno: o mesmo critério que abre o "em execução" no topo da conversa. */
const TURN_ACTIVITY: ReadonlySet<ChatEvent['kind']> = new Set(['assistant-text', 'thinking', 'tool-use', 'tool-result', 'status'])

/**
 * O acompanhamento dos envios de handoff pelo que o APP observa — nunca pela
 * palavra do modelo (card req-acompanhamento-app). Entradas (index.ts, só
 * conversas de handoff): o tee de eventos, o agent:send, as perguntas, o Quadro
 * e o registro dos envios. Invariantes, as do BoardService: nenhuma entrada
 * lança (banco fora só deixa de gravar) e uma escrita por vez por conversa — o
 * estado em memória (handoffState.ts) muda na hora, o job (handoffJobs.ts) grava
 * o decidido. Tempo ativo = turno rodando sem pergunta aberta; a fatia vai ao
 * banco a cada transição e passada da varredura. Regras em handoffRules.ts.
 */

export interface HandoffTrackerDeps {
  /** `null` sem banco gravável. Chamado a cada uso (o PostgreSQL reconecta). */
  repository(): HandoffRepository | null
  board: HandoffBoard
  /** PO ligado agora (`board.po.enabled`): vira `auditada` na conclusão. */
  poEnabled(): boolean
  /** Relógio injetável (ms). */
  clock?(): number
  /** Avisa o renderer (handoff:changed) depois de cada escrita. */
  onChanged?(conversationId: string): void
  log?(message: string): void
  /** Limite da parada; padrão HANDOFF_STALL_MS (10 min). */
  stallMs?: number
  /** Teto do aviso de prazo no hook; padrão DEADLINE_NOTICE_TIMEOUT_MS (2 s). */
  noticeTimeoutMs?: number
}

export class HandoffTracker {
  private readonly states = new Map<string, ConvState>()
  private readonly queues = new ConvQueues((convId, err) => this.warn(convId, err))
  /** O boot deste processo (ms): a carência (BOOT_GRACE_MS) da varredura e da fila do projeto conta daqui. */
  readonly startedAt: number
  private readonly stallMs: number
  private readonly jobs: HandoffJobs
  private readonly reconciler: HandoffReconciler

  constructor(private readonly deps: HandoffTrackerDeps) {
    this.startedAt = this.now()
    this.stallMs = deps.stallMs ?? rules.HANDOFF_STALL_MS
    const io = {
      repo: () => this.repo(),
      board: deps.board,
      now: () => this.now(),
      poEnabled: () => this.poEnabled(),
      changed: (convId: string) => this.changed(convId),
      warn: (where: string, err: unknown) => this.warn(where, err)
    }
    this.jobs = new HandoffJobs({ ...io, state: (convId) => this.states.get(convId), stallMs: this.stallMs })
    this.reconciler = new HandoffReconciler({ ...io, states: () => this.states, exclusive: (convId, job) => this.exclusive(convId, job) })
    // O servidor MCP `entregas` das sessões de handoff o acha por aqui
    // (handoffRuntime.ts) — o último criado é o do processo.
    setActiveHandoffTracker(this)
  }

  // -------------------------------------------------------------------------
  // Entradas (nunca lançam)
  // -------------------------------------------------------------------------

  /** A sessão de handoff subiu: a conversa passa a ser acompanhada. */
  attach(convId: string, cwd: string): void {
    this.guard('attach', () => void this.state(convId, cwd, true))
  }

  /** O tee de eventos. `turn-start`, `result`, `error`, `task-list` e a atividade do turno importam. */
  observe(convId: string, cwd: string, event: ChatEvent): void {
    if (TURN_ACTIVITY.has(event.kind)) return this.noteActivity(convId)
    if (event.kind !== 'turn-start' && event.kind !== 'result' && event.kind !== 'error' && event.kind !== 'task-list') return
    this.guard('observe', () => {
      const at = this.now()
      const s = this.state(convId, cwd, true)
      s.lastActivity = at
      // A releitura vem pelo Quadro (boardChanged) depois de o snapshot ser gravado.
      if (event.kind === 'task-list') return this.flushBeforeCards(convId)
      if (event.kind === 'turn-start') {
        // Um turno novo (o usuário retomou): o Stop do anterior deixa de valer.
        resetTurnMarks(s)
        return this.openTurn(convId, s, at)
      }
      // `result`/`error` encerram o turno — e as pendências: há resoluções
      // silenciosas (Permitir tudo, descarte) que não passam por notePermission.
      const ms = closeSlice(s, at, () => {
        s.turnRunning = false
        s.pending.clear()
      })
      const end = turnEnd(s)
      if (event.kind === 'result') {
        // Turno parado ou cortado pelo Scrum Master: o fim dele não é erro (nem conclui o que faltou).
        const turnError = event.isError && !end.stopped && !end.cut ? event.text.trim() || 'erro sem texto' : null
        return this.enqueue(convId, async () => {
          await this.jobs.addTime(convId, ms)
          await this.jobs.result(convId, at, turnError, end)
        })
      }
      const recoverable = rules.isRecoverableError(event)
      this.enqueue(convId, async () => {
        await this.jobs.addTime(convId, ms)
        await this.jobs.error(convId, event.text, recoverable, end)
      })
    })
  }

  /** Atividade do turno (texto, ferramenta, status). Sem `turn-start` (o CLI não ecoou o
   *  id do turno), a primeira atividade abre o turno — o mesmo critério do topo da conversa.
   *  Só conversa já acompanhada, e nunca o rabo de um turno parado pelo Stop. */
  private noteActivity(convId: string): void {
    this.guard('noteActivity', () => {
      const s = this.states.get(convId)
      if (!s) return
      const at = this.now()
      s.lastActivity = at
      if (!s.turnRunning && !s.stoppedByUser) this.openTurn(convId, s, at)
    })
  }

  /** Abre o turno: fecha a fatia anterior e começa a contar o tempo ativo. */
  private openTurn(convId: string, s: ConvState, at: number): void {
    // Também o turno aberto pela atividade (sem `turn-start`): o corte do anterior acabou.
    s.scrumCut = false
    const ms = closeSlice(s, at, () => {
      if (!s.turnRunning) s.turnStartedAt = at
      s.turnRunning = true
    })
    this.enqueue(convId, async () => {
      await this.jobs.addTime(convId, ms)
      await this.jobs.turnStart(convId, at)
    })
  }

  /** O agent:send recebeu `text` CRU. Só conversa de handoff; a outra nem é olhada. */
  noteUserSend(convId: string, text: string): void {
    this.guard('noteUserSend', () => {
      const s = this.states.get(convId)
      if (!s || typeof text !== 'string') return
      const at = this.now()
      s.lastActivity = at
      const seen = rememberSend(s, handoffContentHash(text), at)
      this.enqueue(convId, () => this.jobs.matchSent(convId, seen))
    })
  }

  /** Pergunta (AskUserQuestion) ou permissão aberta (`true`) ou fechada (`false`). */
  notePermission(convId: string, id: string, pending: boolean, toolName = ''): void {
    this.updatePending(convId, (map) => {
      if (pending) map.set(id, toolName)
      else map.delete(id)
    })
  }

  /** "Permitir tudo" aprova em silêncio as permissões abertas — não as perguntas. */
  noteBypass(convId: string, on: boolean): void {
    if (!on) return
    this.updatePending(convId, (map) => {
      for (const [id, tool] of map) if (tool !== 'AskUserQuestion') map.delete(id)
    })
  }

  /** Stop do usuário (não é erro): o envio fica PARADO e a fila espera até um turno novo ou o "mesmo assim".
   *  `motivo`: a parada do Scrum Master (no lugar de STOP_MOTIVO), pelo mesmo caminho. */
  noteStop(convId: string, motivo: string | null = null): void {
    const s = this.states.get(convId)
    if (!s) return
    Object.assign(s, { stoppedByUser: true, stopMotivo: motivo, scrumCut: false })
    // O Stop que pega o prompt antes de o turno começar não rende `result`: o job cobre.
    this.guard('noteStop', () => this.enqueue(convId, () => this.jobs.stopped(convId, motivo)))
  }

  /** O Scrum Master vai cortar o turno (`true`, ANTES de interromper: o `result` pode
   *  chegar antes do recibo) ou o pedido não pegou (`false`). O fim cortado não fecha o envio. */
  noteScrumCut(convId: string, on: boolean): void {
    const s = this.states.get(convId)
    if (s) s.scrumCut = on && !s.stoppedByUser
  }

  /** O último turno da conversa foi parado pelo usuário (a fila do quadro espera ele). */
  stoppedByUser(convId: string): boolean {
    return this.states.get(convId)?.stoppedByUser === true
  }

  /** Sessão descartada (descarte, lease perdido, troca de sessão): não sai `result`
   *  nem `error`, mas o turno acabou. Com o turno ABERTO em memória, o envio que
   *  rodava fica parado por inatividade (a fila retoma sozinha); a sessão nova de
   *  uma troca reabre com o próprio turn-start. Sem turno, nada a encerrar. */
  sessionEnded(convId: string): void {
    const s = this.states.get(convId)
    if (!s) return
    this.guard('sessionEnded', () => {
      const wasRunning = s.turnRunning
      const ms = closeSlice(s, this.now(), () => {
        s.turnRunning = false
        s.pending.clear()
      })
      this.enqueue(convId, async () => {
        await this.jobs.addTime(convId, ms)
        if (wasRunning) await this.jobs.sessionEnded(convId, s.stoppedByUser, s.stopMotivo)
        else await this.jobs.permission(convId)
      })
    })
  }

  /** A conversa foi apagada: os envios abertos dela param e ela deixa de ser acompanhada. */
  conversationDeleted(convId: string): void {
    this.guard('conversationDeleted', () => {
      this.enqueue(convId, () => this.jobs.conversationDeleted(convId))
      this.states.delete(convId)
    })
  }

  /** Envios recém-registrados (handoff:register): o texto que JÁ saiu casa agora. */
  onRegistered(envios: readonly HandoffEnvio[]): void {
    this.guard('onRegistered', () => {
      const convs = new Set<string>()
      for (const envio of envios) {
        const s = this.state(envio.conversationId, envio.projectCwd, false)
        s.projectId = envio.projectId
        s.lastActivity = this.now()
        convs.add(envio.conversationId)
      }
      for (const convId of convs) {
        this.changed(convId)
        this.enqueue(convId, () => this.jobs.matchSent(convId, null))
      }
    })
  }

  /** O despachante da fila do quadro vai mandar `envioId` (marcado pelo id, ver
   *  HandoffJobs.dispatched). `false`: já tinha saído, ou sem banco. */
  dispatched(convId: string, envioId: string): Promise<boolean> {
    const at = this.now()
    const s = this.states.get(convId)
    if (s) s.lastActivity = at
    return this.exclusive(convId, () => this.jobs.dispatched(convId, envioId, at)).catch(() => false)
  }

  /** O despacho falhou no renderer depois da marca: o envio volta à fila (HandoffJobs.undispatched). */
  undispatched(convId: string, envioId: string): Promise<boolean> {
    return this.exclusive(convId, () => this.jobs.undispatched(convId, envioId)).catch(() => false)
  }

  /** O Quadro do projeto mudou (sync, PO, arrasto): o reconciliador relê o
   *  projeto inteiro — não só as conversas em memória. */
  boardChanged(projectId: string): void {
    this.guard('boardChanged', () => {
      for (const [convId, s] of this.states) if (s.projectId === projectId) this.flushBeforeCards(convId)
      this.reconciler.schedule(projectId)
    })
  }

  // -------------------------------------------------------------------------
  // Para o IPC, a varredura e as peças seguintes (estimativa, prazo)
  // -------------------------------------------------------------------------

  /**
   * A correção manual de uma entrega. Rejeita com a mensagem (o IPC a devolve).
   * A marca `corrigido_por` vai primeiro, fora da fila: a partir dela nenhuma
   * releitura do Quadro mexe na entrega. O resto entra na fila da conversa, depois
   * de qualquer job em voo — é a correção que grava por último.
   */
  async correctEntrega(req: HandoffCorrection): Promise<HandoffEnvio> {
    const repo = this.repo()
    if (!repo) throw new Error('O banco está indisponível agora.')
    const at = new Date(this.now()).toISOString()
    const marked = await repo.updateHandoffEntrega(req.entregaId, { corrigidoPor: 'usuario', corrigidoEm: at })
    return this.exclusive(marked.conversationId, () => this.jobs.correct(marked.conversationId, marked.id, req, at))
  }

  /** O envio corrente da conversa (o mais recente já enviado), ou `null`; `live`: com o tempo ativo em curso. */
  async currentEnvio(convId: string, live = false): Promise<HandoffEnvio | null> {
    try {
      return await this.jobs.currentEnvio(convId, live ? this.unflushedActiveMs(convId) : 0)
    } catch (err) {
      this.warn('currentEnvio', err)
      return null
    }
  }

  /** Para o PO no fechamento (HandoffJobs — fora da fila, nunca lançam): as etapas do envio
   *  corrente sem cartão no Quadro, e o placar inteiro dele (toda etapa, com cartão e aceite). */
  orphanEtapas = (convId: string) => this.jobs.orphanEtapas(convId)
  envioEtapas = (convId: string) => this.jobs.envioEtapas(convId)

  isTurnRunning(convId: string): boolean {
    return this.states.get(convId)?.turnRunning ?? false
  }

  /** A última atividade da conversa vista NESTE processo (ms); `null` sem nenhuma. */
  lastActivityMs(convId: string): number | null {
    const at = this.states.get(convId)?.lastActivity ?? 0
    return at > 0 ? at : null
  }

  /** Tempo ativo da conversa ainda não gravado (para o prazo em tempo real). */
  unflushedActiveMs(convId: string): number {
    const s = this.states.get(convId)
    if (!s) return 0
    return s.carryMs + s.cardsMs + (s.activeSince === null ? 0 : Math.max(0, this.now() - s.activeSince))
  }

  /**
   * `entrega_estimar`: a estimativa da IMPLEMENTAÇÃO para uma etapa do envio
   * corrente. Grava só os campos `estimativa_agente*` — o prazo (a estimativa do
   * plano) não muda —, na fila da conversa, e avisa a tela. Chamar de novo
   * sobrescreve, com o motivo novo. Rejeita só se o banco recusar a escrita.
   */
  estimateEntrega(convId: string, req: EntregaEstimateRequest): Promise<EntregaEstimateOutcome> {
    return this.exclusive(convId, () => this.jobs.estimate(convId, req))
  }

  /**
   * `entrega_tempo`: o tempo ativo de uma etapa do envio corrente (sem `etapa`,
   * a atual) pela medição do app — o gravado mais a fatia em curso. Lê NA FILA:
   * o que a conversa já ia gravar (a fatia de um cartão que acabou de mudar)
   * entra antes da leitura.
   */
  entregaTime(convId: string, etapa: string | null): Promise<EntregaTimeOutcome> {
    return this.exclusive(convId, () => this.jobs.entregaTime(convId, etapa, () => this.unflushedActiveMs(convId)))
  }

  /**
   * O aviso de prazo ao agente (hook PostToolUse da sessão de handoff): o texto
   * do marco de 80% ou 100% da etapa em andamento, uma vez por marco, ou `null`.
   * Rápido: entre os marcos não toca o banco (`noticeAt`); com leitura, espera
   * no máximo o teto e segue sem aviso — o que ficar pronto depois sai na
   * próxima ferramenta. Nunca lança. `followUp`: o que o de 100% promete depois
   * do estouro (a config do Scrum Master).
   */
  async deadlineNotice(convId: string, followUp: DeadlineFollowUp = 'nenhum'): Promise<string | null> {
    const s = this.states.get(convId)
    if (!s) return null
    const read = (): Promise<string | null> => this.jobs.deadlineNotice(convId, this.unflushedActiveMs(convId), followUp)
    try {
      return await queuedNotice(s, this.now(), this.deps.noticeTimeoutMs ?? DEADLINE_NOTICE_TIMEOUT_MS, (job) => this.exclusive(convId, job), read)
    } catch (err) {
      this.warn('deadlineNotice', err)
      return null
    }
  }

  /** Roda `job` na fila de escrita da conversa (depois do que já está nela). */
  exclusive<T>(convId: string, job: () => Promise<T>): Promise<T> {
    return this.queues.run(convId, job)
  }

  /** Espera a fila (de uma conversa ou de todas, com o reconciliador) esvaziar — teste e varredura. */
  async settled(convId?: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const pending = convId ? this.queues.pending(convId) : [...this.queues.pending(), ...this.reconciler.pending()]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  /** A carga das conversas com envio em curso (boot) e a passada da varredura — handoffTrackerSweep.ts. */
  loadKnown(): Promise<boolean> {
    return loadKnownConversations(this.sweepContext())
  }

  sweep(): Promise<{ flushed: number; stalled: number }> {
    return sweepConversations(this.sweepContext())
  }

  private sweepContext(): SweepContext {
    return {
      states: this.states,
      state: (convId, cwd) => this.state(convId, cwd, false),
      jobs: this.jobs,
      reconciler: this.reconciler,
      exclusive: (convId, job) => this.exclusive(convId, job),
      repo: () => this.repo(),
      now: () => this.now(),
      notBefore: this.startedAt + BOOT_GRACE_MS,
      stallMs: this.stallMs
    }
  }

  // -------------------------------------------------------------------------
  // Miúdos
  // -------------------------------------------------------------------------

  private state(convId: string, cwd: string, fromSession: boolean): ConvState {
    let s = this.states.get(convId)
    if (!s) {
      // Sem atividade vista ainda (0): subir a sessão não é atividade — quem
      // vê um evento marca a sua; sem nenhum, a parada é julgada pelo banco.
      s = newConvState(cwd, 0)
      this.states.set(convId, s)
    } else if (cwd && (fromSession || !s.cwd)) {
      // A pasta da SESSÃO é a do Quadro da conversa (board.observe usa a mesma).
      s.cwd = cwd
    }
    return s
  }

  private updatePending(convId: string, mutate: (map: Map<string, string>) => void): void {
    const s = this.states.get(convId)
    if (!s) return
    this.guard('notePermission', () => {
      const at = this.now()
      s.lastActivity = at
      const before = s.pending.size > 0
      const ms = closeSlice(s, at, () => mutate(s.pending))
      if (before === s.pending.size > 0 && ms === 0) return
      this.enqueue(convId, async () => {
        await this.jobs.addTime(convId, ms)
        await this.jobs.permission(convId)
      })
    })
  }

  /** O cartão mudou: a fatia até aqui é das entregas como estavam ANTES da
   *  mudança, então é gravada antes da releitura (que entra na fila depois). */
  private flushBeforeCards(convId: string): void {
    const s = this.states.get(convId)
    if (!s) return
    s.cardsMs += closeSlice(s, this.now())
    // Já há uma gravação esperando na fila: ela leva esta fatia também.
    if (s.cardsQueued) return
    s.cardsQueued = true
    this.enqueue(convId, async () => {
      s.cardsQueued = false
      const ms = s.cardsMs
      s.cardsMs = 0
      await this.jobs.addTime(convId, ms)
    })
  }

  private enqueue(convId: string, job: () => Promise<void>): void {
    this.exclusive(convId, job).catch(() => undefined)
  }

  private repo(): HandoffRepository | null {
    try {
      return this.deps.repository()
    } catch {
      return null
    }
  }

  private poEnabled(): boolean {
    try {
      return this.deps.poEnabled()
    } catch {
      return false
    }
  }

  private changed(convId: string): void {
    // Toda escrita pode mudar a etapa em andamento ou o tempo: o aviso relê.
    const s = this.states.get(convId)
    if (s) s.noticeAt = 0
    try {
      this.deps.onChanged?.(convId)
    } catch {
      // Aviso para a tela; nunca derruba o acompanhamento.
    }
  }

  private guard(where: string, run: () => void): void {
    try {
      run()
    } catch (err) {
      this.warn(where, err)
    }
  }

  private warn(where: string, err: unknown): void {
    const text = `[handoff] ${where}: ${err instanceof Error ? err.message : String(err)}`
    try {
      ;(this.deps.log ?? console.warn)(text)
    } catch {
      // Sem log não há o que fazer.
    }
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now()
  }
}
