import { resumeCount } from './handoffResumes'
import {
  currentEnvio,
  HANDOFF_RESUME_TEXT,
  isIncompleteWithoutError,
  isStallMotivo,
  isEnvioHeldByPo,
  isEnvioRemoved,
  isEnvioSent,
  isPoRequestEnvio,
  isRoutineEnvio,
  type HandoffEnvio,
  type HandoffEnvioStatus,
  type HandoffQueueDecision,
  type HandoffQueuedPrompt
} from '../../shared/handoffTracking'

/**
 * A FILA DO QUADRO de uma conversa de implantação: os prompts 2..N de um
 * "Enviar para implementação" não entram mais na fila de mensagens do chat —
 * ficam só como envios `na_fila` no banco, e esta regra fixa (sem modelo)
 * decide se o próximo sai. O PO julga o que ficou concluído; quem solta o
 * próximo é o código: se o PO falhar, cair no cooldown ou estiver desligado, a
 * implantação não para por causa dele (card "O PO julga, o código despacha").
 *
 * - envio anterior `concluida` → sai o envio na fila de menor `ordem` do lote;
 * - anterior `incompleta` → sai também, com o cabeçalho da pendência na frente
 *   (a pendência continua sendo feita, só não espera clique);
 * - anterior `parada` por INATIVIDADE → o mesmo envio retoma uma vez
 *   (`retomada`); na 2ª parada, a fila para;
 * - qualquer outro estado (Stop, tirado da fila, esperando você, erro, PO) →
 *   a fila PARA, com o motivo que o acompanhamento já escreveu; "Enviar mesmo
 *   assim" (`force`) solta;
 * - nada saiu ainda → `none`: o 1º prompt é do diálogo de envio, nunca daqui.
 */

/** Por que a fila parou, pelo estado do envio anterior (o motivo gravado vem depois). */
const HOLD_REASON: Record<HandoffEnvioStatus, string> = {
  na_fila: 'o prompt anterior ainda não saiu',
  enviado: 'o prompt anterior ainda não começou',
  em_execucao: 'o prompt anterior ainda está rodando',
  aguardando_voce: 'o prompt anterior está esperando você',
  parada: 'o prompt anterior parou',
  falhou: 'o prompt anterior terminou com erro',
  incompleta: 'o prompt anterior não foi concluído',
  concluida: ''
}

/** O anterior ainda trabalha: a fila espera a vez, não está parada. */
export function previousRunning(previous: HandoffEnvio): boolean {
  return previous.status === 'enviado' || previous.status === 'em_execucao'
}

/** Os envios que ainda não saíram, na ordem do plano (os tirados da fila ficam de
 *  fora; a rotina autorizada do PO vem na frente dos prompts). */
export function queuedEnvios(envios: readonly HandoffEnvio[]): HandoffEnvio[] {
  const rank = (envio: HandoffEnvio): number => (isRoutineEnvio(envio) ? 0 : 1)
  return envios
    .filter((envio) => !isEnvioSent(envio) && !isEnvioRemoved(envio))
    .sort((a, b) => rank(a) - rank(b) || a.ordem - b.ordem || a.id.localeCompare(b.id))
}

function prompt(envio: HandoffEnvio): HandoffQueuedPrompt {
  return {
    id: envio.id,
    conversationId: envio.conversationId,
    loteId: envio.loteId,
    ordem: envio.ordem,
    arquivo: envio.arquivo,
    conteudo: envio.conteudo
  }
}

/** O motivo da parada: o estado do anterior e, quando há, o que o acompanhamento gravou. */
export function holdReason(previous: HandoffEnvio): string {
  const base = HOLD_REASON[previous.status] || 'o prompt anterior não foi concluído'
  const detail = previous.motivo?.trim()
  return detail ? `${base}: ${detail}` : base
}

/** A fila segura depois da 2ª parada por inatividade do mesmo envio. */
export const STALLED_TWICE_REASON = 'o prompt anterior parou duas vezes'

/**
 * O cabeçalho do próximo prompt quando o anterior ficou `incompleta`: a fila
 * não espera clique — a pendência vai junto e é fechada primeiro, com evidência.
 * Só no texto despachado; o arquivo em _handoff/ não muda.
 */
