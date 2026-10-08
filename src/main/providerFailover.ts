import { randomUUID } from 'node:crypto'
import { isOpenAIModel, MODEL_EFFORT, modelSupportsFastMode } from '../shared/ipc'
import type { ChatEvent, StartAgentOptions, UsageProvider } from '../shared/ipc'
import type { AgentSession } from './agentSession'
import { appRestart } from './appRestartRuntime'
import type { AccountSwitchDeps } from './accounts/switchDeps'
import { DEFAULT_ACCOUNT_ID } from './accounts/registry'
import { logSession } from './sessionLog'

export const FAILOVER_CONTINUATION = '[PROVIDER_CONTINUATION]\n' +
  'O provedor anterior ficou sem limite de uso. Continue a tarefa pendente do usuário a partir do histórico desta mesma sessão, ' +
  'preservando requisitos, arquivos, plano e resultados de ferramentas. Verifique o estado atual antes de repetir qualquer ação ' +
  'com efeito externo; não repita trabalho já concluído. A troca de provedor não altera as instruções nem autorizações do usuário.\n' +
  '[/PROVIDER_CONTINUATION]'

/**
 * Continuação para a conta/provedor novo. Com trabalho em background derrubado
 * pela troca, diz qual era e que ele NÃO terminou.
 */
export function failoverContinuation(interrupted: readonly string[] | null): string {
  if (!interrupted) return FAILOVER_CONTINUATION
  const what = interrupted.length ? interrupted.map((task) => `- ${task}`).join('\n') : '- (sem descrição disponível)'
  return FAILOVER_CONTINUATION.replace('\n[/PROVIDER_CONTINUATION]',
    '\nAtenção: a troca encerrou o processo anterior e interrompeu o trabalho em background que ainda rodava:\n' + what +
    '\nEsse trabalho não terminou e o resultado dele não está no histórico. Verifique o estado atual e, se ainda for ' +
    'necessário para a tarefa, execute-o de novo.\n[/PROVIDER_CONTINUATION]')
}

/**
 * Chamada de ferramenta autônoma ainda sem resultado: o sinal estruturado
 * `restartActivity().autonomousCallOpen` do `AgentSession` (`restartOpaqueCalls`).
 * Um comando destacado já concluído (`restartUncertain`) não liga o sinal.
 */
export const OPAQUE_CALL_TASK = 'trabalho iniciado por uma ferramenta, ainda sem confirmação de término'

/** O aviso ao usuário, junto da nota da troca. */
function interruptedNote(interrupted: readonly string[] | null): string {
  if (!interrupted) return ''
  const what = interrupted.length ? ` (${interrupted.join('; ')})` : ''
  return ` Atenção: o trabalho em background que ainda rodava${what} foi interrompido pela troca; pedi para a nova sessão verificar e refazer o que for preciso.`
}

type Session = Pick<AgentSession, 'start' | 'send' | 'dispose' | 'interrupt' | 'setBypass' | 'resolvePermission' | 'holdQuestion' | 'refreshUsage' | 'waitForIdle' | 'resumeAfterQuota' | 'continuationState' | 'restoreContinuation'> &
  Partial<Pick<AgentSession, 'hasBackgroundWork' | 'isAlive' | 'injectNow' | 'storageRestored' | 'restartActivity'>>
type Factory = (options: StartAgentOptions, emit: (event: ChatEvent) => void, complete: () => void) => Session

/** Troca de conta com o turno fechado: a de fim de turno e a manual do painel. */
type PendingAccountSwitch = { to: string; reason: 'turn-end' | 'manual'; text: string; continueTask: boolean }
/** O terminal de estouro que disparou a troca. */
type QuotaEvent = Extract<ChatEvent, { kind: 'result' | 'error' }>

/** Claude estourou e não há outra conta nem provedor para continuar. */
class NoDestination extends Error {}

/** Destino GPT da troca automática por cota: o Sol 6.1 entrega perto do Astra
 *  gastando bem menos da assinatura — o Astra não compensa como reserva. */
