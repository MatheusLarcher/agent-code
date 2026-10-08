import { useState, type ReactNode } from 'react'
import { tempoAtivoMinutos, type HandoffEntrega, type HandoffEnvio } from '@shared/handoffTracking'
import { formatMinutos } from '@shared/planningEstimate'
import { ENTREGA_STATUS_LABEL, planProgress, stepLabel, type PlanProgress } from '@shared/stepProgress'
import { useUI } from '../ui/UiProvider'
import { ENVIO_STATUS_LABEL, isLate, projectName } from './deliveryModel'
import type { DeliveriesState } from './useDeliveries'

/**
 * Uma linha da tela Entregas: o envio e, expandido, as entregas (etapas) dele.
 * As contas são as da regra única (shared/stepProgress): prontas/total das
 * etapas DESTE prompt (planProgress do envio) e "Etapa N de M" da etapa de
 * agora dele pela posição no PLANO (stepLabel com o progresso do plano).
 */

type Correct = DeliveriesState['correct']

function minutes(min: number | null): string {
  return min === null ? '—' : formatMinutos(min)
}

function realTime(ms: number): string {
  return formatMinutos(tempoAtivoMinutos(ms))
}

function LateMark(): JSX.Element {
  return (
    <span className="dlv-tag late" title="Passou do prazo (a estimativa do plano)">
      atrasada
    </span>
  )
}

function EntregaRow({ entrega, correct }: { entrega: HandoffEntrega; correct: Correct }): JSX.Element {
  const { notify } = useUI()
  const [pending, setPending] = useState<'concluir' | 'reabrir' | null>(null)
  const run = async (acao: 'concluir' | 'reabrir'): Promise<void> => {
    setPending(acao)
    const res = await correct(entrega.id, acao)
    setPending(null)
    if (res.ok) {
      notify('sucesso', acao === 'concluir' ? `Entrega "${entrega.etapaTitulo}" marcada como concluída.` : `Entrega "${entrega.etapaTitulo}" reaberta.`)
    } else {
      notify('erro', `Não consegui corrigir a entrega "${entrega.etapaTitulo}": ${res.message}`)
    }
  }
  const canConclude = entrega.status !== 'concluida'
  const canReopen = entrega.status === 'concluida' || entrega.status === 'incompleta'
  return (
    <li className={`dlv-entrega s-${entrega.status}`} data-testid="dlv-entrega">
      <div className="dlv-entrega-head">
        <span className="dlv-entrega-ordem">{entrega.ordem}</span>
        <span className="dlv-entrega-title">{entrega.etapaTitulo}</span>
        <span className={`dlv-status s-${entrega.status}`}>{ENTREGA_STATUS_LABEL[entrega.status]}</span>
        {entrega.atrasada && <LateMark />}
        {entrega.auditada === false && (
          <span className="dlv-tag" title="Concluída com o PO desligado: ninguém conferiu a entrega">
            não auditada
          </span>
        )}
        {entrega.corrigidoPor === 'usuario' && (
          <span className="dlv-tag user" title={entrega.corrigidoEm ? `Corrigida em ${new Date(entrega.corrigidoEm).toLocaleString()}` : undefined}>
            corrigida por você
          </span>
        )}
      </div>
      <div className="dlv-entrega-times">
        <span title="Estimativa do plano (o prazo da etapa)">plano {minutes(entrega.estimativaPlano)}</span>
        <span className="dlv-x">×</span>
        <span title={entrega.estimativaAgenteMotivo ?? 'Estimativa dada pela implementação (não muda o prazo)'}>
          agente {minutes(entrega.estimativaAgente)}
        </span>
        <span className="dlv-x">×</span>
        <span title="Tempo ativo medido pelo app (pausa quando o agente espera você)">real {realTime(entrega.tempoAtivoMs)}</span>
      </div>
      {entrega.motivo && <div className="dlv-motivo">{entrega.motivo}</div>}
      <div className="dlv-entrega-actions">
        {canConclude && (
          <button type="button" className="btn ghost dlv-act" disabled={pending !== null} onClick={() => void run('concluir')}>
            {pending === 'concluir' ? 'Concluindo…' : 'Marcar como concluída'}
          </button>
        )}
        {canReopen && (
          <button type="button" className="btn ghost dlv-act" disabled={pending !== null} onClick={() => void run('reabrir')}>
            {pending === 'reabrir' ? 'Reabrindo…' : 'Reabrir'}
          </button>
        )}
      </div>
    </li>
  )
}

export interface DeliveryEnvioRowProps {
  envio: HandoffEnvio
  /** O progresso do plano do envio (planProgress com os envios do plano e o roteiro): numera "Etapa N de M". */
  plan: PlanProgress
  expanded: boolean
  onToggle: () => void
  onOpenConversation: (conversationId: string) => void
  correct: Correct
  /** Botões a mais no canto da linha (a aba Implantação da TV); a tela Entregas não passa nada. */
  actions?: ReactNode
}

export function DeliveryEnvioRow({ envio, plan, expanded, onToggle, onOpenConversation, correct, actions }: DeliveryEnvioRowProps): JSX.Element {
  const { prontas, total } = planProgress([envio])
  const plano = envio.planTitulo || envio.planSlug
  const entregas = [...envio.entregas].sort((a, b) => a.ordem - b.ordem)
  return (
    <li className={`dlv-envio s-${envio.status}${expanded ? ' open' : ''}`} data-testid="dlv-envio" data-envio-id={envio.id}>
      <div className="dlv-envio-head">
        <button
          type="button"
          className="dlv-expand"
          aria-expanded={expanded}
          aria-label={expanded ? `Esconder as entregas de ${plano}` : `Ver as entregas de ${plano}`}
          onClick={onToggle}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        <div className="dlv-envio-main">
          <div className="dlv-envio-line">
            <span className={`dlv-status s-${envio.status}`}>{ENVIO_STATUS_LABEL[envio.status]}</span>
            {isLate(envio) && <LateMark />}
            <span className="dlv-plan" title={envio.planSlug}>
              {plano}
            </span>
            <span className="dlv-progress" title="Etapas deste prompt prontas / total">
              {prontas}/{total}
            </span>
          </div>
          <div className="dlv-envio-meta">
            <span className="dlv-project" title={envio.projectCwd}>
              {projectName(envio.projectCwd)}
            </span>
            <span className="dlv-sep">·</span>
            <button
              type="button"
              className="dlv-conv-link"
              title="Abrir a conversa"
              onClick={() => onOpenConversation(envio.conversationId)}
            >
              {envio.conversationTitle || 'Conversa'}
            </button>
            <span className="dlv-sep">·</span>
            <span className="dlv-current">{stepLabel(plan, envio)}</span>
            <span className="dlv-sep">·</span>
            <span className="dlv-times" title="Prazo do envio (soma das estimativas do plano) × tempo ativo medido pelo app">
              estimado {minutes(envio.prazoTotal)} × real {realTime(envio.tempoAtivoMs)}
            </span>
          </div>
          {envio.motivo && <div className="dlv-motivo">{envio.motivo}</div>}
        </div>
        {actions && <div className="dlv-envio-actions">{actions}</div>}
      </div>
      {expanded && (
        <ul className="dlv-entregas" aria-label={`Entregas de ${plano}`}>
          {entregas.length === 0 ? (
            <li className="dlv-empty-entregas">Este prompt não declarou etapas.</li>
          ) : (
            entregas.map((e) => <EntregaRow key={e.id} entrega={e} correct={correct} />)
          )}
        </ul>
      )}
    </li>
  )
}
