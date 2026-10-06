/**
 * A aba "Implantação" do foco da TV num plano: o andamento dos envios DESTE
 * plano para implementação e os botões para agir. Os dados são o que o app
 * mediu e gravou no banco — o centro de Entregas do App (useDeliveryCenter),
 * que chega por contexto; nada vem do texto do modelo.
 *
 *   quais envios  o mesmo slug do plano e a mesma pasta do projeto (sem
 *                 diferença de maiúsculas nem de barras), na ordem da tela
 *                 Entregas (o que precisa de você primeiro)
 *   por envio     a linha da tela Entregas (DeliveryEnvioRow), que expande nas
 *                 entregas com "Marcar como concluída" / "Reabrir"; no canto,
 *                 "Abrir conversa" e "Ir até o agente" (a câmera na mesa dele;
 *                 fora do escritório, um aviso e a conversa)
 *   sem leitura   o motivo — nunca "nenhum envio", que seria mentira
 *
 * O "Enviar para implementação" fica no cabeçalho da Tela de Planejamento.
 */
import '../deliveries/deliveries.css'
import { useMemo, useState } from 'react'
import { currentEnvio, type HandoffEnvio, type HandoffEnvioStatus } from '@shared/handoffTracking'
import { normalizePath } from '@shared/pathGuard'
import type { DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { DeliveryEnvioRow } from '../deliveries/DeliveryEnvioRow'
import { ENVIO_STATUS_LABEL, progress, sortEnvios } from '../deliveries/deliveryModel'
import { useUI } from '../ui/UiProvider'

/** O plano em foco na TV: o que liga os envios a ele. */
export interface DeployPlan {
  slug: string
  cwd: string
  title: string
}

/** Os envios do plano: o mesmo slug e a mesma pasta, o que precisa de você primeiro. */
export function planEnvios(envios: readonly HandoffEnvio[], plan: Pick<DeployPlan, 'slug' | 'cwd'>): HandoffEnvio[] {
  const cwd = normalizePath(plan.cwd)
  return sortEnvios(envios.filter((e) => e.planSlug === plan.slug && normalizePath(e.projectCwd) === cwd))
}

export interface DeploySummary {
  /** "Implantação · 3/5 · aguardando você". */
  label: string
  /** A cor da aba: o status do envio corrente, ou `erro` sem leitura do banco. */
  status: HandoffEnvioStatus | 'erro'
}

/**
 * O resumo da aba: o envio corrente do plano (o último que saiu), com o
 * progresso e o status dele. null = a aba não aparece (sem o centro, lendo pela
 * 1ª vez ou plano sem envios); sem leitura do banco, a aba aparece com o motivo.
 */
export function deploySummary(center: DeliveryCenterValue | null, plan: Pick<DeployPlan, 'slug' | 'cwd'>): DeploySummary | null {
  if (!center) return null
  if (center.envios === null) return center.error ? { label: 'Implantação · sem leitura do banco', status: 'erro' } : null
  const list = planEnvios(center.envios, plan)
  if (list.length === 0) return null
  const cur = currentEnvio(list) ?? list[0]
  const { done, total } = progress(cur)
  return { label: `Implantação · ${done}/${total} · ${ENVIO_STATUS_LABEL[cur.status]}`, status: cur.status }
}

export interface TvDeployProps {
  plan: DeployPlan
  center: DeliveryCenterValue
  /** Fecha o foco e abre a conversa (o chat flutuante do escritório a mostra). */
  onOpenConversation: (conversationId: string) => void
  /** Fecha o foco e voa até a mesa do agente; false se ele não está no escritório agora. */
  onGoToAgent?: (conversationId: string) => boolean
}

export function TvDeploy({ plan, center, onOpenConversation, onGoToAgent }: TvDeployProps): JSX.Element {
  const { notify } = useUI()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const list = useMemo(() => (center.envios ? planEnvios(center.envios, plan) : []), [center.envios, plan])
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
