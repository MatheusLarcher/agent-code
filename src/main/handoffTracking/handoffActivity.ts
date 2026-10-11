import { parseMs, type HandoffEnvio, type HandoffEnvioStatus } from '../../shared/handoffTracking'
import { STALL_ABORT_MS } from '../stallWatch'

/**
 * O SINAL DE VIDA de uma conversa de handoff, numa fonte só: a última atividade
 * vista neste processo e a escrita mais recente nos envios dela (o banco
 * compartilhado é como a conversa que roda em OUTRO PC aparece aqui). A
 * varredura (handoffJobs.markStalled → stallReason) e a fila do projeto
 * (projectQueueRules.minutesWithoutTurn) leem a MESMA atividade; só os limites
 * diferem, de propósito: a varredura marca `parada` com HANDOFF_STALL_MS (10
 * min), a fila do projeto deixa de mostrar "rodando" com PROJECT_QUEUE_LIVE_MS
 * (3 min). A carência do boot é uma só para as duas.
 */

/** Sem turno nem pergunta por tanto tempo, o envio está parado: o mesmo teto do
 *  travamento definitivo do turno (stallWatch.ts). */
export const HANDOFF_STALL_MS = STALL_ABORT_MS

/** Carência depois do boot antes de qualquer juízo de "sem turno": a recuperação
 *  do turno (sessões retomadas na abertura) precisa de tempo para subir e emitir
 *  o turn-start. A parada em si conta da atividade REAL, não do boot. */
export const BOOT_GRACE_MS = 2 * 60_000

/** Ainda dentro da carência do boot? (`bootedAt` em ms; `now` o relógio de quem pergunta.) */
export function inBootGrace(bootedAt: number, now: number): boolean {
  return now - bootedAt < BOOT_GRACE_MS
}

/**
 * A escrita mais recente nos envios da conversa, em ms (0 sem nenhuma). Com o
 * banco compartilhado, é a atividade da conversa que roda em OUTRO PC: ele grava
 * tempo no envio corrente a cada passada — e o prompt na fila atrás dele espera
 * o mesmo turno, então a parada é julgada pela conversa, não pelo envio.
 */
export function conversationLastWriteMs(envios: readonly HandoffEnvio[]): number {
  let last = 0
  for (const envio of envios) last = Math.max(last, parseMs(envio.updatedAt) ?? 0)
  return last
}

/** A última atividade da conversa, em ms: a vista neste processo (`seenMs`;
 *  `null`/ausente = nenhuma) ou a escrita mais recente nos envios — a maior. */
export function lastActivityMs(seenMs: number | null | undefined, envios: readonly HandoffEnvio[]): number {
  return Math.max(seenMs ?? 0, conversationLastWriteMs(envios))
}

/** Status de envio que a varredura pode marcar como parada. `aguardando_voce`
 *  só chega à regra sem pergunta aberta em memória (a varredura pula a conversa
 *  que tem uma): o app fechou com a pergunta aberta e ninguém mais a responde. */
const STALLABLE: ReadonlySet<HandoffEnvioStatus> = new Set(['na_fila', 'enviado', 'em_execucao', 'aguardando_voce'])

export function isStallable(status: HandoffEnvioStatus): boolean {
  return STALLABLE.has(status)
}

export interface StallContext {
  turnRunning: boolean
  /** Pergunta/permissão aberta EM MEMÓRIA (neste processo). */
  pending: boolean
  /** Última atividade da conversa: a vista neste processo (ou o início do
   *  tracker) e a escrita mais recente nos envios dela (conversationLastWriteMs), em ms. */
  lastActivityMs: number
  now: number
  limitMs?: number
}

/**
 * Por que o envio está parado, ou `null`. Na fila/enviado sem turno começar, em
 * execução sem turno rodando e sem conclusão, ou esperando você sem pergunta
 * aberta em memória, há o limite desde a última atividade (a do envio também
 * conta — lastActivityMs).
 */
export function stallReason(envio: HandoffEnvio, ctx: StallContext): string | null {
  if (ctx.turnRunning || ctx.pending || !STALLABLE.has(envio.status)) return null
  const limitMs = ctx.limitMs ?? HANDOFF_STALL_MS
  if (ctx.now - lastActivityMs(ctx.lastActivityMs, [envio]) < limitMs) return null
  const min = Math.max(1, Math.round(limitMs / 60_000))
  if (envio.status === 'na_fila') return `o prompt ficou ${min} min na fila sem ser enviado`
  if (envio.status === 'enviado') return `o prompt foi enviado, mas nenhum turno começou em ${min} min`
  if (envio.status === 'aguardando_voce') return `esperava você, mas não há pergunta aberta nem turno rodando há ${min} min`
  return `nenhum turno rodando há ${min} min, sem pergunta pendente e sem conclusão`
}
