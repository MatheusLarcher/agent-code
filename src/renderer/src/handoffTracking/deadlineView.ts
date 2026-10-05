import {
  currentEntrega,
  currentEnvio,
  deadlineLevel,
  tempoAtivoMinutos,
  type DeadlineLevel,
  type HandoffEntregaStatus
} from '@shared/handoffTracking'
import type { HandoffEnviosState } from './useHandoffEnvios'

/**
 * O que o indicador de prazo mostra, decidido sem React: etapa atual (a em
 * andamento do envio corrente, ou a primeira não concluída), prazo (estimativa
 * do plano), estimativa do agente e tempo ativo — tudo do banco. A cor
 * (`level`) é a mesma regra do main: `ok` < 80% ≤ `alerta` ≤ 100% < `estourado`.
 */

export interface DeadlineView {
  level: DeadlineLevel
  /** "Etapa 1/3: Título"; `null` quando não há etapa a mostrar. */
  etapa: string | null
  /** "12 de 30 min", "12 min · sem prazo", "sem prazo"… */
  tempo: string
  /** "agente 20 min" / "agente: sem estimativa"; `null` sem etapa. */
  agente: string | null
  /** O detalhe, no title. */
  title: string
}

const STATUS_LABEL: Record<HandoffEntregaStatus, string> = {
  pendente: 'pendente',
  em_andamento: 'em andamento',
  concluida: 'concluída',
  incompleta: 'incompleta'
}

const LEVEL_NOTE: Record<DeadlineLevel, string> = {
  neutro: '',
  ok: 'dentro do prazo',
  alerta: 'passou de 80% do prazo',
  estourado: 'fora do prazo'
}

const MEDIDO = 'Tempo ativo medido pelo app (pausa quando o agente espera você), lido do banco.'

function neutral(tempo: string, title: string): DeadlineView {
  return { level: 'neutro', etapa: null, tempo, agente: null, title }
}

function percent(ms: number, prazoMin: number): number {
  return Math.round((ms / (prazoMin * 60_000)) * 100)
}

/** `null` enquanto a primeira leitura não chegou (nada a mostrar ainda). */
export function deadlineView(state: HandoffEnviosState): DeadlineView | null {
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
  if (!entrega) {
    // Todas concluídas: o envio inteiro contra a soma dos prazos.
    const y = tempoAtivoMinutos(envio.tempoAtivoMs)
    const level = deadlineLevel(envio.tempoAtivoMs, envio.prazoTotal)
    const tempo = envio.prazoTotal === null ? `${y} min · sem prazo` : `${y} de ${envio.prazoTotal} min`
    const lines = [`As ${total} etapas do prompt corrente estão concluídas.`, `Tempo ativo do prompt: ${tempo}${LEVEL_NOTE[level] ? ` — ${LEVEL_NOTE[level]}` : ''}.`, MEDIDO]
    return { level, etapa: 'Etapas concluídas', tempo, agente: null, title: lines.join('\n') }
  }

  const y = tempoAtivoMinutos(entrega.tempoAtivoMs)
  const prazo = entrega.estimativaPlano
  const level = deadlineLevel(entrega.tempoAtivoMs, prazo)
  const tempo = prazo === null ? `${y} min · sem prazo` : `${y} de ${prazo} min`
  const agente = entrega.estimativaAgente === null ? 'agente: sem estimativa' : `agente ${entrega.estimativaAgente} min`
  const lines = [
    `Etapa atual: [${entrega.etapaId}] ${entrega.etapaTitulo} (${STATUS_LABEL[entrega.status]}) — ${entrega.ordem} de ${total} do prompt.`,
    prazo === null ? 'Prazo: nenhum (o plano não estimou esta etapa).' : `Prazo (estimativa do plano): ${prazo} min.`,
    entrega.estimativaAgente === null
      ? 'Estimativa do agente: ainda não registrada.'
      : `Estimativa do agente: ${entrega.estimativaAgente} min${entrega.estimativaAgenteMotivo ? ` — ${entrega.estimativaAgenteMotivo}` : ''}.`,
    `Tempo ativo: ${y} min${prazo === null ? '' : ` (${percent(entrega.tempoAtivoMs, prazo)}% do prazo — ${LEVEL_NOTE[level]})`}.`,
    MEDIDO
  ]
  return { level, etapa: `Etapa ${entrega.ordem}/${total}: ${entrega.etapaTitulo}`, tempo, agente, title: lines.join('\n') }
}
