/**
 * A Central para o celular (Etapa 6), pura: das entradas e do que o controller
 * já calculou (`useCentral`: trilho, perguntas pendentes, `labelFor`), o retrato
 * compacto `RemoteConversation.central` que o app do celular desenha sem refazer
 * nada — aviso de destino pronto, "Para onde vai?" com rótulos, linha-resumo pronta.
 *
 * Sem dado de imagem de mensagem ou anexo: anexos são só nomes e a entrada da
 * ferramenta numa permissão vai enxuta. A única imagem é o ícone do projeto nos
 * cards e nas opções — e só pequeno (`data:image/…` de até 12 KB), porque o
 * `/api/state` é lido a cada poucos segundos; maior, o celular desenha o traço.
 * Também nunca lança: dado torto de outra versão vira campo vazio, porque o
 * retrato sai junto com o de todas as conversas. Pedido criado por outro PC sai
 * `foreign` (só o dono entrega): o celular não oferece o "Para onde vai?" dele.
 *
 * Fiação no App (`publishRemoteState`), na conversa da Central:
 * `central: buildRemoteCentral({ ...centralRef.current, self: storageStatus?.installationId ?? null })`.
 */
import type { PermissionRequest } from '@shared/ipc'
import {
  CENTRAL_CHOOSE_OPTION_MAX,
  CENTRAL_REPLY_QUOTE_MAX,
  type CentralActivitySegment,
  type CentralAnchor,
  type CentralEntry,
  type CentralOption,
  type CentralQuestionEntry,
  type CentralReplyEntry,
  type CentralRequestEntry,
  type CentralTarget,
  type RemoteCentral,
  type RemoteCentralActivity,
  type RemoteCentralCard,
  type RemoteCentralEntry,
  type RemoteCentralOption,
  type RemoteCentralQuestion,
  type RemoteCentralRequest
} from '@shared/central'
import type { CentralLabel } from './centralRecents'
import { clip, isRoutedEntry } from './centralEntries'

/** Entradas (as últimas) que vão para o celular. */
export const REMOTE_CENTRAL_MAX_ENTRIES = 60
/** O texto de um pedido no celular, no máximo (o inteiro está na conversa de destino). */
const REQUEST_TEXT_MAX = 4000
const MAX_ATTACHMENTS = 20
const ATTACHMENT_NAME_MAX = 200
/** Cada texto da entrada de uma ferramenta numa permissão. */
const INPUT_TEXT_MAX = 300
/** As chaves de exibição da entrada de uma ferramenta — o resto (conteúdo, bytes) não vai. */
const INPUT_KEYS = ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'skill'] as const
/** O ícone do projeto vai ao celular até este tamanho de data URL (12 KB); maior, null. */
export const REMOTE_ICON_MAX_CHARS = 12 * 1024

/** O que o retrato lê do controller (o `CentralController` serve inteiro, mais o `self`). */
export interface CentralRemoteSource {
  entries: readonly CentralEntry[]
  rail: readonly (Pick<CentralLabel, 'project' | 'title' | 'color' | 'icon' | 'sandbox'> & { convId: string })[]
  pending: readonly { convId: string; label: CentralLabel; request: PermissionRequest }[]
  labelFor: (convId: string) => CentralLabel
  /** `installationId` deste PC. Os dois PCs dividem a Central e só o dono de um pedido o entrega:
   *  pedido de outro PC sai `foreign` (o celular não oferece escolha). Ausente = ninguém é marcado. */
  self?: string | null
}

type LabelOf = (convId: string) => CentralLabel

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** Pedido de OUTRO PC: o `device` dele e o `self` conhecidos (não vazios) e diferentes; legado ou sem `self`, não. */
function isForeign(e: CentralRequestEntry | CentralReplyEntry, self: string | null | undefined): boolean {
  return typeof self === 'string' && self !== '' && typeof e.device === 'string' && e.device !== '' && e.device !== self
}

/** O ícone do projeto para o celular: só `data:image/…` de até 12 KB; o resto (grande, outro tipo, caminho) é null. */
export function remoteIcon(icon: unknown): string | null {
  return typeof icon === 'string' && /^data:image\//i.test(icon) && icon.length <= REMOTE_ICON_MAX_CHARS ? icon : null
}

/** "projeto · conversa" (destino desconhecido: só a conversa). */
const whoOf = (label: CentralLabel): string => (label.project ? `${label.project} · ${label.title}` : label.title)

/** A âncora legível (do banco pode vir torta, de outra versão). */
function anchorOf(a: unknown): CentralAnchor | undefined {
  const r = a as Partial<CentralAnchor> | undefined
  return r && typeof r.convId === 'string' && r.convId && typeof r.msgId === 'string'
    ? { convId: r.convId, msgId: r.msgId }
    : undefined
}

