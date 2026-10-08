/**
 * A aba "Implantação" do foco da TV num plano: o andamento dos envios DESTE
 * plano para implementação e os botões para agir. Os dados são o que o app
 * mediu e gravou no banco — o centro de Entregas do App (useDeliveryCenter),
 * que chega por contexto; nada vem do texto do modelo.
 *
 *   quais envios  os do plano (planEnviosOf: o mesmo slug e a mesma pasta, sem
 *                 diferença de maiúsculas nem de barras), na ordem da tela
 *                 Entregas (o que precisa de você primeiro: sortEnvios)
 *   o roteiro     as etapas do plano com id (planning:peek, no cache da TV:
 *                 tvPlans.ts) — as contas ficam iguais às da placa da obra
 *                 mesmo com o plano mandado em partes
 *   a aba         o envio de agora e as etapas prontas do plano (planProgress)
 *   por envio     a linha da tela Entregas (DeliveryEnvioRow, "Etapa N de M"
 *                 pela posição no plano), que expande nas entregas com
 *                 "Marcar como concluída" / "Reabrir"; no canto, "Abrir
 *                 conversa" e "Ir até o agente" (a câmera na mesa dele; fora do
 *                 escritório, um aviso e a conversa)
 *   sem leitura   o motivo — nunca "nenhum envio", que seria mentira
 *
 * O "Enviar para implementação" fica no cabeçalho da Tela de Planejamento.
 */
import '../deliveries/deliveries.css'
import { useMemo, useState } from 'react'
import type { HandoffEnvioStatus } from '@shared/handoffTracking'
import { planEnviosOf, planProgress, type PlanRoteiro } from '@shared/stepProgress'
import type { DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { DeliveryEnvioRow } from '../deliveries/DeliveryEnvioRow'
import { ENVIO_STATUS_LABEL, sortEnvios } from '../deliveries/deliveryModel'
import { usePlanRoteiro } from '../handoffTracking/usePlanRoteiro'
import { useUI } from '../ui/UiProvider'
import { appPeekApi, planPeeksFor, roteiroOfPeek, type PeekApi } from './tvPlans'

/** O plano em foco na TV: o que liga os envios a ele. */
export interface DeployPlan {
  slug: string
  cwd: string
  title: string
}

/** O roteiro já no cache da TV (ela pinta o plano antes do foco abrir), sem pedir nada. */
function cachedRoteiro(plan: Pick<DeployPlan, 'slug' | 'cwd'>): PlanRoteiro | null {
  return roteiroOfPeek(planPeeksFor(appPeekApi())?.cached(plan) ?? null)
}

export interface DeploySummary {
  /** "Implantação · 3/5 · aguardando você". */
  label: string
  /** A cor da aba: o status do envio corrente, ou `erro` sem leitura do banco. */
  status: HandoffEnvioStatus | 'erro'
}

/**
 * O resumo da aba: as etapas prontas do plano (planProgress com o roteiro, as
 * mesmas contas da placa) e o status do envio de agora. `roteiro`: o foco da TV
 * passa o de usePlanRoteiro (a aba se atualiza quando ele chega); padrão, o que
 * já está no cache da TV, sem assinar (sem ele, conta as etapas enviadas).
 * null = a aba não aparece (sem o centro, lendo pela 1ª vez ou plano sem
 * envios); sem leitura do banco, a aba aparece com o motivo.
 */
export function deploySummary(
  center: DeliveryCenterValue | null,
  plan: Pick<DeployPlan, 'slug' | 'cwd'>,
  roteiro: PlanRoteiro | null = cachedRoteiro(plan)
): DeploySummary | null {
  if (!center) return null
  if (center.envios === null) return center.error ? { label: 'Implantação · sem leitura do banco', status: 'erro' } : null
  const { prontas, total, envioAtual: cur } = planProgress(planEnviosOf(center.envios, plan.cwd, plan.slug), roteiro)
  if (!cur) return null
  return { label: `Implantação · ${prontas}/${total} · ${ENVIO_STATUS_LABEL[cur.status]}`, status: cur.status }
}

export interface TvDeployProps {
  plan: DeployPlan
  center: DeliveryCenterValue
  /** Fecha o foco e abre a conversa (o chat flutuante do escritório a mostra). */
  onOpenConversation: (conversationId: string) => void
  /** Fecha o foco e voa até a mesa do agente; false se ele não está no escritório agora. */
  onGoToAgent?: (conversationId: string) => boolean
  /** O resumo do plano (planning:peek); injetável nos testes, padrão: window.api. */
  peekApi?: PeekApi | null
}

export function TvDeploy({ plan, center, onOpenConversation, onGoToAgent, peekApi }: TvDeployProps): JSX.Element {
  const { notify } = useUI()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const roteiro = usePlanRoteiro(plan.cwd, plan.slug, peekApi)
  const envios = useMemo(() => (center.envios ? planEnviosOf(center.envios, plan.cwd, plan.slug) : []), [center.envios, plan.cwd, plan.slug])
  const progress = useMemo(() => planProgress(envios, roteiro), [envios, roteiro])
  const list = useMemo(() => sortEnvios(envios), [envios])
  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const goTo = (convId: string): void => {
    if (onGoToAgent?.(convId)) return
    notify('aviso', 'O agente desta implementação não está no escritório agora (filtro de projeto ou conversa fechada). Abri a conversa dele.')
    onOpenConversation(convId)
  }
  return (
    <div className="tvf-deploy" data-testid="tv-deploy">
      {center.error && (
        <div className="dlv-error" role="alert">
          Não consegui ler as entregas do banco: {center.error}
        </div>
      )}
      {center.envios !== null && (
        <ul className="dlv-list" aria-label={`Implantação de ${plan.title}`}>
          {list.map((envio) => (
            <DeliveryEnvioRow
              key={envio.id}
              envio={envio}
              plan={progress}
              expanded={expanded.has(envio.id)}
              onToggle={() => toggle(envio.id)}
              onOpenConversation={onOpenConversation}
              correct={center.correct}
              actions={
                <>
                  <button type="button" className="btn ghost dlv-act" onClick={() => onOpenConversation(envio.conversationId)}>
                    Abrir conversa
                  </button>
                  <button type="button" className="btn ghost dlv-act" title="Fecha a TV e leva a câmera até a mesa do agente" onClick={() => goTo(envio.conversationId)}>
                    Ir até o agente
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  )
}
