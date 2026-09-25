import { randomUUID } from 'node:crypto'
import { isOpenAIModel, MODEL_EFFORT, modelSupportsFastMode } from '../shared/ipc'
import type { ChatEvent, StartAgentOptions, UsageProvider } from '../shared/ipc'
import type { AgentSession } from './agentSession'
import { appRestart } from './appRestartRuntime'
import type { AccountSwitchDeps } from './accounts/switchDeps'
import { DEFAULT_ACCOUNT_ID } from './accounts/registry'

export const FAILOVER_CONTINUATION = '[PROVIDER_CONTINUATION]\n' +
  'O provedor anterior ficou sem limite de uso. Continue a tarefa pendente do usuário a partir do histórico desta mesma sessão, ' +
  'preservando requisitos, arquivos, plano e resultados de ferramentas. Verifique o estado atual antes de repetir qualquer ação ' +
  'com efeito externo; não repita trabalho já concluído. A troca de provedor não altera as instruções nem autorizações do usuário.\n' +
  '[/PROVIDER_CONTINUATION]'

type Session = Pick<AgentSession, 'start' | 'send' | 'dispose' | 'interrupt' | 'setBypass' | 'resolvePermission' | 'holdQuestion' | 'refreshUsage' | 'waitForIdle' | 'resumeAfterQuota' | 'continuationState' | 'restoreContinuation'> &
  Partial<Pick<AgentSession, 'hasBackgroundWork'>>
type Factory = (options: StartAgentOptions, emit: (event: ChatEvent) => void, complete: () => void) => Session

/** Troca de conta com o turno fechado: a de fim de turno e a manual do painel. */
type PendingAccountSwitch = { to: string; reason: 'turn-end' | 'manual'; text: string; continueTask: boolean }

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
    let quotaTerminal = false
    let handledQuotaTurn = -1
    const onEvent = (event: ChatEvent): void => {
      if (generation !== this.generation || this.disposed) return
      if ((event.kind === 'result' || event.kind === 'error') && event.usageExhausted && !this.stopped && providerForModel(this.options.model)) {
        const turn = this.turn
        if (handledQuotaTurn === turn) return
        quotaTerminal = true
        if (!this.switching) {
          handledQuotaTurn = turn
          // Defer work until switching is assigned, even with synchronous fakes.
          this.switching = Promise.resolve().then(() => this.switchProvider(generation)).finally(() => {
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
        if (event.kind === 'result' && !event.isError && !this.stopped) this.checkTurnEnd()
        this.tryPending()
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
    previous.dispose()
    this.create()
    const nextGeneration = this.generation
    if (!(await this.current.start())) throw new Error('Não foi possível iniciar a sessão na nova conta/provedor. A tarefa foi preservada.')
    if (this.disposed || this.stopped || nextGeneration !== this.generation) return false
    this.current.restoreContinuation(continuation, continuing)
    return true
  }

  private async switchProvider(generation: number): Promise<void> {
    const previous = this.current
    const from = providerForModel(this.options.model)
    const active = (): boolean => !this.disposed && !this.stopped && generation === this.generation
    try {
      appRestart?.assertOpen()
      if (!from) throw new Error('Não há troca automática para este provedor.')
      // Várias contas Claude: primeiro as outras contas, uma vez cada; o GPT só
      // quando todas estouraram.
      if (from === 'claude' && this.accountsInPlay() && this.accounts) {
        const exhausted = this.accountId()
        this.triedAccounts.add(exhausted)
        const target = await this.accounts.exhaustedTarget(exhausted, this.options.model, this.triedAccounts)
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
          await this.complete()
          return
        }
        if (target) {
          if (!active()) return
          if (!(await this.replace(previous, (resume) => ({ claudeAccountId: target.to, resume }), active, true))) return
          this.triedAccounts.add(target.to)
          this.accounts.changed(target.to)
          this.emit({ kind: 'account-switch', id: randomUUID(), reason: 'exhausted', fromAccountId: exhausted, toAccountId: target.to,
            text: `A conta ${this.accounts.label(exhausted)} atingiu o limite. Continuei na conta ${this.accounts.label(target.to)}.` })
          await this.current.send(FAILOVER_CONTINUATION, undefined, randomUUID(), 'pc', 'recovery')
          return
        }
        // Todas as contas Claude estouraram: segue para o GPT (a troca de sempre).
      }
      this.tried.add(from)
      const to = from === 'claude' ? 'gpt' : 'claude'
      if (this.tried.has(to)) throw new Error('Claude e GPT atingiram o limite de uso. A tarefa foi preservada; aguarde a renovação dos limites.')
      if (!(await this.available(to))) throw new Error(`O limite de uso foi atingido e ${to === 'gpt' ? 'o ChatGPT' : 'o Claude'} não está conectado. A tarefa foi preservada; aguarde a renovação dos limites.`)
      if (!active()) return
      const fromModel = this.options.model ?? 'claude-opus-5-5'
      this.lastModels[from] = fromModel
      const model = this.lastModels[to] ?? (to === 'gpt' ? 'gpt-6-astra' : 'claude-opus-5-5')
      const effort = this.options.effort
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
        text: `O limite de uso de ${fromModel} foi atingido. Troquei automaticamente para ${model} e vou continuar a tarefa.`
      })
      await this.current.send(FAILOVER_CONTINUATION, undefined, randomUUID(), 'pc', 'recovery')
    } catch (error) {
      if (this.disposed || this.stopped) return
      this.turnOpen = false
      this.emit({ kind: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error), retryable: false })
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
      if (!(await this.replace(previous, (resume) => ({ claudeAccountId: pending.to, resume }), active, pending.continueTask))) return
      accounts.changed(pending.to)
      this.emit({ kind: 'account-switch', id: randomUUID(), reason: pending.reason, fromAccountId: from, toAccountId: pending.to, text: pending.text })
      if (pending.continueTask) {
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
   * terminar. `continueTask` retoma a tarefa preservada no estouro.
   */
  useAccount(to: string, continueTask: boolean): { ok: boolean; scheduled: boolean } {
    const accounts = this.accounts
    if (!accounts || this.disposed || providerForModel(this.options.model) !== 'claude') return { ok: false, scheduled: false }
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
}