/** Para onde foi o pedido: `→ <to>`; o adotado (A1) não foi roteado — `em <projeto> · <conversa>`. */
function noticeOf(e: CentralRequestEntry, anchor: CentralAnchor | undefined, labelOf: LabelOf): RemoteCentralRequest['notice'] {
  if (!e.route || !anchor) return undefined
  const dest = labelOf(anchor.convId)
  // Sem destino legível, vale o rótulo da conversa onde a mensagem está.
  const target = e.route.target as CentralTarget | undefined
  let to = whoOf(dest)
  if (e.origin !== 'conversation' && target?.kind === 'new-conversation') to = `nova conversa em ${str(target.project)}`
  else if (e.origin !== 'conversation' && target?.kind === 'new-sandbox') to = 'sandbox'
  return { to, why: str(e.route.why), color: dest.color }
}

function optionOf(option: CentralOption | undefined, index: number, best: unknown, labelOf: LabelOf): RemoteCentralOption {
  const t = option?.target
  const isBest = index === best
  if (t?.kind === 'new-conversation') return { label: `nova em ${str(t.project)}`, icon: null, glyph: 'new', best: isBest }
  if (t?.kind === 'new-sandbox') return { label: 'sandbox', sub: 'nova conversa', icon: null, glyph: 'sandbox', best: isBest }
  // Opção torta continua no lugar: o índice é o que volta para o PC.
  if (t?.kind !== 'conversation' || typeof t.convId !== 'string' || !t.convId) {
    return { label: 'destino', icon: null, glyph: 'project', best: isBest }
  }
  // O título vivo (a conversa pode ter sido renomeada depois da pergunta), senão o do destino.
  const live = labelOf(t.convId)
  const known = live.project !== ''
  return {
    label: (known ? live.title : str(t.title)) || 'conversa',
    sub: t.sandbox ? 'sandbox' : known ? live.project : str(t.project),
    icon: t.sandbox ? null : remoteIcon(live.icon),
    glyph: t.sandbox ? 'sandbox' : 'project',
    best: isBest
  }
}

/** "Para onde vai?" só em pedido roteado esperando destino; os índices são os do PC (a escolha volta por eles). */
function askOf(e: CentralRequestEntry, labelOf: LabelOf): RemoteCentralRequest['ask'] {
  if (e.state !== 'asking' || !e.ask || !isRoutedEntry(e) || !Array.isArray(e.ask.options)) return undefined
  const { best } = e.ask
  const options = e.ask.options.slice(0, CENTRAL_CHOOSE_OPTION_MAX + 1).map((o, i) => optionOf(o, i, best, labelOf))
  return { reason: e.ask.reason, options }
}

function requestOf(e: CentralRequestEntry, labelOf: LabelOf, self: string | null | undefined): RemoteCentralRequest {
  const anchor = anchorOf(e.anchor)
  const notice = noticeOf(e, anchor, labelOf)
  const ask = askOf(e, labelOf)
  const quote = quoteOf(e, labelOf)
  const names = Array.isArray(e.attachments) ? e.attachments.filter((n): n is string => typeof n === 'string') : []
  return {
    kind: 'request',
    id: e.id,
    ts: e.ts,
    text: clip(e.text, REQUEST_TEXT_MAX),
    ...(names.length ? { attachments: names.slice(0, MAX_ATTACHMENTS).map((n) => clip(n, ATTACHMENT_NAME_MAX)) } : {}),
    state: e.state,
    ...(e.origin === 'central' || e.origin === 'conversation' ? { origin: e.origin } : {}),
    ...(e.injected ? { injected: true as const } : {}),
    ...(isForeign(e, self) ? { foreign: true as const } : {}),
    ...(notice ? { notice } : {}),
    ...(ask ? { ask } : {}),
    ...(anchor ? { anchor } : {}),
    ...(quote ? { replyTo: quote } : {})
  }
}

const isSegment = (s: unknown): s is CentralActivitySegment => !!s && typeof (s as CentralActivitySegment).text === 'string'

/** A linha-resumo como a tela a guardou (já pronta), mais se o turno acabou. */
function activityOf(e: CentralReplyEntry): RemoteCentralActivity {
  const a = (e.activity ?? {}) as Partial<CentralReplyEntry['activity']>
  const segments = (Array.isArray(a.segments) ? a.segments.filter(isSegment) : []).map((s) =>
    s.tone ? { text: s.text, tone: s.tone } : { text: s.text }
  )
  const now = str(a.now)
  return {
    segments,
    text: typeof a.text === 'string' ? a.text : segments.map((s) => s.text).join(''),
    count: count(a.count),
    errors: count(a.errors),
    ...(now ? { now } : {}),
    done: e.done === true
  }
}

