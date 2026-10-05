import {
  currentEntrega,
  deadlineLevel,
  DEADLINE_ALERT_RATIO,
  tempoAtivoMinutos,
  withinDeadline,
  type HandoffEntrega,
  type HandoffEnvio
} from '../../shared/handoffTracking'
import type { HandoffEntregaPatch, HandoffEnvioPatch, HandoffTimeAdd } from '../persistence/types'
import type { EntregaPatchFor } from './handoffRules'

/**
 * O prazo de cada etapa, puro (card req-prazo-por-etapa): nada aqui lê banco,
 * relógio ou quadro. O prazo da ENTREGA é a `estimativaPlano` congelada no
 * envio; o do ENVIO, o `prazoTotal` (a soma). Conta o TEMPO ATIVO do agente —
 * retrabalho não conta.
 *
 * - Atraso: tempo ativo ACIMA do prazo marca `atrasada`/`atrasado`. É uma marca
 *   à parte — o status de execução não muda — e só vira de falso para
 *   verdadeiro (a estimativa é congelada e o tempo ativo só cresce).
 * - Aviso ao agente (card sug-aviso-ao-agente): nos marcos de 80% e 100% do
 *   prazo da etapa em andamento, uma vez por marco (`aviso80Em`/`aviso100Em`).
 *   Os limiares são os do indicador da tela (shared/handoffTracking.ts):
 *   80% inclusive; "100%" é PASSAR do prazo — exatamente no prazo ainda é
 *   dentro —, o mesmo instante em que a etapa fica atrasada.
 *
 * Nada aqui interrompe o agente: o aviso é texto anexado ao resultado de uma
 * ferramenta (card amb-estouro, opção b).
 */

/** Teto de espera do aviso no hook PostToolUse: depois disso a ferramenta segue sem ele. */
export const DEADLINE_NOTICE_TIMEOUT_MS = 2_000

export type DeadlineMark = 80 | 100

const MIN_MS = 60_000

/** Passou do prazo (minutos)? Sem prazo, nunca. A regra é a de `withinDeadline`. */
export function isLate(tempoAtivoMs: number, prazoMin: number | null): boolean {
  return withinDeadline(tempoAtivoMs, prazoMin) === false
}

/**
 * O envio lido com uma fatia de tempo somada — a que acabou de ser gravada
 * (`addHandoffTime`) ou a que ainda vai ser —, sem reler o banco. Fatia de outro
 * envio (ou nenhuma) devolve o envio como está.
 */
export function withTimeAdded(envio: HandoffEnvio, add: HandoffTimeAdd | null): HandoffEnvio {
  if (!add || add.envioId !== envio.id) return envio
  const byId = new Map((add.entregas ?? []).map((e) => [e.id, e]))
  return {
    ...envio,
    tempoAtivoMs: envio.tempoAtivoMs + (add.ativoMs ?? 0),
    retrabalhoMs: envio.retrabalhoMs + (add.retrabalhoMs ?? 0),
    entregas: envio.entregas.map((entrega) => {
      const slice = byId.get(entrega.id)
      if (!slice) return entrega
      return {
        ...entrega,
        tempoAtivoMs: entrega.tempoAtivoMs + (slice.ativoMs ?? 0),
        retrabalhoMs: entrega.retrabalhoMs + (slice.retrabalhoMs ?? 0)
      }
    })
  }
}

export interface LateMarks {
  envio: HandoffEnvioPatch | null
  entregas: EntregaPatchFor[]
}

/** O que acabou de passar do prazo: só a virada falso → verdadeiro, nunca o status. */
export function lateMarks(envio: HandoffEnvio): LateMarks {
  const entregas = envio.entregas
    .filter((e) => !e.atrasada && isLate(e.tempoAtivoMs, e.estimativaPlano))
    .map((e): EntregaPatchFor => ({ id: e.id, patch: { atrasada: true } }))
  return { envio: !envio.atrasado && isLate(envio.tempoAtivoMs, envio.prazoTotal) ? { atrasado: true } : null, entregas }
}

/**
 * A etapa cujo prazo o agente acompanha agora: a etapa ATUAL do envio (a regra
 * compartilhada `currentEntrega`), se está em andamento num envio não concluído
 * — é para ela que o tempo ativo vai — e tem prazo.
 */