export function incompleteHeader(previous: Pick<HandoffEnvio, 'motivo'>): string {
  const faltou = previous.motivo?.trim() || 'o que o acompanhamento não viu concluído'
  return `Antes de começar: o envio anterior ficou incompleto — faltou: ${faltou}. Feche isso primeiro, com evidência (teste, typecheck, arquivo), depois siga com o prompt abaixo.\n\n---\n\n`
}

export interface DecideQueueOptions {
  force?: boolean
  /** Quantas vezes o envio já foi retomado (padrão: o contador em memória do main). */
  resumeCount?: (envioId: string) => number
}

export function decideQueue(envios: readonly HandoffEnvio[], opts: DecideQueueOptions = {}): HandoffQueueDecision {
  const queued = queuedEnvios(envios)
  if (queued.length === 0) return { kind: 'none' }
  // A rotina autorizada (commit/push do PO) sai assim que a conversa fica livre,
  // na frente do próximo prompt — também em conversa sem plano ("sempre").
  if (isRoutineEnvio(queued[0])) return { kind: 'next', envio: prompt(queued[0]) }
  // O "Pedido do PO" (o "Mandar fazer" do "Fala, PO") já foi aprovado no clique:
  // sai assim que a conversa fica livre — também como o 1º prompt dela. Só
  // espera o turno que ainda roda ou a pergunta aberta ao usuário.
  if (isPoRequestEnvio(queued[0])) {
    const head = queued[0]
    const before = currentEnvio(envios.filter((envio) => !isRoutineEnvio(envio) && envio.id !== head.id))
    const busy = !!before && (previousRunning(before) || before.status === 'aguardando_voce')
    return busy && !opts.force ? { kind: 'hold', envio: prompt(head), motivo: holdReason(before!) } : { kind: 'next', envio: prompt(head) }
  }
  // O anterior é o último PROMPT que saiu: a rotina não fala por ele.
  const previous = currentEnvio(envios.filter((envio) => !isRoutineEnvio(envio)))
  if (!previous) return { kind: 'none' }
  // Dentro do lote do anterior; um lote de fora só se o dele acabou.
  const sameLote = queued.filter((envio) => envio.loteId === previous.loteId)
  const next = (sameLote.length > 0 ? sameLote : queued)[0]
  // O commit autorizado ainda roda: o próximo prompt espera ele acabar.
  const routineRunning = envios.some((e) => isRoutineEnvio(e) && (e.status === 'enviado' || e.status === 'em_execucao'))
  if (!opts.force && routineRunning) return { kind: 'hold', envio: prompt(next), motivo: 'o commit autorizado ainda está rodando' }
  // O PO segurou este prompt (a resposta do agente contradiz uma premissa dele):
  // só o "Enviar mesmo assim", editar ou tirar da fila soltam.
  if (!opts.force && isEnvioHeldByPo(next)) return { kind: 'hold', envio: prompt(next), motivo: next.motivo ?? '' }
  if (opts.force || previous.status === 'concluida') return { kind: 'next', envio: prompt(next) }
  // Incompleto (sem erro do turno): o próximo sai sozinho, levando a pendência
  // na frente. O incompleto por ERRO do turno segura, como o `falhou`.
  if (isIncompleteWithoutError(previous)) {
    const envio = prompt(next)
    return { kind: 'next', envio: { ...envio, conteudo: incompleteHeader(previous) + envio.conteudo } }
  }
  // Parado por inatividade (não pelo Stop, nem tirado da fila): o MESMO envio
  // retoma uma vez; parou de novo, a fila segura e espera você.
  if (previous.status === 'parada' && isStallMotivo(previous.motivo)) {
    const count = (opts.resumeCount ?? resumeCount)(previous.id)
    if (count >= 1) return { kind: 'hold', envio: prompt(next), motivo: `${STALLED_TWICE_REASON}: ${previous.motivo}` }
    return { kind: 'next', envio: { ...prompt(previous), conteudo: HANDOFF_RESUME_TEXT }, retomada: true }
  }
  return { kind: 'hold', envio: prompt(next), motivo: holdReason(previous) }
}