export const FAILOVER_GPT_MODEL = 'gpt-6.1-sol'

export function providerForModel(model?: string): UsageProvider | null {
  if (isOpenAIModel(model)) return 'gpt'
  return !model || model.startsWith('claude-') ? 'claude' : null
}

/** One logical chat owns successive SDK processes. Only quota terminal events
 * and account switches replace the process; the SDK transcript, attachments and
 * tool results survive (sessionStore + resume — no transcript is copied). */
export class ProviderFailoverSession {
  private current!: Session
  private options: StartAgentOptions
  private generation = 0
  private turn = 0
  private stopped = false
  private disposed = false
  private switching: Promise<void> | null = null
  private tried = new Set<UsageProvider>()
  /** Contas Claude que já entraram neste turno: cada uma, uma vez (sem laço). */
  private triedAccounts = new Set<string>()
  private lastModels: Partial<Record<UsageProvider, string>> = {}
  private restartRegistration?: { remove(): void }
  /** Turno do usuário em andamento (entre `send` e o `result`/`error`). */
  private turnOpen = false
  private pending: PendingAccountSwitch | null = null
  private checking = false
  /** Último retrato das tarefas em background do processo atual. */
  private backgroundTasks: string[] = []
  /** O turno é de uma tarefa MCP que pediu o modelo: a troca por cota não muda
   *  modelo nem provedor (troca de conta Claude, com o mesmo modelo, continua). */
  private modelPinned = false

  constructor(
    options: StartAgentOptions,
    private readonly factory: Factory,
    private readonly emit: (event: ChatEvent) => void,
    private readonly available: (provider: UsageProvider) => Promise<boolean>,
    private readonly complete: () => void | Promise<void>,
    /** Várias contas Claude. Ausente (ou uma conta só): tudo como antes. */
    private readonly accounts?: AccountSwitchDeps
  ) {
    this.options = { ...options }
    this.restartRegistration = appRestart?.register(`${options.convId} (failover)`, () => ({ busy: !!this.switching }))
    this.create()
  }

  private accountId(): string {
    return this.options.claudeAccountId ?? DEFAULT_ACCOUNT_ID
  }

  /** A troca entre contas vale aqui? Claude, mais de uma conta. */
  private accountsInPlay(): boolean {
    return !!this.accounts?.multiple() && providerForModel(this.options.model) === 'claude'
  }

  private create(): void {
    const generation = ++this.generation
    // As tarefas em background morrem com o processo anterior.
    this.backgroundTasks = []
    let quotaTerminal = false
    let handledQuotaTurn = -1
    const onEvent = (event: ChatEvent): void => {
      if (generation !== this.generation || this.disposed) return
      if (event.kind === 'background-tasks') this.backgroundTasks = event.tasks.map((task) => task.description.trim() || task.type)
      if ((event.kind === 'result' || event.kind === 'error') && event.usageExhausted && !this.stopped && providerForModel(this.options.model)) {
        const turn = this.turn
        if (handledQuotaTurn === turn) return
        quotaTerminal = true
        if (!this.switching) {
          handledQuotaTurn = turn
          // Defer work until switching is assigned, even with synchronous fakes.
          this.switching = Promise.resolve().then(() => this.switchProvider(generation, event)).finally(() => {
            this.switching = null
            appRestart?.changed()
          })
        } else {
          void this.switching.then(() => { if (this.turn === turn) onEvent(event) })
        }
        return
      }
      this.emit(event)
      if (event.kind === 'result' || event.kind === 'error') {
        this.turnOpen = false
        // O modelo fixado vale só para o turno da tarefa: o seguinte (mensagem do
        // usuário, turno autônomo) nasce livre — o `agent:send` refixa.
        this.modelPinned = false
        if (event.kind === 'result' && !event.isError && !this.stopped) this.checkTurnEnd()
        this.tryPending()
      } else if (event.kind === 'mirror-repair' && event.state === 'deferred') {
        // O envio voltou para a fila sem abrir turno (reparo do espelho pendente).
        this.turnOpen = false
      } else if (event.kind === 'background-tasks' && event.tasks.length === 0) {
        // A tarefa em background acabou: a troca adiada pode acontecer agora.
        this.tryPending()
      }
    }
    this.current = this.factory(this.options, onEvent, () => {
      // The failed process's lease belongs to the replacement until it finishes.
      if (this.switching) {
        void this.switching.then(() => {
          if (!quotaTerminal && generation === this.generation && !this.disposed) void this.complete()
        })
        return
      }
      if (generation === this.generation && !this.disposed) void this.complete()
    })
  }

