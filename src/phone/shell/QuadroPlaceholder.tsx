/** A aba Quadro: reservada — o quadro de tarefas do projeto chega na próxima parte. */
import { ReconnectBar } from '../chat/ChatBars'
import { StatusPill } from './StatusMenu'
import { Icon } from '../ui/icons'

export function QuadroPlaceholder(): JSX.Element {
  return (
    <div className="tab-view">
      <header className="topbar">
        <div className="topbar-title"><span className="t">Quadro</span></div>
        <StatusPill />
      </header>
      <ReconnectBar />
      <div className="empty-state">
        <Icon name="board" size={36} />
        <strong>Quadro de tarefas</strong>
        Em breve: ver e mover os cartões do projeto (A fazer · Fazendo · Concluído) direto do celular.
      </div>
    </div>
  )
}
