/**
 * O caminho de ida da Central: decidir o destino (IPC `central:route`), entregar
 * pela MESMA `dispatch` do composer (fila, ocupado, bolha, sessão) e perguntar
 * "Para onde vai?". Mensagem nenhuma se perde: sem decisor, a Central pergunta
 * com opções de heurística; destino sumido ou envio que falha, pergunta de novo.
 * A saída do destino ("não era aqui", descarte) está em centralMove.ts.
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
  type CentralAnchor,
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
import { clip, isOwnEntry, patchRequest } from './centralEntries'
import { heuristicOptions, recentDestinations, routeText, sameTarget } from './centralRecents'

/** O aviso quando o destino escolhido não existe mais. */
export const TARGET_MISSING_MESSAGE = 'O destino não existe mais — escolha para onde vai.'
export const ATTACHMENTS_LOST_MESSAGE = 'Os anexos não foram reenviados.'
/** Pedido de outro PC: só o dono o encaminha (a mescla devolveria o pedido ao estado dele). */
export const OTHER_DEVICE_MESSAGE = 'Este pedido é do outro PC: só ele pode encaminhá-lo.'
/** Mensagem da Central que saiu da fila do destino sem rodar (Stop, lixeira, conversa apagada). */
export const DISCARDED_MESSAGE = 'Uma mensagem da Central saiu da fila sem rodar — escolha para onde vai.'
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
  /** `installationId` deste PC: só as entradas dele são encaminhadas daqui. */
  device: string | undefined
  convsRef: MutableRefObject<Conversation[]>
  busyRef: { readonly current: ReadonlySet<string> }
  queueRef: { readonly current: readonly CentralQueueItem[] }
  inflightRef: { readonly current: Readonly<Record<string, { msgId: string } | undefined>> }
  /** O conteúdo de cada pedido (anexos inclusos), pelo id da entrada. */
  payloads: Map<string, CentralPayload>
  /** Regra e confiança do destino tirado pelo "não era aqui" (para o log de correção). */
  moved: Map<string, { rule?: CentralRule; confidence?: number }>
  /** A geração de cada pedido: toda entrega, "não era aqui" ou descarte a avança, e
   *  um caminho antigo que volta de um `await` nunca mexe numa âncora mais nova. */
  generations: Map<string, number>
  sandboxRoot: string
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
  /** Põe na tela uma conversa lida do banco. */
  addLoaded: (conv: Conversation) => void
  loadByIds: (ids: string[]) => Promise<Conversation[]>
  /** Uma "Nova conversa" normal na pasta, criada ao fundo (sem virar a ativa). */
  createConversation: (cwd: string) => Conversation
  dispatch: CentralDispatch
  /** Tira o item da fila SEM avisar a Central (quem tira é ela, no "não era aqui"). */
  deleteQueued: (queueId: string) => void
  /** Para o turno da conversa (e a recuperação automática pendente dele) SEM
   *  descartar o resto da fila dela. */
  stopKeepingQueue: (convId: string) => void
  /** O envio da bolha falhou e a Central vai perguntar de novo: a bolha e o "Tentar
   *  de novo" dela saem do destino (o reenvio do pedido é só da Central). */
  discardFailed: (convId: string, msgId: string) => void
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
  /** A geração de quem pediu: se ela avançou durante o `await` do decisor, nada muda. */
  gen?: number
}

type ChosenRoute = NonNullable<CentralRequestEntry['route']>

const uid = (prefix: string): string => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

export const centralEntries = (d: CentralFlowDeps) =>
  d.convsRef.current.find((c) => c.id === CENTRAL_ID)?.central?.entries ?? []

const convsById = (d: CentralFlowDeps): Map<string, Conversation> => new Map(d.convsRef.current.map((c) => [c.id, c]))

export function findRequest(d: CentralFlowDeps, id: string): CentralRequestEntry | undefined {
  return centralEntries(d).find((e): e is CentralRequestEntry => e.kind === 'request' && e.id === id)
}

/** Avança a geração do pedido e a devolve (a de quem está agindo agora). */
export function nextGeneration(d: CentralFlowDeps, entryId: string): number {
  const gen = (d.generations.get(entryId) ?? 0) + 1
  d.generations.set(entryId, gen)
  return gen
}

const isCurrent = (d: CentralFlowDeps, entryId: string, gen: number | undefined): boolean =>
  gen === undefined || d.generations.get(entryId) === gen

