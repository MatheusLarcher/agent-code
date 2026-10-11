import {
  currentEntrega,
  currentEnvio,
  deadlineLevel,
  tempoAtivoMinutos,
  type DeadlineLevel,
  type HandoffEnvio
} from '@shared/handoffTracking'
import { ENTREGA_STATUS_LABEL, planEnviosOf, planProgress, stepLabel, type PlanRoteiro } from '@shared/stepProgress'
import type { HandoffEnviosState } from './useHandoffEnvios'

/**
 * O que o indicador de prazo mostra, decidido sem React: etapa atual (a em
 * andamento do envio corrente, ou a primeira não concluída), o placar do plano,
 * prazo (estimativa do plano), estimativa do agente e tempo ativo — tudo do
 * banco. A cor (`level`) é a mesma regra do main: `ok` < 80% ≤ `alerta` ≤ 100% < `estourado`.
 *
 * "Etapa N de M" é a POSIÇÃO NO PLANO (stepLabel/planProgress, a mesma da placa
 * e da TV): conta os envios do plano no projeto (de qualquer conversa) e o
 * roteiro; sem eles, os desta conversa. O placar ("✓ N/M": prontas/total) sai da
 * MESMA conta — todo contador de etapas numa conversa de handoff vem de
 * planProgress (as entregas do banco), nunca da lista de tarefas do agente.
 */

/** O plano do envio corrente: os envios dele no projeto e o roteiro (null = ainda não leu / não tem). */
export interface DeadlinePlan {
  envios: readonly HandoffEnvio[] | null
  roteiro: PlanRoteiro | null
}

/** O placar do plano: etapas prontas e incompletas sobre o total (as contas de planProgress). */
export interface DeadlinePlacar {
  prontas: number
  total: number
  incompletas: number
}

export interface DeadlineView {
  level: DeadlineLevel
  /** "Etapa 3 de 5: Título"; `null` quando não há etapa a mostrar. */
  etapa: string | null
  /** "✓ 3/5" na tela; `null` quando não há etapa/plano (junto com `etapa`). */
  placar: DeadlinePlacar | null
  /** "12 de 30 min", "12 min · sem prazo", "sem prazo"… */
  tempo: string
  /** "agente 20 min" / "agente: sem estimativa"; `null` sem etapa. */
  agente: string | null
  /** O detalhe, no title. */
  title: string
}

const LEVEL_NOTE: Record<DeadlineLevel, string> = {
  neutro: '',
  ok: 'dentro do prazo',
  alerta: 'passou de 80% do prazo',
  estourado: 'fora do prazo'
}

const MEDIDO = 'Tempo ativo medido pelo app (pausa quando o agente espera você), lido do banco.'

function neutral(tempo: string, title: string): DeadlineView {
  return { level: 'neutro', etapa: null, placar: null, tempo, agente: null, title }
}

function percent(ms: number, prazoMin: number): number {
  return Math.round((ms / (prazoMin * 60_000)) * 100)
}

/**
 * O rótulo da etapa do envio e o placar do plano, da MESMA conta (planProgress):
 * os envios do plano dele (os desta conversa por cima dos lidos do projeto — a
 * leitura da conversa é a mais fresca para os dela, e a do projeto pode ser de
 * antes do registro) e o roteiro.
 */
function etapaInfo(envio: HandoffEnvio, conversa: readonly HandoffEnvio[], plan: DeadlinePlan | undefined): { etapa: string; placar: DeadlinePlacar } {
  const mine = planEnviosOf(conversa, envio.projectCwd, envio.planSlug)
  const ids = new Set(mine.map((e) => e.id))
  const others = planEnviosOf(plan?.envios ?? [], envio.projectCwd, envio.planSlug).filter((e) => !ids.has(e.id))
  const progress = planProgress([...mine, ...others], plan?.roteiro)
  const { prontas, total, incompletas } = progress
  return { etapa: stepLabel(progress, envio), placar: { prontas, total, incompletas } }
}

/** A linha do placar no title: "9 de 10 etapas prontas, 1 incompleta." */
function placarLine({ prontas, total, incompletas }: DeadlinePlacar): string {
  return `${prontas} de ${total} etapas prontas, ${incompletas} ${incompletas === 1 ? 'incompleta' : 'incompletas'}.`
}

/** `null` enquanto a primeira leitura não chegou (nada a mostrar ainda). */
export function deadlineView(state: HandoffEnviosState, plan?: DeadlinePlan): DeadlineView | null {
  if (!state.envios) {
    return state.error ? neutral('prazo indisponível', `Não consegui ler o prazo do banco: ${state.error}`) : null
  }
  const envio = currentEnvio(state.envios)
  if (!envio) return neutral('sem prazo', 'Nenhum prompt de handoff desta conversa foi registrado como enviado.')
  if (envio.entregas.length === 0) {
    return neutral('sem prazo', `O prompt corrente (${envio.arquivo}) não declarou etapas: não há prazo por etapa.`)
  }
  const total = envio.entregas.length
  const entrega = currentEntrega(envio)
  const { etapa, placar } = etapaInfo(envio, state.envios, plan)
  if (!entrega) {
    // Todas concluídas ("Etapas concluídas"): o envio inteiro contra a soma dos prazos.
    const y = tempoAtivoMinutos(envio.tempoAtivoMs)
    const level = deadlineLevel(envio.tempoAtivoMs, envio.prazoTotal)
    const tempo = envio.prazoTotal === null ? `${y} min · sem prazo` : `${y} de ${envio.prazoTotal} min`
    const lines = [
      `As ${total} etapas do prompt corrente estão concluídas.`,
      placarLine(placar),
      `Tempo ativo do prompt: ${tempo}${LEVEL_NOTE[level] ? ` — ${LEVEL_NOTE[level]}` : ''}.`,
      MEDIDO
    ]
    return { level, etapa, placar, tempo, agente: null, title: lines.join('\n') }
  }

  const y = tempoAtivoMinutos(entrega.tempoAtivoMs)
  const prazo = entrega.estimativaPlano
  const level = deadlineLevel(entrega.tempoAtivoMs, prazo)
  const tempo = prazo === null ? `${y} min · sem prazo` : `${y} de ${prazo} min`
  const agente = entrega.estimativaAgente === null ? 'agente: sem estimativa' : `agente ${entrega.estimativaAgente} min`
  const lines = [
    `Etapa atual: ${etapa} [${entrega.etapaId}] — ${ENTREGA_STATUS_LABEL[entrega.status]}.`,
    placarLine(placar),
    prazo === null ? 'Prazo: nenhum (o plano não estimou esta etapa).' : `Prazo (estimativa do plano): ${prazo} min.`,
    entrega.estimativaAgente === null
      ? 'Estimativa do agente: ainda não registrada.'
      : `Estimativa do agente: ${entrega.estimativaAgente} min${entrega.estimativaAgenteMotivo ? ` — ${entrega.estimativaAgenteMotivo}` : ''}.`,
    `Tempo ativo: ${y} min${prazo === null ? '' : ` (${percent(entrega.tempoAtivoMs, prazo)}% do prazo — ${LEVEL_NOTE[level]})`}.`,
    MEDIDO
  ]
  return { level, etapa, placar, tempo, agente, title: lines.join('\n') }
}
