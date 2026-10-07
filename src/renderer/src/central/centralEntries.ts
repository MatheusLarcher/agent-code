/**
 * As entradas da Central, puras: o pedido adotado da Emenda A1 (turno enviado na
 * própria conversa), os tetos do que é gravado e as operações sobre a lista
 * (append idempotente pela âncora, upsert da resposta pelo id determinístico).
 *
 * A Central é UMA linha do banco, regravada a cada mudança e dividida pelos dois
 * PCs: o que entra aqui é leve (texto cortado, nomes de anexo), e cada entrada
 * tem um dono só (`device`).
 */
import type {
  CentralAnchor,
  CentralEntry,
  CentralReplyEntry,
  CentralReplyStep,
  CentralRequestEntry,
  CentralState,
  CentralTarget
} from '@shared/central'
import { appendCentralEntry, newCentralRequest } from './centralRegistry'

/** Cada comentário espelhado, no máximo (o inteiro está no "abrir conversa ↗"). */
export const NOTE_MAX_CHARS = 600
/** Quantos comentários (os últimos) uma resposta guarda. */
export const MAX_REPLY_NOTES = 12
/** A resposta final espelhada, no máximo. */
export const ANSWER_MAX_CHARS = 4000
/** O texto de um turno adotado, no máximo (o inteiro fica na conversa dele). */
export const ADOPTED_TEXT_MAX_CHARS = 4000
/** O aviso de um turno adotado (A1): não foi roteado, foi enviado lá. */
export const ADOPTED_WHY = 'enviada na própria conversa'

type ConversationTarget = Extract<CentralTarget, { kind: 'conversation' }>

/** Corta em `max` caracteres, terminando em "…". */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** As 12 últimas notas, cada uma com no máximo 600 caracteres. */
export function capNotes(notes: readonly string[]): string[] {
  return notes.slice(-MAX_REPLY_NOTES).map((n) => clip(n, NOTE_MAX_CHARS))
}

/** Quantos passos (os últimos) uma resposta guarda — o mesmo teto dos comentários. */
export const MAX_REPLY_STEPS = MAX_REPLY_NOTES
/** Ids de ferramenta guardados por passo, no máximo (a Central é UMA linha do banco). */
export const MAX_STEP_TOOL_IDS = 60

/** Os 12 últimos passos: comentário cortado como as notas, ids até 60. */
export function capSteps(steps: readonly CentralReplyStep[]): CentralReplyStep[] {
  return steps.slice(-MAX_REPLY_STEPS).map((s) => ({
    ...(s.note !== undefined ? { note: clip(s.note, NOTE_MAX_CHARS) } : {}),
    activity: s.activity,
    toolIds: s.toolIds.slice(0, MAX_STEP_TOOL_IDS)
  }))
}

export function capAnswer(answer: string | undefined): string | undefined {
  return answer === undefined ? undefined : clip(answer, ANSWER_MAX_CHARS)
}

/** Id determinístico da resposta de um pedido: um segundo escritor nunca a duplica. */
export const replyIdFor = (requestId: string): string => `reply:${requestId}`

export interface AdoptedTurn {
  convId: string
  /** A bolha do usuário lá (a âncora). */
  msgId: string
  text: string
  /** Só os nomes. */
  attachments: string[]
  /** A conversa, como destino (`centralRecents.conversationTarget`). */
  target: ConversationTarget
  /** `installationId` deste PC; ausente quando ainda não se sabe. */
  device?: string
  /** Ajuste injetado num turno em andamento ("agora" da fila). */
  injected?: boolean
  now?: number
}

/** O pedido que a Central adota quando o turno foi enviado na própria conversa. */
export function adoptedRequestEntry(t: AdoptedTurn): CentralRequestEntry {
  const base = newCentralRequest(clip(t.text, ADOPTED_TEXT_MAX_CHARS), t.attachments, t.now)
  return {
    ...base,
    state: 'delivered',
    origin: 'conversation',
    ...(t.device ? { device: t.device } : {}),
    route: { target: { ...t.target }, why: ADOPTED_WHY },
    anchor: { convId: t.convId, msgId: t.msgId },
    ...(t.injected ? { injected: true as const } : {})
  }
}

