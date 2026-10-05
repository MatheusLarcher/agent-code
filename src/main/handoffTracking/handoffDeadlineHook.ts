import type { StartAgentOptions } from '../../shared/ipc'
import { entregaServerApplies } from './entregaTools'
import { activeHandoffTracker } from './handoffRuntime'
import type { HandoffTracker } from './handoffTracker'

/**
 * A ponte entre o hook PostToolUse da AgentSession e o aviso de prazo do
 * acompanhamento (HandoffTracker.deadlineNotice). Fica aqui para o agentSession.ts
 * só chamar e devolver o `additionalContext` (fonte:
 * https://code.claude.com/docs/en/agent-sdk/hooks).
 */

/** O que o hook usa do acompanhamento (o HandoffTracker real cumpre). */
export type DeadlineNoticeTracker = Pick<HandoffTracker, 'deadlineNotice'>

export type DeadlineHookRole = Pick<StartAgentOptions, 'convId' | 'planning' | 'handoff'>

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
  trackerOf: () => DeadlineNoticeTracker | null = activeHandoffTracker
): Promise<string | null> {
  if (!entregaServerApplies(role) || agentId) return null
  try {
    const tracker = trackerOf()
    return tracker ? await tracker.deadlineNotice(role.convId) : null
  } catch {
    return null
  }
}