  /**
   * Troca o processo mantendo o histórico: espera o turno fechar e o espelho do
   * transcript ser verificado, sobe outro processo com `resume` e o `patch`
   * aplicado. `null` quando a troca perdeu a vez (sessão descartada/parada).
   */
  private async replace(
    previous: Session,
    patch: (resume: string) => Partial<StartAgentOptions>,
    active: () => boolean,
    continuing: boolean
  ): Promise<boolean> {
    // Await the eager mirror verification before disposing the old writer.
    const resume = await previous.resumeAfterQuota()
    if (!active()) return false
    this.options = { ...this.options, ...patch(resume) }
    const continuation = previous.continuationState()
    logSession('session-replaced', {
      convId: this.options.convId, reason: 'failover', background: !!previous.hasBackgroundWork?.(),
      model: this.options.model, effort: this.options.effort, account: this.options.claudeAccountId
    })
    previous.dispose()
    this.create()
    const nextGeneration = this.generation
    if (!(await this.current.start())) throw new Error('Não foi possível iniciar a sessão na nova conta/provedor. A tarefa foi preservada.')
    if (this.disposed || this.stopped || nextGeneration !== this.generation) return false
    this.current.restoreContinuation(continuation, continuing)
    return true
  }

  /**
   * O trabalho em background que a troca por estouro vai derrubar, ou `null`.
   *
   * Aqui a troca NÃO espera o background (ao contrário do `tryPending`): a
   * tarefa do usuário está parada sem limite, o background pode nunca terminar
   * (servidor de dev, watch) e um subagente em background da conta esgotada bate
   * no mesmo limite. Então troca já, avisa o usuário e conta à sessão nova o que
   * foi interrompido. Uma chamada autônoma ainda sem resultado
   * (`restartActivity().autonomousCallOpen`) também conta: ela morre com o
   * processo e precisa ser avisada.
   */
  private interruptedBackground(previous: Session): string[] | null {
    if (!previous.hasBackgroundWork?.()) return null
    const opaqueCall = previous.restartActivity?.().autonomousCallOpen === true
    return opaqueCall ? [...this.backgroundTasks, OPAQUE_CALL_TASK] : [...this.backgroundTasks]
  }