const entriesOf = (state: CentralState | undefined): CentralEntry[] =>
  Array.isArray(state?.entries) ? state.entries : []

/** O pedido ancorado nessa bolha (entregue pela Central ou adotado). */
export function findAnchored(
  state: CentralState | undefined,
  convId: string,
  msgId: string
): CentralRequestEntry | undefined {
  return entriesOf(state).find(
    (e): e is CentralRequestEntry =>
      e.kind === 'request' && e.anchor?.convId === convId && e.anchor.msgId === msgId
  )
}

/** Acrescenta o pedido adotado — a não ser que a âncora já tenha dono (devolve o MESMO estado). */
export function appendAdopted(state: CentralState | undefined, entry: CentralRequestEntry): CentralState {
  const anchor = entry.anchor
  if (state && anchor && findAnchored(state, anchor.convId, anchor.msgId)) return state
  return appendCentralEntry(state, entry)
}

/** Troca um pedido pelo id (os outros ficam como estão). */
export function patchRequest(
  state: CentralState | undefined,
  id: string,
  fn: (e: CentralRequestEntry) => CentralRequestEntry
): CentralState {
  return { entries: entriesOf(state).map((e) => (e.kind === 'request' && e.id === id ? fn(e) : e)) }
}

/** O pedido daquela âncora virou ajuste injetado; sem ele, o mesmo estado. */
export function markInjected(state: CentralState | undefined, convId: string, msgId: string): CentralState {
  const target = findAnchored(state, convId, msgId)
  if (!state || !target) return state ?? { entries: [] }
  return patchRequest(state, target.id, (e) => ({ ...e, injected: true }))
}

export function replyOf(entries: readonly CentralEntry[], requestId: string): CentralReplyEntry | undefined {
  return entries.find((e): e is CentralReplyEntry => e.kind === 'reply' && e.requestId === requestId)
}

/** A resposta troca no lugar (pelo id); nova, vai para o fim — fica na ordem do tempo. */
export function upsertReply(state: CentralState | undefined, reply: CentralReplyEntry): CentralState {
  const entries = entriesOf(state)
  const at = entries.findIndex((e) => e.kind === 'reply' && e.id === reply.id)
  if (at < 0) return appendCentralEntry(state, reply)
  return { entries: entries.map((e, i) => (i === at ? reply : e)) }
}

export function removeReplyOf(state: CentralState | undefined, requestId: string): CentralState {
  return { entries: entriesOf(state).filter((e) => !(e.kind === 'reply' && e.requestId === requestId)) }
}

/** Entrada deste PC: sem dono (legado) ou com o `device` daqui. */
export function isOwnEntry(entry: CentralEntry, self: string | undefined): boolean {
  return !entry.device || entry.device === self
}

/** Roteada pela Central (só estas oferecem "não era aqui"). */
export function isRoutedEntry(entry: CentralRequestEntry): boolean {
  return entry.origin === undefined || entry.origin === 'central'
}

/** A bolha da âncora tem trabalho VIVO neste PC agora: é o turno em voo da conversa,
 *  espera na fila dela ou é o que a recuperação automática vai retomar. */
export type CentralLiveAnchor = (anchor: CentralAnchor) => boolean

/**
 * A conversa tem turno em aberto na Central: um pedido ancorado nela (não injetado)
 * cujo turno está VIVO. "Sem resposta terminada" não serve: a resposta só nasce com
 * conteúdo, e o pedido descartado da fila ou parado antes do 1º evento ficaria
 * ativo para sempre (perguntas e avisos presos à conversa).
 */
export function hasActiveAnchor(entries: readonly CentralEntry[], convId: string, isLive: CentralLiveAnchor): boolean {
  return entries.some((e) => e.kind === 'request' && !e.injected && e.anchor?.convId === convId && isLive(e.anchor))
}
