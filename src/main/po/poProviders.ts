import { prepareGptRuntime } from '../agentSession'
import { runObserverAttempt, type ObserverAttempt, type SafeProviderReason } from '../observerQuery'
import { boardGateActive, shouldRunPo, type BoardGateInput } from '../typesafe'
import type { BoardItem, PoProviderDiagnostic } from '../../shared/ipc'
import type { PoPhase } from './poPrompt'

/**
 * As rotas de modelo do PO: Claude é sempre a primeira tentativa, e só uma
 * falha Claude estruturada e elegível dispara uma única consulta Luna — antes
 * de qualquer escrita no quadro. Aqui ficam as duas rotas, o diagnóstico que
 * o painel do elenco lê, a sequência de failover entre elas e, antes de tudo
 * isso, o gate do TypeSafe que decide se a rodada vale consultar alguma rota.
 */

export const PO_LUNA_MODEL = 'gpt-6-luna'

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

/** As rotas injetáveis — parte de `PoDeps`. */
export interface PoProviderDeps {
  /** Compatibilidade para testes e consumidores do PO original. */
  ask?(prompt: string, model: string): Promise<string>
  runClaude?(request: PoObserverRequest): Promise<ObserverAttempt>
  runLuna?(request: PoObserverRequest, onStarted: () => void): Promise<ObserverAttempt>
  diagnose?(diagnostic: PoProviderDiagnostic): void
  /**
   * O gate do TypeSafe, antes de qualquer rota de modelo. `true` = vale gastar o
   * modelo, `false` = não gaste, `null` = NÃO houve decisão e o PO segue como
   * sempre seguiu. Sem injeção (produção), é o `shouldRunPo` da pasta typesafe.
   */
  gate?(input: BoardGateInput): Promise<boolean | null>
  /** O gate está de pé nesta máquina? Sem ele, nem o `state` é montado. */
  gateActive?(): Promise<boolean>
}

/**
 * Pergunta ao gate se esta rodada vale o modelo. Nunca lança, nunca decide por
 * omissão: qualquer tropeço (gate inativo, lançando, sem resposta) vira `null`,
 * e `null` é "siga como antes" — ausência de decisão não é "não".
 */
export async function askBoardGate(deps: PoProviderDeps, input: BoardGateInput): Promise<boolean | null> {
  try {
    // O mesmo default do memorista: um gate injetado dispensa a sonda de
    // produção — quem injetou já decidiu que há a quem perguntar.
    const active = deps.gateActive ?? (deps.gate ? async () => true : boardGateActive)
    if (!(await active())) return null
    const gate = deps.gate ?? shouldRunPo
    return await gate(input)
  } catch {
    return null
  }
}

export async function runClaude(deps: PoProviderDeps, request: PoObserverRequest): Promise<ObserverAttempt> {
  if (deps.runClaude) return deps.runClaude(request)
  if (deps.ask) {
    try {
      return { provider: 'claude', state: 'completed', text: await deps.ask(request.prompt, request.model) }
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

export async function runLuna(
  deps: PoProviderDeps,
  request: PoObserverRequest,
  onStarted: () => void
): Promise<ObserverAttempt> {
  if (deps.runLuna) return deps.runLuna(request, onStarted)
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

export function diagnostic(
  deps: PoProviderDeps,
  request: PoObserverRequest,
  phase: PoProviderDiagnostic['phase'],
  actualProvider: 'claude' | 'gpt-luna',
  fallbackReason?: SafeProviderReason,
  appliedOps?: number
): void {
  deps.diagnose?.({
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

/**
 * Consulta Claude e, se ele falhar de forma elegível, uma única vez a Luna.
 * Devolve o texto da resposta que completou, ou `null` quando nenhuma rota
 * entregou uma resposta utilizável — aí não há o que julgar nem escrever.
 *
 * `onSwitch` avisa, ANTES de a Luna ser consultada, que a rota mudou: quem
 * anuncia o fim da auditoria precisa saber qual rota rodou mesmo quando a
 * própria Luna lança, e uma exceção não carrega valor de retorno nenhum.
 */
export async function consultWithFailover(
  deps: PoProviderDeps,
  request: PoObserverRequest,
  onSwitch: () => void
): Promise<string | null> {
  let attempt = await runClaude(deps, request)
  if (attempt.provider === 'claude' && attempt.state !== 'completed' && attempt.reason) {
    const fallbackReason = attempt.reason
    diagnostic(deps, request, 'claude-unavailable', 'claude', fallbackReason)
    diagnostic(deps, request, 'po-provider-switch', 'gpt-luna', fallbackReason)
    onSwitch()
    let lunaStarted = false
    attempt = await runLuna(deps, request, () => {
      lunaStarted = true
      diagnostic(deps, request, 'gpt-luna-started', 'gpt-luna', fallbackReason)
    })
    if (attempt.state !== 'completed') {
      // Setup failure has no preceding Luna-started notice; a started Luna
      // gets an error after its own failed attempt. Both are safe and transient.
      diagnostic(deps, request, 'gpt-luna-unavailable', 'gpt-luna', fallbackReason)
      return null
    }
    // Defensive: injected runners must announce their actual start before
    // claiming a completed Luna response.
    if (!lunaStarted) return null
  }
  if (attempt.state !== 'completed') return null
  return attempt.text
}
