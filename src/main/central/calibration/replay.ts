import type { CentralRecent, CentralRouteRequest, CentralRule, CentralTarget } from '../../../shared/central'
import { readableMediaText } from '../../../shared/inlineMedia'
import {
  buildCentralIndex,
  summarizeConversation,
  type CentralConversationSummary,
  type CentralIndex
} from '../centralIndex'
import type { History, HistoryConversation, HistoryRequest } from './history'

/**
 * Calibração da Central, parte 2: o replay no tempo, SEM vazamento. Ao avaliar
 * uma mensagem do instante t, o índice só tem as conversas criadas antes de t,
 * cada uma resumida só com as mensagens anteriores a t; os recentes da Central
 * são os 5 últimos destinos distintos do gabarito antes de t, cada um com o
 * último pedido e o começo da resposta como estavam em t. Puro.
 */

/** O mesmo MAX_RECENTS da tela. */
const MAX_RECENTS = 5

/** O destino certo pelo gabarito automático e a regra que o leva até lá. */
export interface Gold {
  rule: CentralRule
  target: CentralTarget
  /** A mensagem abriu a conversa. */
  first: boolean
}

/** Tudo o que o decisor recebe ao avaliar uma mensagem. */
export interface Moment {
  index: CentralIndex
  recent: CentralRecent[]
  request: CentralRouteRequest
  gold: Gold
}

export interface ReplayDeps {
  sandboxRoot: string
  exists(path: string): boolean
  isSandbox(cwd: string): boolean
}

export interface Replay {
  at(request: HistoryRequest): Moment
  gold(request: HistoryRequest): Gold
  recentAt(request: HistoryRequest): CentralRecent[]
  indexAt(t: number): CentralIndex
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const oneLine = (text: string): string => readableMediaText(text).replace(/\s+/g, ' ').trim()

/** O nome da pasta, como o índice o dá ao projeto. */
const folderName = (cwd: string): string =>
  cwd
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.')
    .pop() ?? cwd

/** O projeto de uma conversa, como o índice o nomeia ('sandbox' no sandbox). */
export const projectOf = (conv: HistoryConversation): string => (conv.sandbox ? 'sandbox' : folderName(conv.cwd))

/** Quantas mensagens aconteceram antes de t (as horas de corte não decrescem). */
export function cutAt(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * A resposta ao pedido da posição `from`, como a Central a guarda: o texto final
 * (`answer`) ou, sem ele, o último comentário — só o que chegou antes do corte.
 */
function replyAfter(messages: readonly unknown[], from: number, cut: number): string {
  let note = ''
  for (let i = cut - 1; i > from; i--) {
    const m = messages[i]
    if (!isRecord(m) || m.kind !== 'assistant-text' || typeof m.text !== 'string' || m.text.trim() === '') continue
    if (m.answer === true) return oneLine(m.text)
    if (note === '') note = m.text
  }
  return oneLine(note)
}

const conversationTarget = (conv: HistoryConversation): CentralTarget => ({
  kind: 'conversation',
  convId: conv.id,
  cwd: conv.cwd,
  project: projectOf(conv),
  title: conv.title,
  sandbox: conv.sandbox
})

export function createReplay(history: History, deps: ReplayDeps): Replay {
  const convs = new Map(history.conversations.map((conv) => [conv.id, conv]))
  const order = new Map(history.requests.map((request, i) => [request.id, i]))
  /** Resumo por (conversa, corte): o corte só muda quando chega mensagem nova. */
  const summaries = new Map<string, CentralConversationSummary | null>()

  function summaryAt(conv: HistoryConversation, t: number): CentralConversationSummary | null {
    if (!(conv.createdAt < t)) return null
    const cut = cutAt(conv.times, t)
    // Sem pedido antes de t a conversa ainda não existe para a Central (e o título dela viria do futuro).
    if (!(conv.requestPositions.length > 0 && conv.requestPositions[0] < cut)) return null
    const key = `${conv.id}\u0000${cut}`
    let summary = summaries.get(key)
    if (summary === undefined) {
      const payload = { ...conv.row.payload, messages: conv.messages.slice(0, cut), updatedAt: conv.times[cut - 1] }
      summary = summarizeConversation({ ...conv.row, payload }, deps.isSandbox)
      summaries.set(key, summary)
    }
    return summary
  }

  function indexAt(t: number): CentralIndex {
    const list: CentralConversationSummary[] = []
    for (const conv of history.conversations) {
      const summary = summaryAt(conv, t)
      if (summary) list.push(summary)
    }
    return buildCentralIndex(list, { sandboxRoot: deps.sandboxRoot, exists: deps.exists })
  }

  function recentAt(request: HistoryRequest): CentralRecent[] {
    const out: CentralRecent[] = []
    const seen = new Set<string>()
    const from = order.get(request.id) ?? history.requests.length
    for (let i = from - 1; i >= 0 && out.length < MAX_RECENTS; i--) {
      const sent = history.requests[i]
      if (!(sent.t < request.t) || seen.has(sent.convId)) continue
      seen.add(sent.convId)
      const conv = convs.get(sent.convId)
      if (!conv) continue
      out.push({
        convId: conv.id,
        request: oneLine(sent.text),
        replyStart: replyAfter(conv.messages, sent.position, cutAt(conv.times, request.t)),
        cwd: conv.cwd,
        title: conv.title
      })
    }
    return out
  }

  function goldWith(request: HistoryRequest, recent: readonly CentralRecent[]): Gold {
    const conv = convs.get(request.convId)
    if (!conv) throw new Error('pedido sem conversa no histórico')
    if (request.first) {
      return conv.sandbox
        ? { rule: 'sandbox', target: { kind: 'new-sandbox' }, first: true }
        : { rule: 'nova', target: { kind: 'new-conversation', cwd: conv.cwd, project: folderName(conv.cwd) }, first: true }
    }
    const rule: CentralRule = recent.some((r) => r.convId === conv.id) ? 'continua' : 'conversa-antiga'
    return { rule, target: conversationTarget(conv), first: false }
  }

  return {
    at(request) {
      const recent = recentAt(request)
      return {
        index: indexAt(request.t),
        recent,
        request: { text: request.text, attachments: [...request.attachments], recent },
        gold: goldWith(request, recent)
      }
    },
    gold: (request) => goldWith(request, recentAt(request)),
    recentAt,
    indexAt
  }
}
