/**
 * A aba Planos: a lista de planos por projeto ou o plano aberto (Etapas | Chat),
 * a folha do card e a de "+ Novo planejamento". O voltar do Android fecha a folha
 * aberta (modal) e, depois, volta do plano à lista (tela).
 */
import { useEffect } from 'react'
import { nav } from '../app/runtime'
import { OLD_PC_TEXT } from '../core/planning'
import { useStore } from '../core/store'
import { ReconnectBar } from '../chat/ChatBars'
import { BACK, useBackHandler } from '../shell/backButton'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { CardSheet } from './CardSheet'
import { NewPlanSheet } from './NewPlanSheet'
import { PlanList } from './PlanList'
import { PlanView } from './PlanView'
import { cancelCreate, closeCard, closePlan, planUi, watchPlanningEvents } from './planState'
import '../styles/planning.css'

/** "Atualize o app do PC": a ponte respondeu 404 "rota desconhecida". */
function OldPc(): JSX.Element {
  return (
    <div className="tab-view">
      <header className="topbar">
        <div className="topbar-title"><span className="t">Planos</span></div>
        <StatusPill />
        <button type="button" className="icon-btn" aria-label="Configurações" onClick={() => nav.set({ settingsOpen: true })}>
          <Icon name="gear" size={20} />
        </button>
      </header>
      <ReconnectBar />
      <div className="empty-state pl-oldpc">
        <strong>Atualize o app do PC</strong>
        {OLD_PC_TEXT} O PC conectado ainda não tem a tela de planejamento para o celular.
        <button type="button" className="btn ghost" onClick={() => planUi.set({ oldPc: false, lists: {} })}>
          Tentar de novo
        </button>
      </div>
    </div>
  )
}

export function PlanningTab(): JSX.Element {
  const open = useStore(planUi, (s) => s.open)
  const card = useStore(planUi, (s) => s.card)
  const creating = useStore(planUi, (s) => s.creating)
  const oldPc = useStore(planUi, (s) => s.oldPc)
  useBackHandler(BACK.screen, () => closePlan(), !!open)
  useBackHandler(BACK.modal, () => closeCard(), !!card)
  useBackHandler(BACK.modal, () => cancelCreate(), !!creating)
  useEffect(() => watchPlanningEvents(), [])
  if (oldPc) return <OldPc />
  return (
    <>
      {open ? <PlanView /> : <PlanList />}
      {open && card && <CardSheet key={card} />}
      {creating && <NewPlanSheet />}
    </>
  )
}
