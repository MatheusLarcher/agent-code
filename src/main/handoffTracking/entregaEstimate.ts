import { currentEntrega, type HandoffEntrega, type HandoffEnvio } from '../../shared/handoffTracking'
import { isValidEstimativa, MAX_ESTIMATIVA_MIN } from '../../shared/planningEstimate'
import type { HandoffEntregaPatch } from '../persistence/types'
import { etapaIdFromTitle } from './handoffRules'

/**
 * As regras puras das ferramentas `entrega_estimar` e `entrega_tempo`
 * (entregaTools.ts): qual entrega a chamada alcança, o que é uma estimativa
 * válida e quanto tempo ativo a entrega tem AGORA. O tracker lê e grava; aqui
 * só se decide.
 *
 * A estimativa da implementação fica AO LADO da do plano (card amb-reestimativa,
 * opção c): o prazo é a `estimativaPlano`, congelada no envio, e nada aqui a toca.
 */

/** Teto do motivo da estimativa do agente (o mesmo das outras notas do acompanhamento). */
export const ESTIMATIVA_MOTIVO_MAX = 500

export interface EntregaEstimateRequest {
  etapa: string
  minutos: number
  motivo: string
}

/** Por que a chamada não alcançou uma entrega — cada caso vira uma frase para o modelo. */
export type EntregaMiss =
  | { ok: false; reason: 'sem_banco' }
  | { ok: false; reason: 'sem_envio' }
  | { ok: false; reason: 'sem_entregas'; envio: HandoffEnvio }
  | { ok: false; reason: 'etapa_fora'; envio: HandoffEnvio; etapa: string }
  | { ok: false; reason: 'sem_etapa_atual'; envio: HandoffEnvio }

export interface EntregaFound {
  ok: true
  envio: HandoffEnvio
  entrega: HandoffEntrega
}

export interface EntregaEstimateDone extends EntregaFound {
  /** A estimativa que esta chamada substituiu; `null` na primeira. */
  anterior: { minutos: number; motivo: string | null } | null
}
export type EntregaEstimateOutcome = EntregaEstimateDone | EntregaMiss

export interface EntregaTimeDone extends EntregaFound {
  /** Gravado + a fatia ainda não gravada, quando ela é desta entrega. */
  tempoAtivoMs: number
  /** A contagem anda para esta entrega (em andamento num envio não concluído). */
  contando: boolean
}
export type EntregaTimeOutcome = EntregaTimeDone | EntregaMiss

/** "[registro-no-banco] Registro…", " Registro-No-Banco " → "registro-no-banco". */
export function normalizeEtapa(raw: string): string {
  return (etapaIdFromTitle(raw) ?? raw.trim()).toLowerCase()
}

/** O erro de entrada da estimativa, em pt-BR, ou `null` se ela vale. */
export function estimateInputError(minutos: unknown, motivo: unknown): string | null {
  if (!isValidEstimativa(minutos)) {
    return `"minutos" precisa ser um número inteiro de 1 a ${MAX_ESTIMATIVA_MIN} (recebi ${JSON.stringify(minutos)}): são minutos de trabalho seu, inteiros.`
  }
  const text = typeof motivo === 'string' ? motivo.trim() : ''
  if (!text) return 'Diga o "motivo" da estimativa: o que você viu no código que a justifica.'
  if (text.length > ESTIMATIVA_MOTIVO_MAX) {
    return `O "motivo" tem ${text.length} caracteres; o teto é ${ESTIMATIVA_MOTIVO_MAX}. Resuma e chame de novo.`
  }
  return null
}

/**
 * A entrega que a chamada alcança no envio CORRENTE da conversa. Com `etapa`,
 * a daquele id (de outro envio = recusada); sem, a etapa atual (a em andamento
 * ou a primeira não concluída).
 */
export function findEntrega(envio: HandoffEnvio | null, etapa: string | null): EntregaFound | EntregaMiss {
  if (!envio) return { ok: false, reason: 'sem_envio' }
  if (envio.entregas.length === 0) return { ok: false, reason: 'sem_entregas', envio }
  if (etapa === null) {
    const entrega = currentEntrega(envio)
    return entrega ? { ok: true, envio, entrega } : { ok: false, reason: 'sem_etapa_atual', envio }
  }
  const id = normalizeEtapa(etapa)
  const entrega = envio.entregas.find((e) => e.etapaId.toLowerCase() === id)
  return entrega ? { ok: true, envio, entrega } : { ok: false, reason: 'etapa_fora', envio, etapa: id }
}

/** Só os campos da estimativa do AGENTE — o prazo (`estimativaPlano`) fica como está. */
export function estimatePatch(req: EntregaEstimateRequest, at: string): HandoffEntregaPatch {
  return { estimativaAgente: req.minutos, estimativaAgenteMotivo: req.motivo.trim(), estimativaAgenteEm: at }
}

/**
 * O tempo ativo da entrega AGORA. A fatia ainda não gravada só é dela se ela
 * está em andamento num envio não concluído — é para lá que o tracker a manda
 * (handoffRules.timeDistribution); depois da conclusão, o tempo é retrabalho.
 */
export function entregaActiveMs(
  envio: HandoffEnvio,
  entrega: HandoffEntrega,
  unflushedMs: number
): { tempoAtivoMs: number; contando: boolean } {
  const contando = envio.status !== 'concluida' && entrega.status === 'em_andamento'
  const extra = contando && Number.isFinite(unflushedMs) ? Math.max(0, unflushedMs) : 0
  return { tempoAtivoMs: entrega.tempoAtivoMs + extra, contando }
}
