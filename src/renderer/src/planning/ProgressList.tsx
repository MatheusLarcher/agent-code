/**
 * Checklist compacto do roteiro: as etapas na ordem, com contador
 * concluídas/total. Clicar na marca avança o status (pendente → em andamento →
 * concluída → pendente); clicar no nome centraliza o canvas na coluna.
 *
 * Recolhido (`collapsed`), vira um trilho estreito com o contador e uma marca
 * por etapa (clicar centraliza a coluna) — o canvas fica com o espaço.
 */
import type { PlanningRoteiroDto } from '@shared/ipc'
import { IconChevronLeft, IconChevronRight } from '../components/Icons'
import { STAGE_STATUS_LABEL, StageStatusIcon } from './cardTypes'
import { nextStageStatus } from './usePlanning'

export interface ProgressListProps {
  etapas: PlanningRoteiroDto['etapas']
  onToggle: (id: string) => void
  onFocus: (id: string) => void
  /** Trilho estreito no lugar da lista. */
  collapsed?: boolean
  /** Sem ele, não há botão de recolher/expandir. */
  onToggleCollapsed?: () => void
}

function RoteiroRail({ etapas, onFocus, onToggleCollapsed }: ProgressListProps): JSX.Element {
  const total = etapas.length
  const done = etapas.filter((e) => e.status === 'concluida').length
  return (
    <nav className="pl-progress pl-rail nokey" aria-label="Progresso do roteiro">
      {onToggleCollapsed && (
        <button
          type="button"
          className="pl-rail-toggle"
          onClick={onToggleCollapsed}
          title="Mostrar o roteiro"
          aria-label="Mostrar o roteiro"
          aria-expanded={false}
        >
          <IconChevronRight size={15} />
        </button>
      )}
      <span className="pl-progress-count" data-testid="pl-progress-count" title={`${done} de ${total} etapas concluídas`}>
        {done}/{total}
      </span>
      <ol className="pl-rail-steps">
        {etapas.map((etapa, i) => (
          <li key={etapa.id}>
            <button
              type="button"
              className={`pl-rail-step ${etapa.status}`}
              onClick={() => onFocus(etapa.id)}
              title={`${i + 1}. ${etapa.titulo || etapa.id} — ${STAGE_STATUS_LABEL[etapa.status]}`}
              aria-label={`${etapa.titulo || etapa.id}: ${STAGE_STATUS_LABEL[etapa.status]}. Mostrar no canvas`}
            >
              <StageStatusIcon status={etapa.status} size={14} />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function ProgressList(props: ProgressListProps): JSX.Element {
  const { etapas, onToggle, onFocus, collapsed, onToggleCollapsed } = props
  if (collapsed) return <RoteiroRail {...props} />
  const total = etapas.length
  const done = etapas.filter((e) => e.status === 'concluida').length
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    // nokey: Delete/Backspace aqui não apaga card selecionado no canvas.
    <nav className="pl-progress nokey" aria-label="Progresso do roteiro">
      <div className="pl-progress-head">
        <span className="pl-progress-title">Roteiro</span>
        <span className="pl-progress-count" data-testid="pl-progress-count" title={`${done} de ${total} etapas concluídas`}>
          {done}/{total}
        </span>
        {onToggleCollapsed && (
          <button
            type="button"
            className="pl-rail-toggle"
            onClick={onToggleCollapsed}
            title="Recolher o roteiro"
            aria-label="Recolher o roteiro"
            aria-expanded
          >
            <IconChevronLeft size={15} />
          </button>
        )}
      </div>
      <div className="pl-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {total === 0 ? (
        <p className="pl-progress-empty">
          Nenhuma etapa ainda. Converse com o agente para separar o trabalho em etapas — cada uma vira uma coluna no
          canvas.
        </p>
      ) : (
        <ol className="pl-progress-list">
          {etapas.map((etapa, i) => {
            const label = STAGE_STATUS_LABEL[etapa.status]
            const next = STAGE_STATUS_LABEL[nextStageStatus(etapa.status)]
            return (
              <li key={etapa.id} className={`pl-step ${etapa.status}`}>
                <button
                  type="button"
                  className="pl-step-check"
                  onClick={() => onToggle(etapa.id)}
                  title={`${label} — clique para marcar como ${next.toLowerCase()}`}
                  aria-label={`${etapa.titulo}: ${label}. Marcar como ${next.toLowerCase()}`}
                >
                  <StageStatusIcon status={etapa.status} />
                </button>
                <button
                  type="button"
                  className="pl-step-name"
                  onClick={() => onFocus(etapa.id)}
                  title={`${etapa.titulo} — mostrar no canvas`}
                >
                  <span className="pl-step-num">{i + 1}</span>
                  <span className="pl-step-title">{etapa.titulo || etapa.id}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </nav>
  )
}
