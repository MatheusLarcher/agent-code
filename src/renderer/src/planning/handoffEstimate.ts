/**
 * O total estimado de um prompt de handoff, para o diálogo "Enviar para
 * implementação": as etapas que o prompt declarou (_handoff/<base>.meta.json)
 * somadas com as estimativas do roteiro ATUAL do plano aberto. É a mesma conta
 * que o main faz ao registrar o envio no banco (handoffRegister) — o que o
 * diálogo mostra é o prazo que vai ser gravado.
 */
import { formatMinutos, isValidEstimativa } from '@shared/planningEstimate'

/** Teto de etapas por prompt (o mesmo do plan_handoff_write e do planningWriteHandoff). */
export const MAX_HANDOFF_ETAPAS = 100

export interface HandoffEstimateItem {
  id: string
  /** Título no roteiro atual; a etapa que sumiu dele fica com o id. */
  titulo: string
  /** Minutos; `null` = sem estimativa (ou etapa que sumiu do roteiro). */
  estimativa: number | null
}

export interface HandoffEstimate {
  /** Soma das estimativas que existem, em minutos. */
  total: number
  /** Quantas etapas declaradas ficaram sem estimativa. */
  semEstimativa: number
  /** As etapas declaradas, na ordem do prompt. */
  itens: HandoffEstimateItem[]
}

type RoteiroEtapa = { id: string; titulo?: string; estimativa?: number | null }

/** `null` quando o prompt não declarou etapas (prompt antigo): sem total nem prazo. */
export function handoffEstimate(
  etapas: readonly string[] | undefined,
  roteiro: readonly RoteiroEtapa[]
): HandoffEstimate | null {
  if (!etapas || etapas.length === 0) return null
  const byId = new Map(roteiro.map((e) => [e.id, e]))
  let total = 0
  let semEstimativa = 0
  const itens = etapas.map((id): HandoffEstimateItem => {
    const etapa = byId.get(id)
    const valor = etapa?.estimativa
    const estimativa = isValidEstimativa(valor) ? valor : null
    if (estimativa === null) semEstimativa++
    else total += estimativa
    return { id, titulo: etapa?.titulo?.trim() || id, estimativa }
  })
  return { total, semEstimativa, itens }
}

const etapasText = (n: number): string => (n === 1 ? '1 etapa' : `${n} etapas`)

/** A linha do prompt no diálogo: "Total estimado: 1 h 50 min · 2 etapas" ou "sem etapas declaradas". */
export function handoffEstimateLabel(est: HandoffEstimate | null): string {
  if (!est) return 'sem etapas declaradas'
  const n = est.itens.length
  if (est.semEstimativa === n) return `${etapasText(n)}, nenhuma com estimativa`
  const falta = est.semEstimativa > 0 ? `, ${est.semEstimativa} sem estimativa` : ''
  return `Total estimado: ${formatMinutos(est.total)} · ${etapasText(n)}${falta}`
}

/** A dica (title) com etapa → estimativa, uma por linha. */
export function handoffEstimateDetail(est: HandoffEstimate | null): string {
  if (!est) return 'Prompt sem o arquivo de etapas: o envio é registrado sem entregas e sem prazo.'
  return est.itens.map((i) => `${i.titulo}: ${i.estimativa === null ? 'sem estimativa' : formatMinutos(i.estimativa)}`).join('\n')
}

/** As etapas do rascunho automático: todas as do roteiro, na ordem (até o teto por prompt). */
export function roteiroEtapaIds(roteiro: readonly { id: string }[]): string[] {
  return roteiro.slice(0, MAX_HANDOFF_ETAPAS).map((e) => e.id)
}
