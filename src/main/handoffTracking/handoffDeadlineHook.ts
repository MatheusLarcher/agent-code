import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { StartAgentOptions } from '../../shared/ipc'
import type { PlanProgress } from '../../shared/stepProgress'
import { entregaServerApplies, loadPlanProgress } from './entregaTools'
import { rememberPlanSteps } from './handoffDeadline'
import { activeHandoffTracker } from './handoffRuntime'
import type { HandoffTracker } from './handoffTracker'

/**
 * A ponte entre o hook PostToolUse da AgentSession e o aviso de prazo do
 * acompanhamento (HandoffTracker.deadlineNotice). Fica aqui para o agentSession.ts
 * só chamar e devolver o `additionalContext` (fonte:
 * https://code.claude.com/docs/en/agent-sdk/hooks).
 */

/** O que o hook usa do acompanhamento (o HandoffTracker real cumpre). */
export type DeadlineNoticeTracker = Pick<HandoffTracker, 'deadlineNotice' | 'currentEnvio'>

export type DeadlineHookRole = Pick<StartAgentOptions, 'convId' | 'planning' | 'handoff'>

/** Quanto a leitura das posições no plano vale antes de ser refeita. */
export const PLAN_POSITIONS_TTL_MS = 60_000

export interface PlanPositionsDeps {
  /** As etapas do plano do envio. Padrão: loadPlanProgress (roteiro + envios do plano). */
  load?: (envio: HandoffEnvio) => Promise<PlanProgress>
  now?: () => number
}

/**
 * O "⏱ Etapa N" do aviso numera pela posição no PLANO, e o roteiro mora no
 * disco: o hook roda a cada ferramenta e não pode esperar por ele. Aqui o hook
 * só compara o relógio; passado o TTL, dispara SEM esperar a releitura (o envio
 * corrente da conversa → loadPlanProgress) e a publica no handoffDeadline
 * (rememberPlanSteps), de onde o aviso a lê. Até a primeira leitura chegar, ou
 * se ela falhar, o aviso numera pela união das entregas do envio.
 */
export class PlanPositions {
  /** Quando a última leitura de cada conversa começou (vale também em voo). */
  private readonly startedAt = new Map<string, number>()

  constructor(private readonly deps: PlanPositionsDeps = {}) {}

  /** A releitura disparada (os testes esperam por ela), ou `null` dentro do TTL. Nunca rejeita. */
  refresh(convId: string, tracker: Pick<DeadlineNoticeTracker, 'currentEnvio'>): Promise<void> | null {
    const now = (this.deps.now ?? Date.now)()
    const last = this.startedAt.get(convId)
    if (last !== undefined && now - last < PLAN_POSITIONS_TTL_MS) return null
    this.startedAt.set(convId, now)
    const load = this.deps.load ?? ((envio: HandoffEnvio) => loadPlanProgress(envio))
    return (async () => {
      // Depois do hook: nem a parte síncrona da leitura (o SQLite) entra no caminho da ferramenta.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const envio = await tracker.currentEnvio(convId)
      if (!envio) return
      const progress = await load(envio)
      rememberPlanSteps(envio.projectCwd, envio.planSlug, progress.steps)
    })().catch(() => undefined)
  }
}

const planPositions = new PlanPositions()

/**
 * O texto que o hook anexa ao resultado da ferramenta, ou `null`. Só na conversa
 * de handoff (a mesma regra do servidor `entregas`: nunca a comum nem o Agent
 * Manager) e só no fio PRINCIPAL: o subagente (`agentId`) descarta o próprio
 * contexto ao terminar, e o marco seria gasto sem chegar a quem conduz a etapa —
 * ele sai na ferramenta seguinte do agente principal. Nunca lança e nunca
 * interrompe nada: o pior caso é seguir sem aviso.
 */
export async function sessionDeadlineNotice(
  role: DeadlineHookRole,
  agentId: string | undefined,
  trackerOf: () => DeadlineNoticeTracker | null = activeHandoffTracker,
  positions: PlanPositions = planPositions
): Promise<string | null> {
  if (!entregaServerApplies(role) || agentId) return null
  try {
    const tracker = trackerOf()
    if (!tracker) return null
    // Sem await: a posição no plano chega para o próximo aviso, nunca segura este.
    void positions.refresh(role.convId, tracker)
    return await tracker.deadlineNotice(role.convId)
  } catch {
    return null
  }
}
