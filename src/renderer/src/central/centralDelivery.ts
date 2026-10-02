/**
 * O caminho de ida da Central: decidir o destino (IPC `central:route`), entregar
 * pela MESMA `dispatch` do composer (fila, ocupado, bolha, sessão), perguntar
 * "Para onde vai?" e o "não era aqui". Mensagem nenhuma se perde: sem decisor,
 * a Central pergunta com opções de heurística; destino sumido, pergunta de novo.
 *
 * As funções recebem o que precisam do App (`CentralFlowDeps`) e leem a Central
 * pela `convsRef` — o estado novo só chega a ela no próximo render, então o que
 * acabou de mudar viaja nos argumentos, nunca relido dela.
 */
import type { MutableRefObject } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { readableMediaText } from '@shared/inlineMedia'
import {
  CENTRAL_ID,
  isCentralConversation,
  type CentralAskReason,
  type CentralCorrection,
  type CentralOption,
  type CentralRequestEntry,
  type CentralRouteRequest,
  type CentralRouteResult,
  type CentralRule,
  type CentralState,
  type CentralTarget
} from '@shared/central'
import type { Conversation } from '../types'
import type { CentralPayload } from './centralSend'
import { centralAttachmentNames } from './centralRegistry'
import { clip, isRoutedEntry, patchRequest, removeReplyOf } from './centralEntries'
import { heuristicOptions, recentDestinations, routeText } from './centralRecents'

/** O aviso quando o destino escolhido não existe mais. */
export const TARGET_MISSING_MESSAGE = 'O destino não existe mais — escolha para onde vai.'
export const ATTACHMENTS_LOST_MESSAGE = 'Os anexos não foram reenviados.'
/** O "porquê" de um destino escolhido no "Para onde vai?". */
export const CHOSEN_WHY = 'escolhido por você'
/** Pedidos com o conteúdo inteiro (anexos) guardado em memória, para o "não era aqui". */
const KEPT_PAYLOADS = 30
const MAX_ATTACHMENT_NAMES = 20
const ATTACHMENT_NAME_MAX = 200

export interface CentralQueueItem {
  id: string
  convId: string
  msgId?: string
}

