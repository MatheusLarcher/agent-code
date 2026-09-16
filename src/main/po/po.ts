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
  rejectUnsafeOps,
  summarizeCall,
  type PoCall
} from './poPrompt'

export const PO_LUNA_MODEL = 'gpt-5.6-luna'

/** Immutable, provider-neutral intent created once for both observer attempts. */
export interface PoObserverRequest {
  prompt: string
  model: string
  conversationId: string
  cwd: string
  projectId: string
  cards: readonly Pick<BoardItem, 'id' | 'projectId' | 'projectCwd' | 'conversationId' | 'sourceTitle' | 'sourceStatus' | 'poTitle' | 'poStatus'>[]
  correlationId: string
}

/**
 * O PO: audita o quadro no fim de um turno sem falar com o agente principal.
 * Claude é sempre a primeira tentativa. Somente uma falha Claude estruturada
 * e elegível pode disparar uma única consulta Luna, antes de qualquer escrita.
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

interface ConvState {
  userText: string | null
  cwd: string
  calls: PoCall[]
  fired: boolean
  lastRunAt: number
}

/** Evidence captured synchronously with a result, before board ingestion yields. */
interface PoTurnSnapshot {
  userText: string
  cwd: string
  calls: readonly PoCall[]
}

export class Po {
  private readonly state = new Map<string, ConvState>()
  private correlations = 0

  constructor(private readonly deps: PoDeps) {}

  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
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
      void this.run(convId, turn)
      return
    }
    if (event.kind === 'error') conv.userText = null
  }

  dispose(convId: string): void {
    this.state.delete(convId)
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = { userText: null, cwd: '', calls: [], fired: false, lastRunAt: 0 }
      this.state.set(convId, conv)
    }
    return conv
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
      phase,
      requestedProvider: 'claude',
      actualProvider,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(appliedOps === undefined ? {} : { appliedOps })
    })
  }

  private async run(convId: string, turn: PoTurnSnapshot): Promise<void> {
    const conv = this.conv(convId)

    // This is the logical-request snapshot. Do not reread config between
    // providers; a settings change cannot redirect an in-flight audit.
    const cfg = this.deps.config()
    if (!cfg.po.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt < PO_COOLDOWN_MS) return
    conv.lastRunAt = now

    try {
      await this.deps.board.settled(convId)
      const cards = await this.deps.board.list(turn.cwd, { conversationId: convId })
      if (!cards || cards.length === 0) return

      const prompt = buildPoPrompt({
        userText: turn.userText,
        cards: cards.map((card) => ({
          id: card.id,
          title: card.poTitle ?? card.sourceTitle,
          status: card.poStatus ?? card.sourceStatus
        })),
        calls: [...turn.calls]
      })
      const request: PoObserverRequest = Object.freeze({
        prompt,
        model: cfg.po.model,
        conversationId: convId,
        cwd: turn.cwd,
        projectId: cards[0].projectId,
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

        const ops = rejectUnsafeOps(
          parsePoVerdict(attempt.text, cards.map((card) => card.id)),
          cards
        )
        if (ops.length === 0) return

        const first = cards[0]
        for (const op of ops) {
          if (op.kind === 'complete') {
            await this.deps.board.applyPo({ id: op.id, poStatus: 'completed', poReason: op.reason })
          } else if (op.kind === 'retitle') {
            await this.deps.board.applyPo({ id: op.id, poTitle: op.title })
          } else {
            await this.deps.board.createPoItem({
              projectId: first.projectId,
              projectCwd: first.projectCwd,
              conversationId: convId,
              title: op.title,
              status: 'pending',
              reason: op.reason
            })
          }
          applied++
        }
      } finally {
        this.diagnostic(request, 'audit-finished', provider, undefined, applied)
      }
    } catch {
      // The observer cannot take down the observed turn or write a partial board.
    }
  }
}

/** Compatibility alias used by existing tests and external imports. */
export const askPo = askObserver
