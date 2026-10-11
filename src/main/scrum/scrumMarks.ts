import type { HandoffEntrega, HandoffEnvio } from '../../shared/handoffTracking'
import { noticeEntrega } from '../handoffTracking/handoffDeadline'
import { SCRUM_ESPERA_ENTREGA_MS, SCRUM_MARCOS, type ScrumDecisao, type ScrumMarco } from './scrumTypes'

/**
 * Os GATILHOS do Scrum Master, puros: nada aqui lê relógio, banco ou disco.
 *
 * - Marcos: 150%, 200% e 300% do prazo da etapa em andamento (a regra
 *   `noticeEntrega` de handoffDeadline.ts), contra o TEMPO ATIVO da entrega —
 *   retrabalho não conta, igual ao prazo de hoje. Uma vez por marco, por
 *   entrega; quem salta de 120% para 210% recebe só o de 200% e o de 150% fica
 *   disparado junto (o molde do 80/100 em `deadlineNoticeFor`).
 * - O "já disparou" é o MAIOR marco disparado de cada entrega: o tempo ativo só
 *   cresce, então um marco disparado cobre os de baixo. Vem do diário ao abrir
 *   o app (firedFromLog) — sem coluna no banco.
 * - Travado: cobrança pendente há a espera (10 min) COM turno rodando.
 */

const MIN_MS = 60_000

/** O maior marco já disparado, por entrega. */
export type ScrumFired = Map<string, ScrumMarco>

/**
 * A escala de dev (`AGENT_CODE_SCRUM_ESCALA`): maior que 0 e até 1. No app
 * empacotado, ausente ou inválida, vale 1.
 */
export function scrumEscala(raw: string | undefined, packaged: boolean): number {
  if (packaged || raw === undefined || raw.trim() === '') return 1
  const n = Number(raw.trim())
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1
}

/** O prazo que o SM enxerga, em ms inteiros (o tempo ativo é inteiro): o do plano vezes a escala. */
export function scrumPrazoMs(prazoMin: number, escala: number): number {
  return Math.round(prazoMin * MIN_MS * escala)
}

/** A espera da cobrança pendente até o travado, com a mesma escala do prazo. */
export function scrumEsperaMs(escala: number): number {
  return Math.round(SCRUM_ESPERA_ENTREGA_MS * escala)
}

export interface ScrumMarkDue {
  entrega: HandoffEntrega
  marco: ScrumMarco
  /** Os marcos de baixo que o salto pulou: ficam disparados sem consulta própria. */
  pulados: ScrumMarco[]
  /** O prazo que o SM enxergou (ms, já com a escala). */
  prazoMs: number
}

/** O marco devido AGORA na etapa em andamento; `null` = nenhum. */
export function dueScrumMark(envio: HandoffEnvio, escala: number, fired: ReadonlyMap<string, ScrumMarco>): ScrumMarkDue | null {
  const entrega = noticeEntrega(envio)
  if (!entrega || entrega.estimativaPlano === null) return null
  const prazoMs = scrumPrazoMs(entrega.estimativaPlano, escala)
  const tempo = Math.max(0, entrega.tempoAtivoMs)
  const reached = SCRUM_MARCOS.filter((m) => tempo >= (prazoMs * m) / 100)
  const top = reached[reached.length - 1]
  if (top === undefined) return null
  const maior = fired.get(entrega.id) ?? 0
  if (maior >= top) return null
  return { entrega, marco: top, pulados: reached.filter((m) => m < top && m > maior), prazoMs }
}

/** Grava o disparo (só sobe: um marco menor nunca rebaixa o maior). */
export function noteFired(fired: ScrumFired, entregaId: string, marco: ScrumMarco): void {
  if ((fired.get(entregaId) ?? 0) < marco) fired.set(entregaId, marco)
}

/** O "já disparou" relido do diário: toda linha com entrega e marco numérico. */
export function firedFromLog(decisoes: Iterable<Pick<ScrumDecisao, 'entregaId' | 'marco'>>): ScrumFired {
  const fired: ScrumFired = new Map()
  for (const d of decisoes) {
    if (d.entregaId && typeof d.marco === 'number' && SCRUM_MARCOS.includes(d.marco)) noteFired(fired, d.entregaId, d.marco)
  }
  return fired
}

/**
 * Gatilho de travado: a cobrança pendente desde `pendenteDesde` (ms) não chegou
 * ao agente em `esperaMs` e o turno segue rodando. Sem turno, nada: a varredura
 * marca `parada` e a cobrança sai na primeira ferramenta do turno retomado.
 */
export function travadoDue(pendenteDesde: number | null, now: number, turnRunning: boolean, esperaMs: number): boolean {
  return pendenteDesde !== null && turnRunning && now - pendenteDesde >= esperaMs
}