export function noticeEntrega(envio: HandoffEnvio): HandoffEntrega | null {
  if (envio.status === 'concluida') return null
  const entrega = currentEntrega(envio)
  if (!entrega || entrega.status !== 'em_andamento') return null
  return entrega.estimativaPlano !== null && entrega.estimativaPlano > 0 ? entrega : null
}

/** `⏱ Etapa 3 (prazos): 34 de 40 min de trabalho …` — N é a posição da etapa no prompt. */
export function deadlineNoticeText(entrega: HandoffEntrega, mark: DeadlineMark): string {
  const head = `⏱ Etapa ${entrega.ordem} (${entrega.etapaId}): ${tempoAtivoMinutos(entrega.tempoAtivoMs)} de ${entrega.estimativaPlano ?? 0} min de trabalho`
  if (mark === 80) {
    return `${head} — 80% do prazo da etapa (tempo ativo medido pelo app). Planeje fechar a etapa dentro do prazo.`
  }
  return (
    `${head} — passou do prazo da etapa. Feche a etapa agora, corte escopo (diga o que ficou de fora) ou reporte o bloqueio. ` +
    'Ninguém vai interromper você; a etapa fica marcada como atrasada.'
  )
}

export interface DeadlineNotice {
  entregaId: string
  mark: DeadlineMark
  text: string
  /** O marco gravado; o de 100% grava também o de 80% (se faltava) e a marca de atraso. */
  patch: HandoffEntregaPatch
}

/**
 * O aviso devido AGORA, com o tempo ativo do envio já somado (o gravado + o que
 * ainda não foi). Um por chamada, uma vez por marco; quem pula direto para o
 * estouro recebe só o de 100% — e o de 80% fica gravado para não vir depois.
 */
export function deadlineNoticeFor(envio: HandoffEnvio, at: string): DeadlineNotice | null {
  const entrega = noticeEntrega(envio)
  if (!entrega || entrega.aviso100Em !== null) return null
  const level = deadlineLevel(entrega.tempoAtivoMs, entrega.estimativaPlano)
  if (level === 'estourado') {
    const patch: HandoffEntregaPatch = { aviso100Em: at }
    if (entrega.aviso80Em === null) patch.aviso80Em = at
    if (!entrega.atrasada) patch.atrasada = true
    return { entregaId: entrega.id, mark: 100, text: deadlineNoticeText(entrega, 100), patch }
  }
  if (level === 'alerta' && entrega.aviso80Em === null) {
    return { entregaId: entrega.id, mark: 80, text: deadlineNoticeText(entrega, 80), patch: { aviso80Em: at } }
  }
  return null
}

/** O envio com o aviso aplicado (o que foi gravado). */
export function withNotice(envio: HandoffEnvio, notice: DeadlineNotice | null): HandoffEnvio {
  if (!notice) return envio
  return { ...envio, entregas: envio.entregas.map((e) => (e.id === notice.entregaId ? { ...e, ...notice.patch } : e)) }
}

/**
 * Quanto tempo ATIVO falta, no mínimo, até o próximo marco ainda não avisado da
 * etapa em andamento; `null` = nenhum (sem etapa contando, sem prazo ou os dois
 * avisos já dados). Como o tempo ativo nunca anda mais rápido que o relógio,
 * nenhum aviso pode vencer antes desse tanto de relógio — é o que deixa o hook
 * não reler o banco a cada ferramenta.
 */
export function msToNextMark(envio: HandoffEnvio): number | null {
  const entrega = noticeEntrega(envio)
  if (!entrega || entrega.aviso100Em !== null || entrega.estimativaPlano === null) return null
  const prazoMs = entrega.estimativaPlano * MIN_MS
  // 80% é inclusivo; o de 100% só vence ao PASSAR do prazo (1 ms além dele).
  const target = entrega.aviso80Em === null ? prazoMs * DEADLINE_ALERT_RATIO : prazoMs + 1
  return Math.max(0, target - entrega.tempoAtivoMs)
}

/** `work` ou, passado `ms`, `null` (e `onTimeout` é chamado). Nunca rejeita pelo teto. */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve(null)
    }, ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
