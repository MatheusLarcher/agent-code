import { currentEnvio } from '@shared/handoffTracking'
import { usePlanObra } from '../planning/usePlanObra'
import type { PeekApi } from '../office3d/tvPlans'
import { deadlineView } from './deadlineView'
import { useHandoffEnvios, type HandoffEnviosApi } from './useHandoffEnvios'
import { usePlanRoteiro } from './usePlanRoteiro'
import './deadlineIndicator.css'

/**
 * O indicador de prazo no topo da conversa de implementação (ao lado do chip
 * "Plano: <título>"): etapa atual, tempo ativo contra o prazo e a estimativa do
 * agente, lidos do banco — o usuário vê o tempo mesmo quando o agente esquece
 * de falar (card req-impl-indicador). A cor muda ao chegar a 80% e ao passar de
 * 100% do prazo; sem envio ou sem estimativa, fica neutro e discreto.
 *
 * "Etapa N de M" é a posição no PLANO: os envios do plano do envio corrente no
 * projeto (de qualquer conversa: usePlanObra) e o roteiro (usePlanRoteiro, o
 * cache da TV); o tempo e o prazo são os do envio desta conversa.
 */
export function DeadlineIndicator(props: {
  conversationId: string
  /** Injetável nos testes; padrão: window.api. */
  api?: HandoffEnviosApi
  /** O resumo do plano (planning:peek); injetável nos testes, padrão: window.api. */
  peekApi?: PeekApi | null
  refreshMs?: number
}): JSX.Element | null {
  const state = useHandoffEnvios(props.conversationId, { api: props.api, refreshMs: props.refreshMs })
  const envio = currentEnvio(state.envios ?? [])
  const plano = usePlanObra(envio?.projectCwd ?? '', envio?.planSlug ?? '', { api: props.api, refreshMs: props.refreshMs })
  const roteiro = usePlanRoteiro(envio?.projectCwd, envio?.planSlug, props.peekApi)
  const view = deadlineView(state, { envios: plano.envios, roteiro })
  if (!view) return null
  return (
    <span className={`deadline-indicator is-${view.level}`} data-level={view.level} title={view.title}>
      {view.etapa && <span className="deadline-etapa">{view.etapa}</span>}
      <span className="deadline-tempo">{view.tempo}</span>
      {view.agente && <span className="deadline-agente">{view.agente}</span>}
    </span>
  )
}
