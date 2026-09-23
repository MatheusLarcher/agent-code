import { randomUUID } from 'node:crypto'
import { isOpenAIModel, MODEL_EFFORT, modelSupportsFastMode } from '../shared/ipc'
import type { ChatEvent, StartAgentOptions, UsageProvider } from '../shared/ipc'
import type { AgentSession } from './agentSession'
import { appRestart } from './appRestartRuntime'

export const FAILOVER_CONTINUATION = '[PROVIDER_CONTINUATION]\n' +
  'O provedor anterior ficou sem limite de uso. Continue a tarefa pendente do usuário a partir do histórico desta mesma sessão, ' +
  'preservando requisitos, arquivos, plano e resultados de ferramentas. Verifique o estado atual antes de repetir qualquer ação ' +
  'com efeito externo; não repita trabalho já concluído. A troca de provedor não altera as instruções nem autorizações do usuário.\n' +
  '[/PROVIDER_CONTINUATION]'

type Session = Pick<AgentSession, 'start' | 'send' | 'dispose' | 'interrupt' | 'setBypass' | 'resolvePermission' | 'refreshUsage' | 'waitForIdle' | 'resumeAfterQuota' | 'continuationState' | 'restoreContinuation'>
type Factory = (options: StartAgentOptions, emit: (event: ChatEvent) => void, complete: () => void) => Session

export function providerForModel(model?: string): UsageProvider | null {
  if (isOpenAIModel(model)) return 'gpt'
  return !model || model.startsWith('claude-') ? 'claude' : null
}

/** One logical chat owns successive SDK processes. Only quota terminal events
 * replace the process; the SDK transcript, attachments and tool results survive. */
export class ProviderFailoverSession {
  private current!: Session
  private options: StartAgentOptions
  private generation = 0
  private turn = 0
  private stopped = false
  private disposed = false
  private switching: Promise<void> | null = null
  private tried = new Set<UsageProvider>()
  private lastModels: Partial<Record<UsageProvider, string>> = {}
  private restartRegistration?: { remove(): void }

  constructor(
    options: StartAgentOptions,
    private readonly factory: Factory,
    private readonly emit: (event: ChatEvent) => void,
    private readonly available: (provider: UsageProvider) => Promise<boolean>,
    private readonly complete: () => void | Promise<void>
  ) {
    this.options = { ...options }
    this.restartRegistration = appRestart?.register(`${options.convId} (failover)`, () => ({ busy: !!this.switching }))
    this.create()
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

  private async switchProvider(generation: number): Promise<void> {
    const previous = this.current
    const from = providerForModel(this.options.model)
    const active = (): boolean => !this.disposed && !this.stopped && generation === this.generation
    try {
      appRestart?.assertOpen()
      if (!from) throw new Error('Não há troca automática para este provedor.')
      this.tried.add(from)
      const to = from === 'claude' ? 'gpt' : 'claude'
      if (this.tried.has(to)) throw new Error('Claude e GPT atingiram o limite de uso. A tarefa foi preservada; aguarde a renovação dos limites.')
      if (!(await this.available(to))) throw new Error(`O limite de uso foi atingido e ${to === 'gpt' ? 'o ChatGPT' : 'o Claude'} não está conectado. A tarefa foi preservada.`)
      if (!active()) return
      // Await the eager mirror verification before disposing the old writer.
      const resume = await previous.resumeAfterQuota()
      if (!active()) return
      const fromModel = this.options.model ?? 'claude-opus-5-5'
      this.lastModels[from] = fromModel
      const model = this.lastModels[to] ?? (to === 'gpt' ? 'gpt-6-astra' : 'claude-opus-5-5')
      const effort = this.options.effort
      this.options = {
        ...this.options, model, resume,
        effort: effort && MODEL_EFFORT[model]?.some((level) => level === effort) ? effort : 'high',
        fastMode: this.options.fastMode === true && modelSupportsFastMode(model)
      }
      const continuation = previous.continuationState()
      previous.dispose()
      this.create()
      const nextGeneration = this.generation
      if (!(await this.current.start())) throw new Error('Não foi possível iniciar o provedor alternativo. A tarefa foi preservada.')
      if (this.disposed || this.stopped || nextGeneration !== this.generation) return
      this.current.restoreContinuation(continuation)
      this.tried.add(to)
      this.emit({
        kind: 'provider-switch', id: randomUUID(), fromModel, model, effort: this.options.effort,
        fastMode: this.options.fastMode === true,
        text: `O limite de uso de ${fromModel} foi atingido. Troquei automaticamente para ${model} e vou continuar a tarefa.`
      })
      await this.current.send(FAILOVER_CONTINUATION, undefined, randomUUID(), 'pc', 'recovery')
    } catch (error) {
      if (this.disposed || this.stopped) return
      this.emit({ kind: 'error', id: randomUUID(), text: error instanceof Error ? error.message : String(error), retryable: false })
      await this.complete()
    }
  }

  start(): Promise<boolean> { return this.current.start() }
  async send(...args: Parameters<AgentSession['send']>): Promise<void> {
    while (this.switching) await this.switching
    if (this.disposed) return
    this.stopped = false
    ++this.turn
    this.tried.clear()
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
    this.current.dispose()
    this.restartRegistration?.remove()
  }
  setBypass(on: boolean): void {
    this.options.skipPermissions = on
    this.current.setBypass(on)
  }
  resolvePermission(...args: Parameters<AgentSession['resolvePermission']>): void { this.current.resolvePermission(...args) }
  refreshUsage(): Promise<void> { return this.current.refreshUsage() }
}
