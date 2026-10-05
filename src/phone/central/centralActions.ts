/**
 * A Central no celular — a conversa única que leva cada pedido à conversa certa
 * (no PC: src/renderer/src/central/). O celular desenha o retrato que o PC publica
 * em `conversation.central` (centralRemote.ts) e manda as escolhas/respostas.
 * Porta das regras do www/central.js e centralTurns.js.
 */
import type { PermissionRequest, QuestionAnswer } from '@shared/ipc'
import type { RemoteCentral, RemoteCentralEntry, RemoteCentralQuestion, RemoteCentralReply } from '@shared/central'
import { client, toast } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { clipText } from '../core/format'
import { errorText, statusOf } from '../core/net'
import { isHiddenMessage } from '../core/reducer'
import type { ChatMsg, ConvSummary } from '../core/types'
import { CENTRAL_BUSY_TTL_MS, CENTRAL_SENT_TTL_MS, centralUi, type CentralQuote, type TurnTools } from './centralStore'

export const CENTRAL_QUOTE_MAX = 160

export interface CentralSnapshot {
  entries: RemoteCentralEntry[]
  rail: RemoteCentral['rail']
  questions: RemoteCentralQuestion[]
}

/** O retrato publicado pelo PC (vazio enquanto não chega). */
export function centralSnapshot(conversations: ConvSummary[]): CentralSnapshot {
  const c = conversations.find((x) => x.id === CENTRAL_CONV_ID)?.central
  return {
    entries: Array.isArray(c?.entries) ? c.entries : [],
    rail: Array.isArray(c?.rail) ? c.rail : [],
    questions: Array.isArray(c?.questions) ? c.questions : []
  }
}

/** A cor do destino vem do PC (paleta fixa); qualquer outra coisa vira a neutra. */
export function tint(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--muted)'
}

/** Some a bolha "enviando…" que o retrato já trouxe (ou venceu) e destrava escolha/resposta já aplicada. */
export function pruneCentral(snap: CentralSnapshot, now = Date.now()): void {
  const ui = centralUi.get()
  const sent = ui.sent.filter((s) => {
    if (now - s.at > CENTRAL_SENT_TTL_MS) return false
    return !snap.entries.some(
      (e) => e && e.kind === 'request' && !s.known[e.id] && String(e.text || '').slice(0, 200) === s.text.slice(0, 200)
    )
  })
  const busy: Record<string, number> = {}
  for (const [key, at] of Object.entries(ui.busy)) {
    const pending = key.startsWith('q:')
      ? snap.questions.some((q) => q?.request && 'q:' + q.request.id === key)
      : snap.entries.some((e) => e && e.kind === 'request' && e.id === key && e.state === 'asking')
    if (pending && now - at <= CENTRAL_BUSY_TTL_MS) busy[key] = at
  }
  if (sent.length !== ui.sent.length || Object.keys(busy).length !== Object.keys(ui.busy).length) centralUi.set({ sent, busy })
}

let soon: ReturnType<typeof setTimeout>[] = []
/** O PC publica o retrato ~0,4 s depois de mudar: lê de novo logo, sem esperar o ciclo de 4 s. */
export function refreshCentralSoon(): void {
  soon.forEach(clearTimeout)
  soon = [700, 1800, 3500].map((ms) => setTimeout(() => void client.fetchState().catch(() => undefined), ms))
}

/** Enviado daqui: bolha "enviando…" até o retrato trazer o pedido (ids que já existiam não contam). */
export function centralNoteSent(text: string, files: number): void {
  const known: Record<string, true> = {}
  for (const e of centralSnapshot(client.state.conversations).entries) if (e) known[e.id] = true
  centralUi.set((s) => ({ sent: [...s.sent, { text, files, at: Date.now(), known }] }))
  refreshCentralSoon()
}

export function centralSendFailed(text: string): void {
  centralUi.set((s) => ({ sent: s.sent.filter((x) => x.text !== text) }))
}

function isForeignRequest(entryId: string): boolean {
  return centralSnapshot(client.state.conversations).entries.some((e) => e && e.kind === 'request' && e.id === entryId && e.foreign === true)
}

/** "Para onde vai?": a opção vai ao PC, que entrega como no clique de lá (nunca para pedido de outro PC). */
export function centralChoose(entryId: string, option: number): void {
  if (centralUi.get().busy[entryId] || isForeignRequest(entryId)) return
  centralUi.set((s) => ({ busy: { ...s.busy, [entryId]: Date.now() } }))
  client.centralChoose(entryId, option).then(refreshCentralSoon, (err) => {
    centralUi.set((s) => {
      const busy = { ...s.busy }
      delete busy[entryId]
      return { busy }
    })
    if (statusOf(err) === 409) return // outro celular pareado: a tela própria já assumiu
    toast('Não foi possível escolher o destino: ' + errorText(err))
  })
}