/** Só o PC dono de um pedido age sobre ele (escolher, "não era aqui"): o do outro PC
 *  despacharia aqui e a mescla o devolveria ao estado de lá. */
export function ownedHere(d: CentralFlowDeps, entry: CentralRequestEntry): boolean {
  if (isOwnEntry(entry, d.device)) return true
  d.notify('aviso', OTHER_DEVICE_MESSAGE)
  return false
}

export function patchCentral(d: CentralFlowDeps, fn: (s: CentralState | undefined) => CentralState): void {
  d.patchConv(CENTRAL_ID, (c) => ({ ...c, central: fn(c.central), updatedAt: Date.now() }))
}

const patchEntry = (d: CentralFlowDeps, id: string, fn: (e: CentralRequestEntry) => CentralRequestEntry): void =>
  patchCentral(d, (s) => patchRequest(s, id, fn))

const sameAnchor = (a: CentralAnchor | undefined, convId: string, msgId: string): boolean =>
  a?.convId === convId && a.msgId === msgId

function withoutAsk(e: CentralRequestEntry): CentralRequestEntry {
  const { ask: _ask, ...rest } = e
  return rest
}

const pathExists = (p: string): Promise<boolean> => window.api.pathExists(p).catch(() => false)

/** Um destino com a forma do contrato (a entrega age sobre ele: cria conversa, cria pasta). */
function isTarget(value: unknown): value is CentralTarget {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  if (t.kind === 'new-sandbox') return true
  if (t.kind === 'new-conversation') return typeof t.cwd === 'string' && t.cwd !== ''
  return t.kind === 'conversation' && typeof t.convId === 'string' && t.convId !== '' && typeof t.cwd === 'string'
}

/** O resultado do IPC, conferido por cima (null = indisponível, rejeitado ou torto). */
async function askRouter(req: CentralRouteRequest): Promise<CentralRouteResult | null> {
  if (typeof window.api?.centralRoute !== 'function') return null
  try {
    const r: unknown = await window.api.centralRoute(req)
    if (!r || typeof r !== 'object') return null
    const res = r as CentralRouteResult
    if (res.kind === 'direct') return isTarget(res.target) ? res : null
    if (res.kind !== 'ask' || !Array.isArray(res.options) || !res.options.every((o) => isTarget(o?.target))) return null
    const best = res.best
    const bestOk = typeof best === 'number' && Number.isInteger(best) && best >= 0 && best < res.options.length
    if (bestOk || best === undefined) return res
    const { best: _best, ...rest } = res
    return rest
  } catch {
    return null
  }
}