function replyOf(e: CentralReplyEntry, labelOf: LabelOf, self: string | null | undefined): RemoteCentralEntry | undefined {
  const anchor = anchorOf(e.anchor)
  if (!anchor) return undefined
  const dest = labelOf(anchor.convId)
  return {
    kind: 'reply',
    id: e.id,
    ts: e.ts,
    requestId: e.requestId,
    anchor,
    who: whoOf(dest),
    color: dest.color,
    notes: Array.isArray(e.notes) ? e.notes.filter((n): n is string => typeof n === 'string') : [],
    ...(typeof e.answer === 'string' ? { answer: e.answer } : {}),
    activity: activityOf(e),
    ...(isForeign(e, self) ? { foreign: true as const } : {})
  }
}

/** A citação de uma resposta (estilo WhatsApp), pronta para o celular. */
function quoteOf(e: CentralRequestEntry, labelOf: LabelOf): RemoteCentralRequest['replyTo'] {
  const q = e.replyTo
  if (!q || typeof q.convId !== 'string' || !q.convId) return undefined
  const dest = labelOf(q.convId)
  return { who: whoOf(dest), color: dest.color, text: clip(str(q.text), CENTRAL_REPLY_QUOTE_MAX) }
}

function answeredOf(e: CentralQuestionEntry, labelOf: LabelOf): RemoteCentralEntry {
  const dest = labelOf(e.convId)
  return { kind: 'question', id: e.id, ts: e.ts, convId: e.convId, who: whoOf(dest), color: dest.color, question: e.question, answer: e.answer }
}

/** Só texto curto de exibição (comando, arquivo, URL…): nada aninhado, nenhum `data:`. */
function displayInput(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!input || typeof input !== 'object') return out
  for (const key of INPUT_KEYS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim() && !/^\s*data:/i.test(v)) out[key] = clip(v, INPUT_TEXT_MAX)
  }
  return out
}

/** O pedido de permissão/pergunta enxuto: o id (a resposta volta por ele), as perguntas e o prazo. */
function compactRequest(req: PermissionRequest): PermissionRequest {
  const questions = Array.isArray(req.questions)
    ? req.questions.map((q) => ({
        header: str(q?.header),
        question: str(q?.question),
        multiSelect: q?.multiSelect === true,
        options: Array.isArray(q?.options) ? q.options.map((o) => ({ label: str(o?.label), description: str(o?.description) })) : []
      }))
    : undefined
  return {
    id: req.id,
    toolName: str(req.toolName),
    input: displayInput(req.input),
    ...(questions ? { questions } : {}),
    ...(typeof req.deadline === 'number' ? { deadline: req.deadline } : {})
  }
}

const cardOf = (c: CentralRemoteSource['rail'][number]): RemoteCentralCard => ({
  convId: c.convId,
  project: c.project,
  title: c.title,
  color: c.color,
  icon: c.sandbox ? null : remoteIcon(c.icon),
  sandbox: c.sandbox
})

const questionOf = (q: CentralRemoteSource['pending'][number]): RemoteCentralQuestion => ({
  convId: q.convId,
  who: whoOf(q.label),
  color: q.label.color,
  request: compactRequest(q.request)
})

/** O retrato da Central para o celular: as últimas `max` entradas, o trilho e as perguntas pendentes. */
export function buildRemoteCentral(source: CentralRemoteSource, max: number = REMOTE_CENTRAL_MAX_ENTRIES): RemoteCentral {
  const labels = new Map<string, CentralLabel>()
  const labelOf: LabelOf = (convId) => {
    let label = labels.get(convId)
    if (!label) labels.set(convId, (label = source.labelFor(convId)))
    return label
  }
  // A1: ajuste injetado não tem resposta própria — nem uma gravada antes de ele virar injetado.
  const injected = new Set(source.entries.filter((e) => e.kind === 'request' && e.injected).map((e) => e.id))
  const entries: RemoteCentralEntry[] = []
  for (const e of max > 0 ? source.entries.slice(-max) : []) {
    if (e.kind === 'request') entries.push(requestOf(e, labelOf, source.self))
    else if (e.kind === 'question') entries.push(answeredOf(e, labelOf))
    else if (e.kind === 'reply' && !injected.has(e.requestId)) {
      const reply = replyOf(e, labelOf, source.self)
      if (reply) entries.push(reply)
    }
  }
  return { entries, rail: source.rail.map(cardOf), questions: source.pending.map(questionOf) }
}
