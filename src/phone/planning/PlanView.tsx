/** O plano aberto: cabeçalho com voltar e a alternância Etapas | Chat. */
import { useStore } from '../core/store'
import { ReconnectBar } from '../chat/ChatBars'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { PlanChat } from './PlanChat'
import { closePlan, loadPlan, planUi, setView, type PlanTabView } from './planState'
import { StageColumns } from './StageColumns'

const VIEWS: Array<{ id: PlanTabView; label: string }> = [
  { id: 'etapas', label: 'Etapas' },
  { id: 'chat', label: 'Chat' }
]

export function PlanView(): JSX.Element {
  const open = useStore(planUi, (s) => s.open)
  const plan = useStore(planUi, (s) => s.plan)
  const loading = useStore(planUi, (s) => s.planLoading)
  const error = useStore(planUi, (s) => s.planError)
  const view = useStore(planUi, (s) => s.view)
  const title = plan?.roteiro.titulo || open?.slug || 'Plano'
  return (
    <div className="tab-view pl-plan-view">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Voltar aos planos" onClick={closePlan}>
          <Icon name="back" size={22} />
        </button>
        <div className="topbar-title"><span className="t">{title}</span></div>
        <StatusPill />
      </header>
      <ReconnectBar />
      <div className="pl-switch" role="tablist" aria-label="Etapas ou Chat">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'chat' ? (
        <PlanChat />
      ) : plan ? (
        <StageColumns plan={plan} />
      ) : error ? (
        <div className="empty-state">
          <strong>Não consegui abrir o plano</strong>
          {error}
          <button type="button" className="btn ghost" onClick={() => void loadPlan(false)}>Tentar de novo</button>
        </div>
      ) : (
        <div className="messages-loading">{loading && <span className="spinner" />} Carregando o plano…</div>
      )}
    </div>
  )
}
