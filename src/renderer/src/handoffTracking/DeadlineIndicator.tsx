import { deadlineView } from './deadlineView'
import { useHandoffEnvios, type HandoffEnviosApi } from './useHandoffEnvios'
import './deadlineIndicator.css'

/**
 * O indicador de prazo no topo da conversa de implementação (ao lado do chip
 * "Plano: <título>"): etapa atual, tempo ativo contra o prazo e a estimativa do
 * agente, lidos do banco — o usuário vê o tempo mesmo quando o agente esquece
 * de falar (card req-impl-indicador). A cor muda ao chegar a 80% e ao passar de
 * 100% do prazo; sem envio ou sem estimativa, fica neutro e discreto.
 */
export function DeadlineIndicator(props: {
  conversationId: string
  /** Injetável nos testes; padrão: window.api. */
  api?: HandoffEnviosApi
  refreshMs?: number
}): JSX.Element | null {
  const state = useHandoffEnvios(props.conversationId, { api: props.api, refreshMs: props.refreshMs })
  const view = deadlineView(state)
  if (!view) return null
  return (
    <span className={`deadline-indicator is-${view.level}`} data-level={view.level} title={view.title}>
      {view.etapa && <span className="deadline-etapa">{view.etapa}</span>}
      <span className="deadline-tempo">{view.tempo}</span>
      {view.agente && <span className="deadline-agente">{view.agente}</span>}
    </span>
  )
}