/** Nomes de anexo dentro dos limites do IPC. */
export const attachmentNames = (names: readonly string[]): string[] =>
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
  if (!isCurrent(d, job.entryId, job.gen)) return
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
  } else {
    options = heuristicOptions(recent, convs, d.sandboxRoot, job.exclude)
    if (result?.kind === 'ask') reason = result.reason
    // Direto apesar do `forceAsk`: o destino dele vira a 1ª opção (nunca o excluído).
    if (result?.kind === 'direct') {
      const t = result.target
      if (!job.exclude || !sameTarget(t, job.exclude)) options = [{ target: t }, ...options.filter((o) => !sameTarget(o.target, t))]
      reason = 'moved'
    }
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

/** Some os bytes dos pedidos entregues mais antigos (o "não era aqui" deles reenvia
 *  só o texto). Pedido ainda esperando destino nunca perde os dele. */
function prunePayloads(d: CentralFlowDeps): void {
  let excess = d.payloads.size - KEPT_PAYLOADS
  if (excess <= 0) return
  const waiting = new Set(
    centralEntries(d)
      .filter((e) => e.kind === 'request' && (e.state === 'routing' || e.state === 'asking'))
      .map((e) => e.id)
  )
  for (const id of [...d.payloads.keys()]) {
    if (excess <= 0) break
    if (waiting.has(id)) continue
    d.payloads.delete(id)
    excess -= 1
  }
}

/**
 * Entrega o pedido no destino. Conversa sumida (ou sem pasta) → aviso e
 * pergunta de novo (`target-missing`); sandbox que não pôde ser criado → aviso
 * de erro e o pedido continua perguntando. Devolve se a mensagem chegou ao
 * destino (rodando ou na fila dele). Uma entrega cuja geração ficou para trás
 * (um "não era aqui", outra escolha ou um descarte agiu durante os `await`) não
 * mexe mais no pedido.
 */
export async function deliverEntry(
  d: CentralFlowDeps,
  entryId: string,
  target: CentralTarget,
  route: ChosenRoute
): Promise<boolean> {
  const gen = nextGeneration(d, entryId)
  const payload = d.payloads.get(entryId)
  const entry = findRequest(d, entryId)
  // Logo depois do envio a entrada ainda não chegou à ref: os nomes saem do conteúdo.
  const names =
    entry?.attachments ?? (payload ? centralAttachmentNames(payload.images, payload.files, payload.fileRefs) : [])
  const text = payload?.text ?? entry?.text ?? ''
  const conv = await resolveTarget(d, target)
  if (!isCurrent(d, entryId, gen)) return false
  if (conv === 'sandbox-error') {
    const convs = convsById(d)
    const options = heuristicOptions(recentDestinations(centralEntries(d), convs), convs, d.sandboxRoot)
    patchEntry(d, entryId, (e) => ({ ...e, state: 'asking', ask: e.ask ?? { options, reason: 'target-missing' } }))
    return false
  }
  if (!conv) {
    d.notify('aviso', TARGET_MISSING_MESSAGE)
    await routeEntry(d, { entryId, text, attachments: names, forceAsk: true, exclude: target, reason: 'target-missing', gen })
    return false
  }
  const msgId = uid('u')
  patchEntry(d, entryId, (e) => ({ ...withoutAsk(e), state: 'delivered', route, anchor: { convId: conv.id, msgId } }))
  // Sem o conteúdo em memória (reinício): vai o texto, sem os anexos.
  if (!payload && names.length) d.notify('aviso', ATTACHMENTS_LOST_MESSAGE)
  const dispatched = await d
    .dispatch(
      conv,
      payload ? payload.text : readableMediaText(text),
      payload?.images ?? [],
      payload?.thumbs ?? [],
      payload?.files ?? [],
      payload?.fileRefs ?? [],
      msgId
    )
    .then(
      () => true,
      () => false
    )
  // Durante o envio (o connect pode demorar), outro caminho assumiu o pedido.
  if (!isCurrent(d, entryId, gen)) return false
  const sent =
    dispatched &&
    (d.busyRef.current.has(conv.id) || d.queueRef.current.some((q) => q.convId === conv.id && q.msgId === msgId))
  if (!sent) {
    // Nem rodando nem na fila: o envio falhou. A Central pergunta de novo e é a
    // única dona do reenvio — a bolha com "Tentar de novo" sai do destino.
    nextGeneration(d, entryId)
    d.discardFailed(conv.id, msgId)
    patchEntry(d, entryId, (e) => {
      if (!sameAnchor(e.anchor, conv.id, msgId)) return e
      const { anchor: _anchor, ...rest } = e
      return { ...rest, state: 'failed' }
    })
    await routeEntry(d, { entryId, text, attachments: names, forceAsk: true, reason: 'target-missing', gen: d.generations.get(entryId) })
    return false
  }
  prunePayloads(d)
  return true
}

/**
 * Rede de segurança dos três caminhos (envio, escolha, "não era aqui"): um erro
 * inesperado no meio (IPC, disco) não deixa o pedido preso em "routing" — ele
 * volta a perguntar, com as opções que já tinha ou as de heurística (sem o
 * destino de onde foi tirado). Mensagem nenhuma se perde.
 */
export function rescueEntry(d: CentralFlowDeps, entryId: string, err: unknown): void {
  const convs = convsById(d)
  const recent = recentDestinations(centralEntries(d), convs)
  patchEntry(d, entryId, (e) => {
    if (e.state !== 'routing') return e
    const reason: CentralAskReason = e.movedFrom ? 'moved' : 'typesafe-failed'
    return { ...e, state: 'asking', ask: e.ask ?? { options: heuristicOptions(recent, convs, d.sandboxRoot, e.movedFrom), reason } }
  })
  d.notify('erro', `A Central não conseguiu encaminhar o pedido: ${err instanceof Error ? err.message : String(err)}`)
}

/** "Para onde vai?": o usuário escolheu a opção `index`. */
export async function chooseOption(d: CentralFlowDeps, entryId: string, index: number): Promise<void> {
  const entry = findRequest(d, entryId)
  if (!entry || !ownedHere(d, entry)) return
  const option = entry.state === 'asking' ? entry.ask?.options[index] : undefined
  if (!option) return
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