/** Pergunta/permissão de um destino: a resposta vai com o convId DO DESTINO. */
export function answerDestination(q: RemoteCentralQuestion, req: PermissionRequest, behavior: 'allow' | 'deny', answers?: QuestionAnswer[]): void {
  const key = 'q:' + req.id
  if (centralUi.get().busy[key]) return
  centralUi.set((s) => {
    const picks = { ...s.picks }
    delete picks[q.convId + ':' + req.id]
    return { busy: { ...s.busy, [key]: Date.now() }, picks }
  })
  client.permissionRespond(q.convId, { id: req.id, behavior, always: false, answers }).catch((err) => {
    if (statusOf(err) !== 409) toast('Não foi possível responder: ' + errorText(err))
  })
  refreshCentralSoon()
}

/** A citação de uma entrada, ou null quando não se responde (sem destino ou de outro PC). */
export function centralQuoteOf(e: RemoteCentralEntry): CentralQuote | null {
  if (!e || !('anchor' in e) || !e.anchor?.convId || ('foreign' in e && e.foreign === true)) return null
  if (e.kind === 'request') {
    if (e.state !== 'delivered') return null
    const n = e.notice
    return { id: e.id, who: n?.to || '', color: n?.color, text: clipText(e.text, CENTRAL_QUOTE_MAX) }
  }
  if (e.kind === 'reply') {
    const notes = Array.isArray(e.notes) ? e.notes : []
    const body = e.answer || notes[notes.length - 1] || e.activity?.text || ''
    return { id: e.id, who: e.who || '', color: e.color, text: clipText(body, CENTRAL_QUOTE_MAX) }
  }
  return null
}

function anchorAt(msgs: ChatMsg[], msgId: string): number {
  return msgs.findIndex((m) => m && m.kind === 'user' && m.id === msgId)
}

/** Os tool-use do turno (sem subagente nem plano): da âncora até a próxima mensagem do usuário que abre turno. */
export function turnToolsOf(msgs: ChatMsg[], msgId: string): { tools: ChatMsg[]; closed: boolean } | null {
  const start = anchorAt(msgs, msgId)
  if (start < 0) return null
  const tools: ChatMsg[] = []
  for (let i = start + 1; i < msgs.length; i++) {
    const m = msgs[i]
    if (m && m.kind === 'user' && !m.injected) return { tools, closed: true }
    if (m && m.kind === 'tool-use' && !isHiddenMessage(m)) tools.push(m)
  }
  return { tools, closed: false }
}

function setTools(id: string, t: TurnTools): void {
  centralUi.set((s) => ({ tools: { ...s.tools, [id]: t } }))
}

/** As ações do turno, lidas do destino: `/api/history`; âncora fora das últimas mensagens, a janela em volta dela. */
export function loadTurnTools(r: RemoteCentralReply): void {
  const prev = centralUi.get().tools[r.id]
  if (prev?.loading) return
  const count = r.activity?.count || 0
  setTools(r.id, { loading: true, count, found: !!prev?.found, list: prev?.list ?? [], closed: !!prev?.closed, partial: !!prev?.partial })
  const conv = encodeURIComponent(r.anchor.convId)
  const msgId = r.anchor.msgId ?? ''
  client
    .request<{ messages?: ChatMsg[] }>(`/api/history?conv=${conv}`)
    .then(async (data) => {
      const msgs = data?.messages ?? []
      if (anchorAt(msgs, msgId) >= 0) return { msgs, partial: false }
      try {
        const w = await client.request<{ messages?: ChatMsg[] }>(`/api/history-window?conv=${conv}&message=${encodeURIComponent(msgId)}`)
        return { msgs: w?.messages ?? [], partial: true }
      } catch (err) {
        if (statusOf(err) === 404) return { msgs: [] as ChatMsg[], partial: true }
        throw err
      }
    })
    .then(
      (got) => {
        const turn = turnToolsOf(got.msgs, msgId)
        setTools(r.id, { loading: false, count, found: !!turn, list: turn?.tools ?? [], closed: !!turn?.closed, partial: got.partial })
      },
      (err) => setTools(r.id, { loading: false, count, error: errorText(err) })
    )
}

export function toggleTurnTools(r: RemoteCentralReply): void {
  const open = !centralUi.get().open[r.id]
  centralUi.set((s) => ({ open: { ...s.open, [r.id]: open } }))
  if (open) loadTurnTools(r)
}