  private async switchProvider(generation: number, trigger: QuotaEvent): Promise<void> {
    const previous = this.current
    const from = providerForModel(this.options.model)
    const active = (): boolean => !this.disposed && !this.stopped && generation === this.generation
    let accountsNote = ''
    // Sem destino para o Claude: vale o aviso de limite de sempre (ver o catch).
    const noDestination = (message: string): Error => (from === 'claude' ? new NoDestination(accountsNote + message) : new Error(message))
    try {
      appRestart?.assertOpen()
      if (!from) throw new Error('Não há troca automática para este provedor.')
      // Várias contas Claude: primeiro as outras contas, uma vez cada; o GPT só
      // quando todas estouraram.
      if (from === 'claude' && this.accountsInPlay() && this.accounts) {
        const exhausted = this.accountId()
        this.triedAccounts.add(exhausted)
        // Fora da escolha até o reset, mesmo que a consulta de consumo falhe.
        this.accounts.markExhausted?.(exhausted, trigger.text)
        const target = await this.accounts.exhaustedTarget(exhausted, this.options.model, this.triedAccounts)
        console.log(`[contas] conversa ${this.options.convId}: conta ${exhausted} estourou → ${target ? `conta ${target.to} (${Math.round(target.toPct)}%)` : 'nenhuma outra com folga'}`)
        if (!this.accounts.autoEnabled()) {
          // Interruptor desligado: nada troca sozinho. A tarefa fica preservada
          // e o chat oferece "Continuar na conta X".
          this.emit({ kind: 'error', id: randomUUID(), usageExhausted: true, retryable: false,
            text: `A conta ${this.accounts.label(exhausted)} atingiu o limite de uso. A tarefa foi preservada.` })
          if (target) {
            this.emit({ kind: 'account-switch', id: randomUUID(), reason: 'suggest', fromAccountId: exhausted, toAccountId: target.to,
              text: `A conta ${this.accounts.label(target.to)} ainda tem folga (${Math.round(target.toPct)}% usado).` })
          }
          this.turnOpen = false
          this.modelPinned = false
          await this.complete()
          return
        }
        if (target) {
          if (!active()) return
          const interrupted = this.interruptedBackground(previous)
          if (!(await this.replace(previous, (resume) => ({ claudeAccountId: target.to, resume }), active, true))) return
          this.triedAccounts.add(target.to)
          this.accounts.changed(target.to)
          this.emit({ kind: 'account-switch', id: randomUUID(), reason: 'exhausted', fromAccountId: exhausted, toAccountId: target.to,
            text: `A conta ${this.accounts.label(exhausted)} atingiu o limite. Continuei na conta ${this.accounts.label(target.to)}.${interruptedNote(interrupted)}` })
          await this.current.send(failoverContinuation(interrupted), undefined, randomUUID(), 'pc', 'recovery')
          return
        }
        // Todas as contas Claude estouraram: segue para o GPT (a troca de sempre).
        accountsNote = 'Nenhuma outra conta Claude tem limite disponível. '
      }
      if (this.modelPinned) {
        throw new Error(`${accountsNote}A cota do modelo ${this.options.model ?? 'claude-opus-5-5'} acabou. A tarefa pediu esse modelo, ` +
          'então não troquei de modelo nem de provedor. Tente de novo quando o limite renovar.')
      }
      this.tried.add(from)
      const to = from === 'claude' ? 'gpt' : 'claude'
      if (this.tried.has(to)) throw noDestination('Claude e GPT atingiram o limite de uso. A tarefa foi preservada; aguarde a renovação dos limites.')
      if (!(await this.available(to))) throw noDestination(`O limite de uso foi atingido e ${to === 'gpt' ? 'o ChatGPT' : 'o Claude'} não está conectado. A tarefa foi preservada; aguarde a renovação dos limites.`)
      if (!active()) return
      const fromModel = this.options.model ?? 'claude-opus-5-5'
      this.lastModels[from] = fromModel
      const model = this.lastModels[to] ?? (to === 'gpt' ? FAILOVER_GPT_MODEL : 'claude-opus-5-5')
      const effort = this.options.effort
      const interrupted = this.interruptedBackground(previous)
      const switched = await this.replace(previous, (resume) => ({
        model, resume,
        effort: effort && MODEL_EFFORT[model]?.some((level) => level === effort) ? effort : 'high',
        fastMode: this.options.fastMode === true && modelSupportsFastMode(model)
      }), active, true)
      if (!switched) return
      this.tried.add(to)
      this.emit({
        kind: 'provider-switch', id: randomUUID(), fromModel, model, effort: this.options.effort,
        fastMode: this.options.fastMode === true,
        text: `O limite de uso de ${fromModel} foi atingido. Troquei automaticamente para ${model} e vou continuar a tarefa.${interruptedNote(interrupted)}`
      })
      await this.current.send(failoverContinuation(interrupted), undefined, randomUUID(), 'pc', 'recovery')
    } catch (error) {
      if (this.disposed || this.stopped) return
      this.turnOpen = false
      this.modelPinned = false
      if (error instanceof NoDestination) {
        // O mesmo terminal de limite que o renderer já trata (texto do CLI com o
        // horário do reset → nova tentativa na hora certa), mais a explicação.
        this.emit({ ...trigger, id: randomUUID(), text: trigger.text ? `${trigger.text}\n${error.message}` : error.message })
      } else {
        this.emit({ kind: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error), retryable: false })
      }
      await this.complete()
    }
  }

  /**
   * Fim de turno: a conta da conversa em 95%+ → consulta as outras e agenda a
   * troca silenciosa para a de menor consumo. Não atrasa o envio: se o usuário
   * mandar outra mensagem durante a consulta, a decisão é descartada e volta a
   * ser feita no fim do próximo turno.
   */
  private checkTurnEnd(): void {
    const accounts = this.accounts
    if (!accounts || !this.accountsInPlay() || !accounts.autoEnabled() || this.checking || this.pending) return
    const turn = this.turn
    const from = this.accountId()
    this.checking = true
    void accounts
      .turnEndTarget(from, this.options.model)
      .then((target) => {
        if (!target || this.disposed || this.turn !== turn || this.accountId() !== from) return
        this.pending = {
          to: target.to,
          reason: 'turn-end',
          continueTask: false,
          text: `Troquei para a conta ${accounts.label(target.to)} (${Math.round(target.toPct)}% usado) — a conta ${accounts.label(from)} estava em ${Math.round(target.fromPct)}%.`
        }
        this.tryPending()
      })
      .catch((error) => console.warn('[contas] verificação de fim de turno falhou:', (error as Error)?.message ?? error))
      .finally(() => {
        this.checking = false
      })
  }

  /** Executa a troca agendada se o turno está fechado e não há trabalho em background. */
  private tryPending(): void {
    const pending = this.pending
    if (!pending || this.switching || this.disposed || this.turnOpen) return
    // Trocar derruba o processo e mataria a tarefa em background: adia.
    if (this.current.hasBackgroundWork?.()) return
    this.pending = null
    const generation = this.generation
    this.switching = Promise.resolve().then(() => this.switchAccountIdle(generation, pending)).finally(() => {
      this.switching = null
      appRestart?.changed()
    })
  }

  private async switchAccountIdle(generation: number, pending: PendingAccountSwitch): Promise<void> {
    const accounts = this.accounts
    if (!accounts) return
    const previous = this.current
    const from = this.accountId()
    const active = (): boolean => !this.disposed && generation === this.generation
    try {
      appRestart?.assertOpen()
      // O turno fechou e soltou o lease; a verificação do histórico precisa dele.
      await accounts.acquire?.()
      // Conferido de novo na hora da troca (ela pode ter ficado agendada): o
      // turno preservado era de uma tarefa MCP que terminou em erro? Então a
      // conta troca, mas o turno NÃO continua — o aviso diz por quê.
      const refused = pending.continueTask ? accounts.continueRefused?.() ?? null : null
      const continueTask = pending.continueTask && !refused
      if (!(await this.replace(previous, (resume) => ({ claudeAccountId: pending.to, resume }), active, continueTask))) return
      accounts.changed(pending.to)
      const text = refused ? `Esta conversa passou a usar a conta ${accounts.label(pending.to)}. ${refused}` : pending.text
      this.emit({ kind: 'account-switch', id: randomUUID(), reason: pending.reason, fromAccountId: from, toAccountId: pending.to, text })
      if (continueTask) {
        this.turnOpen = true
        await this.current.send(FAILOVER_CONTINUATION, undefined, randomUUID(), 'pc', 'recovery')
      } else {
        await this.complete()
      }
    } catch (error) {
      if (this.disposed) return
      this.emit({ kind: 'error', id: randomUUID(), retryable: false,
        text: `Não consegui trocar de conta: ${error instanceof Error ? error.message : String(error)}` })
      await this.complete()
    }
  }

  /**
   * Troca manual ("Usar nesta conversa" / "Continuar na conta X"). Com o turno
   * fechado e sem background, troca agora; senão fica agendada e acontece ao
   * terminar. `continueTask` retoma a tarefa preservada no estouro — menos o
   * turno de uma tarefa MCP que já terminou em erro: recusado com o motivo
   * (`reason`), como a retomada automática (regra 2); nada troca.
   */
  useAccount(to: string, continueTask: boolean): { ok: boolean; scheduled: boolean; reason?: string } {
    const accounts = this.accounts
    if (!accounts || this.disposed || providerForModel(this.options.model) !== 'claude') return { ok: false, scheduled: false }
    const refused = continueTask ? accounts.continueRefused?.() ?? null : null
    if (refused) return { ok: false, scheduled: false, reason: refused }
    if (to === this.accountId() && !continueTask) return { ok: true, scheduled: false }
    this.pending = {
      to,
      reason: 'manual',
      continueTask,
      text: continueTask
        ? `Continuei na conta ${accounts.label(to)}.`
        : `Esta conversa passou a usar a conta ${accounts.label(to)}.`
    }
    const scheduled = this.turnOpen || !!this.switching || !!this.current.hasBackgroundWork?.()
    if (scheduled) {
      this.emit({ kind: 'account-switch', id: randomUUID(), reason: 'scheduled', fromAccountId: this.accountId(), toAccountId: to,
        text: `Vai trocar para a conta ${accounts.label(to)} ao terminar.` })
    }
    this.tryPending()
    return { ok: true, scheduled }
  }

  /** Botão "agora": entra no turno em andamento; durante uma troca, não (fica na fila). */
  injectNow(...args: Parameters<AgentSession['injectNow']>): boolean {
    if (this.switching || this.disposed) return false
    return this.current.injectNow?.(...args) ?? false
  }

  /** Vale para o turno que vai começar (e os ajustes do "agora" dentro dele). */
  pinModel(on: boolean): void { this.modelPinned = on }
  /** As opções em que a sessão está AGORA (modelo depois de trocas, config MCP). */
  liveOptions(): Readonly<StartAgentOptions> { return this.options }

  /** A query da sessão atual ainda lê mensagens (uma morta não pode ser reaproveitada). */
  isAlive(): boolean { return !this.disposed && (this.current.isAlive?.() ?? true) }
  /** O processo atual tem trabalho que trocá-lo mataria (subagente/shell em background). */
  hasBackgroundWork(): boolean { return !this.disposed && !!this.current.hasBackgroundWork?.() }

  start(): Promise<boolean> { return this.current.start() }
  async send(...args: Parameters<AgentSession['send']>): Promise<void> {
    while (this.switching) await this.switching
    if (this.disposed) return
    this.stopped = false
    ++this.turn
    this.tried.clear()
    this.triedAccounts.clear()
    this.turnOpen = true
    await this.current.send(...args)
  }
  async waitForIdle(): Promise<void> {
    do {
      await this.current.waitForIdle()
      await this.switching
    } while (this.switching)
    await this.current.waitForIdle()
  }
  async interrupt(): ReturnType<AgentSession['interrupt']> {
    this.stopped = true
    const switching = this.switching
    // Cancelamento: o turno da tarefa acabou aqui, com ou sem `result` depois.
    this.modelPinned = false
    const receipt = await this.current.interrupt()
    // A quota already ended the old SDK turn, so it may emit no interrupt
    // result. Close the logical turn even while authentication is still pending.
    if (switching && !this.disposed) {
      this.emit({ kind: 'result', id: randomUUID(), isError: false, text: 'Troca automática cancelada pelo usuário.', durationMs: 0 })
      await this.complete()
    }
    return receipt
  }
  dispose(): void {
    this.disposed = true
    ++this.generation
    this.pending = null
    this.current.dispose()
    this.restartRegistration?.remove()
  }
  setBypass(on: boolean): void {
    this.options.skipPermissions = on
    this.current.setBypass(on)
  }
  resolvePermission(...args: Parameters<AgentSession['resolvePermission']>): void { this.current.resolvePermission(...args) }
  holdQuestion(...args: Parameters<AgentSession['holdQuestion']>): number | null { return this.current.holdQuestion(...args) }
  refreshUsage(): Promise<void> { return this.current.refreshUsage() }
  /** A persistência voltou: repassa à sessão atual (reparo do espelho pendente). */
  storageRestored(): void { if (!this.disposed) this.current.storageRestored?.() }
}
