import {
  isAutoModel,
  PLANNING_AUTO_FALLBACK,
  type PlanningConfig,
  type StartAgentOptions
} from '../../shared/ipc'
import { assertValidName, PlanningValidationError } from './planningModel'
import { resolvePlanningExecution, type PlanningExecution } from './planningModelChoice'

/**
 * As decisões do `index.ts` sobre conversas de planejamento, fora do handler
 * de IPC para serem testáveis sem Electron:
 *
 * - com que modelo/esforço a sessão do Agent Manager sobe (`planningStartOptions`);
 * - quais conversas NÃO alimentam os observadores (vigia, quadro, PO e
 *   memorista) — `PlanningConversations`. O Manager conversa sobre um plano;
 *   não há turno de execução para o quadro, o PO auditar ou o memorista
 *   aprender, e o vigia questionaria premissas que o próprio Manager questiona.
 */

export interface PlanningStartDeps {
  /** A configuração do Manager (loadConfig().planning), lida na hora. */
  config: () => PlanningConfig
  /** Injetável para teste; ausente, o resolvedor real. */
  resolve?: (cfg: PlanningConfig, prompt: NonNullable<StartAgentOptions['autoPrompt']>) => Promise<PlanningExecution>
}

/**
 * As opções com que a sessão sobe. Sem `planning`, devolve `opts` intactas.
 * Com `planning`, valida o slug e fixa modelo+esforço pelo resolvedor do
 * Manager — nunca o sentinel do Automático, então o Automático da conversa
 * (isAutoModel/autoStart) não roda para ela.
 *
 * Lança PlanningValidationError em entrada inválida (slug fora de [a-z0-9-],
 * ou planejamento e handoff na mesma sessão): o IPC é a fronteira.
 */
export async function planningStartOptions(
  opts: StartAgentOptions,
  deps: PlanningStartDeps
): Promise<StartAgentOptions> {
  if (opts.handoff) assertValidName(opts.handoff.slug, 'slug do handoff')
  if (!opts.planning) return opts
  assertValidName(opts.planning.slug, 'slug do planejamento')
  if (opts.handoff) {
    throw new PlanningValidationError('uma sessão não pode ser ao mesmo tempo o Agent Manager e um handoff')
  }
  const resolve = deps.resolve ?? resolvePlanningExecution
  const execution = await resolve(deps.config(), opts.autoPrompt ?? { message: '' })
  // Cinto e suspensório: o resolvedor nunca devolve o sentinel, mas se um dia
  // devolver, o Automático da conversa pegaria a sessão do Manager.
  const pair = isAutoModel(execution.model) ? PLANNING_AUTO_FALLBACK : execution
  // Loop e modo econômico são toggles da conversa comum: /loop agenda turnos
  // sozinho e o econômico manda pular verificação — nenhum dos dois cabe numa
  // sessão que planeja com o usuário, então a do Manager sobe sem eles.
  return { ...opts, model: pair.model, effort: pair.effort, loopEnabled: false, economyMode: false }
}

/** As conversas vivas que são sessões do Agent Manager. */
export class PlanningConversations {
  private readonly ids = new Set<string>()

  /** Chamado a cada sessão que sobe: marca ou desmarca a conversa conforme ela
   *  seja (ou tenha deixado de ser) do Manager. */
  track(opts: Pick<StartAgentOptions, 'convId' | 'planning'>): void {
    if (opts.planning) this.ids.add(opts.convId)
    else this.ids.delete(opts.convId)
  }

  /** A conversa alimenta vigia, quadro, PO e memorista? */
  observed(convId: string): boolean {
    return !this.ids.has(convId)
  }

  /** A conversa foi descartada: some do registro. */
  forget(convId: string): void {
    this.ids.delete(convId)
  }
}