/** A `dispatch` do App com o id da bolha decidido aqui (a âncora). */
export type CentralDispatch = (
  conv: Conversation,
  text: string,
  images: ImageAttachment[],
  thumbs: string[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[],
  msgId: string
) => Promise<void>

export interface CentralFlowDeps {
  convsRef: MutableRefObject<Conversation[]>
  busyRef: { readonly current: ReadonlySet<string> }
  queueRef: { readonly current: readonly CentralQueueItem[] }
  inflightRef: { readonly current: Readonly<Record<string, { msgId: string } | undefined>> }
  /** O conteúdo de cada pedido (anexos inclusos), pelo id da entrada. */
  payloads: Map<string, CentralPayload>
  /** Regra e confiança do destino tirado pelo "não era aqui" (para o log de correção). */
  moved: Map<string, { rule?: CentralRule; confidence?: number }>
  sandboxRoot: string
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
  /** Põe na tela uma conversa lida do banco. */
  addLoaded: (conv: Conversation) => void
  loadByIds: (ids: string[]) => Promise<Conversation[]>
  /** Uma "Nova conversa" normal na pasta, criada ao fundo (sem virar a ativa). */
  createConversation: (cwd: string) => Conversation
  dispatch: CentralDispatch
  deleteQueued: (queueId: string) => void
  /** Para o turno da conversa SEM descartar o resto da fila dela. */
  stopKeepingQueue: (convId: string) => void
  notify: (kind: 'aviso' | 'erro', msg: string) => void
}

export interface RouteJob {
  entryId: string
  text: string
  attachments: string[]
  forceAsk?: boolean
  exclude?: CentralTarget
  /** Por que a tela forçou a pergunta (sobrepõe o motivo do decisor). */
  reason?: CentralAskReason
}

type ChosenRoute = NonNullable<CentralRequestEntry['route']>

const uid = (prefix: string): string => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

const centralEntries = (d: CentralFlowDeps) => d.convsRef.current.find((c) => c.id === CENTRAL_ID)?.central?.entries ?? []

const convsById = (d: CentralFlowDeps): Map<string, Conversation> => new Map(d.convsRef.current.map((c) => [c.id, c]))

function findRequest(d: CentralFlowDeps, id: string): CentralRequestEntry | undefined {
  return centralEntries(d).find((e): e is CentralRequestEntry => e.kind === 'request' && e.id === id)
}

function patchCentral(d: CentralFlowDeps, fn: (s: CentralState | undefined) => CentralState): void {
  d.patchConv(CENTRAL_ID, (c) => ({ ...c, central: fn(c.central), updatedAt: Date.now() }))
}

const patchEntry = (d: CentralFlowDeps, id: string, fn: (e: CentralRequestEntry) => CentralRequestEntry): void =>
  patchCentral(d, (s) => patchRequest(s, id, fn))

function withoutAsk(e: CentralRequestEntry): CentralRequestEntry {
  const { ask: _ask, ...rest } = e
  return rest
}

const pathExists = (p: string): Promise<boolean> => window.api.pathExists(p).catch(() => false)

/** O resultado do IPC, conferido por cima (null = indisponível, rejeitado ou torto). */
async function askRouter(req: CentralRouteRequest): Promise<CentralRouteResult | null> {
  if (typeof window.api?.centralRoute !== 'function') return null
  try {
    const r: unknown = await window.api.centralRoute(req)
    if (!r || typeof r !== 'object') return null
    const res = r as CentralRouteResult
    if (res.kind === 'direct' && res.target && typeof res.target === 'object') return res
    if (res.kind === 'ask' && Array.isArray(res.options)) return res
    return null
  } catch {
    return null
  }
}

/** Nomes de anexo dentro dos limites do IPC. */
const attachmentNames = (names: readonly string[]): string[] =>
  names.slice(0, MAX_ATTACHMENT_NAMES).map((n) => clip(n, ATTACHMENT_NAME_MAX))

/**
 * Decide o destino de um pedido: direto → entrega; senão "Para onde vai?" (a
 * mensagem espera). IPC fora ou rejeitado → opções de heurística, motivo
 * `typesafe-failed`.
 */
export async function routeEntry(d: CentralFlowDeps, job: RouteJob): Promise<void> {
  const convs = convsById(d)
  const recent = recentDestinations(centralEntries(d), convs)
  const attachments = attachmentNames(job.attachments)
  const result = await askRouter({
    text: routeText(job.text, attachments),
    attachments,
    recent,
    ...(job.forceAsk ? { forceAsk: true } : {}),
    ...(job.exclude ? { exclude: job.exclude } : {})
  })
  if (result?.kind === 'direct' && !job.forceAsk) {
    const { target, rule, confidence, why } = result
    await deliverEntry(d, job.entryId, target, { target, rule, confidence, why })
    return
  }
  let options: CentralOption[]
  let best: number | undefined
  let reason: CentralAskReason = 'typesafe-failed'
  if (result?.kind === 'ask' && result.options.length) {
    options = result.options
    best = result.best
    reason = result.reason
  } else if (result?.kind === 'direct') {
    options = [{ target: result.target }]
    reason = 'moved'
  } else {
    options = heuristicOptions(recent, convs, d.sandboxRoot, job.exclude)
    if (result?.kind === 'ask') reason = result.reason
  }
  const ask = { options, reason: job.reason ?? reason, ...(best !== undefined ? { best } : {}) }
  patchEntry(d, job.entryId, (e) => ({ ...e, state: 'asking', ask }))
}

/** Conversa lida do banco por id: entra na tela e na ref já (fora da lista, o próximo salvamento a apagaria). */
async function loadOne(d: CentralFlowDeps, convId: string): Promise<Conversation | null> {
  const loaded = (await d.loadByIds([convId]).catch(() => [] as Conversation[])).find((c) => c.id === convId)
  if (!loaded) return null
  if (!d.convsRef.current.some((c) => c.id === convId)) {
    d.addLoaded(loaded)
    d.convsRef.current = [loaded, ...d.convsRef.current]
  }
  return d.convsRef.current.find((c) => c.id === convId) ?? loaded
}

function createdIn(d: CentralFlowDeps, cwd: string): Conversation {
  const conv = d.createConversation(cwd)
  // O estado novo só chega à ref no próximo render; a dispatch logo abaixo precisa dela.
  if (!d.convsRef.current.some((c) => c.id === conv.id)) d.convsRef.current = [conv, ...d.convsRef.current]
  return conv
}

/** A conversa de destino (carregada, lida do banco ou criada); null = sumiu. 'sandbox-error' já avisou. */
async function resolveTarget(d: CentralFlowDeps, target: CentralTarget): Promise<Conversation | null | 'sandbox-error'> {
  if (target.kind === 'conversation') {
    if (target.convId === CENTRAL_ID) return null
    const conv = d.convsRef.current.find((c) => c.id === target.convId) ?? (await loadOne(d, target.convId))
    if (!conv || isCentralConversation(conv)) return null
    return (await pathExists(conv.cwd)) ? conv : null
  }
  if (target.kind === 'new-conversation') return (await pathExists(target.cwd)) ? createdIn(d, target.cwd) : null
  const made = await window.api.sandboxCreate().catch((err: unknown) => ({ error: String(err) }))
  if ('error' in made) {
    d.notify('erro', `Não foi possível criar a pasta do sandbox: ${made.error}`)
    return 'sandbox-error'
  }
  return createdIn(d, made.path)
}

/** Some os bytes dos pedidos mais antigos: o "não era aqui" deles reenvia só o texto. */
function prunePayloads(payloads: Map<string, CentralPayload>): void {
  for (const id of [...payloads.keys()].slice(0, Math.max(0, payloads.size - KEPT_PAYLOADS))) payloads.delete(id)
}

/**
 * Entrega o pedido no destino. Conversa sumida (ou sem pasta) → aviso e
 * pergunta de novo (`target-missing`); sandbox que não pôde ser criado → aviso
 * de erro e o pedido continua perguntando. Devolve se a mensagem chegou ao
 * destino (rodando ou na fila dele).
 */
export async function deliverEntry(
  d: CentralFlowDeps,
  entryId: string,
  target: CentralTarget,
  route: ChosenRoute
): Promise<boolean> {
  const payload = d.payloads.get(entryId)
  const entry = findRequest(d, entryId)
  // Logo depois do envio a entrada ainda não chegou à ref: os nomes saem do conteúdo.
  const names =
    entry?.attachments ?? (payload ? centralAttachmentNames(payload.images, payload.files, payload.fileRefs) : [])
  const text = payload?.text ?? entry?.text ?? ''
  const conv = await resolveTarget(d, target)
  if (conv === 'sandbox-error') {
    const convs = convsById(d)
    const options = heuristicOptions(recentDestinations(centralEntries(d), convs), convs, d.sandboxRoot)
    patchEntry(d, entryId, (e) => ({ ...e, state: 'asking', ask: e.ask ?? { options, reason: 'target-missing' } }))
    return false
  }
  if (!conv) {
    d.notify('aviso', TARGET_MISSING_MESSAGE)
    await routeEntry(d, { entryId, text, attachments: names, forceAsk: true, exclude: target, reason: 'target-missing' })
    return false
  }
  const msgId = uid('u')
  patchEntry(d, entryId, (e) => ({ ...withoutAsk(e), state: 'delivered', route, anchor: { convId: conv.id, msgId } }))
  // Sem o conteúdo em memória (reinício): vai o texto, sem os anexos.
  if (!payload && names.length) d.notify('aviso', ATTACHMENTS_LOST_MESSAGE)
  await d.dispatch(
    conv,
    payload ? payload.text : readableMediaText(text),
    payload?.images ?? [],
    payload?.thumbs ?? [],
    payload?.files ?? [],
    payload?.fileRefs ?? [],
    msgId
  )
  const sent =
    d.busyRef.current.has(conv.id) || d.queueRef.current.some((q) => q.convId === conv.id && q.msgId === msgId)
  if (!sent) {
    // Nem rodando nem na fila: o envio falhou (a bolha de lá ficou com o erro).
    patchEntry(d, entryId, (e) => {
      const { anchor: _anchor, ...rest } = e
      return { ...rest, state: 'failed' }
    })
    await routeEntry(d, { entryId, text, attachments: names, forceAsk: true, reason: 'target-missing' })
    return false
  }
  prunePayloads(d.payloads)
  return true
}

/** "Para onde vai?": o usuário escolheu a opção `index`. */
export async function chooseOption(d: CentralFlowDeps, entryId: string, index: number): Promise<void> {
  const entry = findRequest(d, entryId)
  const option = entry?.state === 'asking' ? entry.ask?.options[index] : undefined
  if (!entry || !option) return
  patchEntry(d, entryId, (e) => ({ ...e, state: 'routing' }))
  const delivered = await deliverEntry(d, entryId, option.target, { target: option.target, why: CHOSEN_WHY, byUser: true })
  if (delivered && entry.movedFrom) logCorrection(d, entry, entry.movedFrom, option.target)
}

/** O "não era aqui" vai para o log local que alimenta a calibração. */
function logCorrection(d: CentralFlowDeps, entry: CentralRequestEntry, from: CentralTarget, to: CentralTarget): void {
  const moved = d.moved.get(entry.id)
  d.moved.delete(entry.id)
  const attachments = attachmentNames(entry.attachments ?? [])
  const confidence = moved?.confidence
  const correction: CentralCorrection = {
    ts: Date.now(),
    text: routeText(d.payloads.get(entry.id)?.text ?? entry.text, attachments),
    attachments,
    from,
    ...(moved?.rule ? { fromRule: moved.rule } : {}),
    ...(typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? { fromConfidence: confidence } : {}),
    to
  }
  void window.api.centralCorrection?.(correction)?.catch(() => undefined)
}

/**
 * "Não era aqui" (só pedidos roteados e entregues): tira a mensagem do destino
 * — da fila, se ainda espera (só aquele item); parando o turno, se é ele que
 * roda (o resto da fila fica); nada, se já terminou —, apaga a resposta
 * espelhada e pergunta para onde vai (`forceAsk`, sem o destino errado).
 */
export async function moveEntry(d: CentralFlowDeps, entryId: string): Promise<void> {
  const entry = findRequest(d, entryId)
  if (!entry || entry.state !== 'delivered' || !entry.anchor || !entry.route || entry.injected || !isRoutedEntry(entry)) return
  const { convId, msgId } = entry.anchor
  const queued = d.queueRef.current.find((q) => q.convId === convId && q.msgId === msgId)
  if (queued) d.deleteQueued(queued.id)
  else if (d.busyRef.current.has(convId) && d.inflightRef.current[convId]?.msgId === msgId) d.stopKeepingQueue(convId)
  const from = entry.route.target
  d.moved.set(entryId, { rule: entry.route.rule, confidence: entry.route.confidence })
  patchCentral(d, (s) =>
    patchRequest(removeReplyOf(s, entryId), entryId, (e) => {
      const { route: _route, anchor: _anchor, ask: _ask, ...rest } = e
      return { ...rest, state: 'routing', movedFrom: from }
    })
  )
  const text = d.payloads.get(entryId)?.text ?? entry.text
  await routeEntry(d, { entryId, text, attachments: entry.attachments ?? [], forceAsk: true, exclude: from, reason: 'moved' })
}
