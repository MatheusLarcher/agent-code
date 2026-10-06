/**
 * O feed do Escritório 3D no celular: o mesmo OfficeFeed que o App.tsx do PC
 * publica, montado com o que a ponte manda (`/api/state` + o SSE). O motor do
 * PC (src/renderer/src/office3d) desenha igual — só a origem dos dados muda.
 *
 * O que a ponte não manda fica vazio: trilhas de subagente, Vigia/PO/Memorista,
 * contas Claude e ícones de projeto. O "o que o agente está fazendo" (a última
 * ferramenta do turno) vem de um pequeno histórico por conversa, alimentado por
 * TODO evento do SSE (`client.eventTaps`) — não só o da conversa aberta.
 */
import type { Conversation, UIMessage } from '@renderer/types'
import type { OfficeFeed } from '@renderer/office/adapter/feed'
import type { FeedSource } from '@renderer/office3d/engineTypes'
import type { PermissionRequest } from '@shared/ipc'
import { reduce } from '../core/reducer'
import type { AppState, RemoteClient } from '../core/client'
import type { BridgeEvent, ChatMsg, ConvSummary } from '../core/types'

/** Eventos guardados por conversa: o turno atual basta (o modelo só lê a última ferramenta). */
const KEEP = 40

const ZERO_TOKENS = { context: 0, output: 0, cost: 0 }

/** O resumo da ponte no formato de Conversation que o modelo do escritório lê (id, cwd, título, modelo, mensagens). */
export function toConversation(c: ConvSummary, messages: readonly ChatMsg[]): Conversation {
  return {
    id: c.id,
    title: c.title,
    cwd: c.cwd,
    model: c.model ?? '',
    effort: c.effort,
    sdkSessionId: null,
    messages: messages as unknown as UIMessage[],
    tokens: c.tokens ? { context: c.tokens.context, output: c.tokens.output, cost: c.tokens.cost } : ZERO_TOKENS,
    todoPlan: c.todoPlan,
    createdAt: c.updatedAt,
    updatedAt: c.updatedAt
  } as Conversation
}

/** Junta um evento ao histórico curto da conversa (turn-start abre um turno novo). */
export function track(list: readonly ChatMsg[], msg: BridgeEvent): ChatMsg[] {
  const ev = msg.event as ChatMsg
  if (ev.kind === 'turn-start') return [{ kind: 'user', id: `turn-${Date.now()}`, text: '' }]
  const next = reduce(list as ChatMsg[], ev)
  return next.length > KEEP ? next.slice(next.length - KEEP) : next
}

export class PhoneOfficeFeed implements FeedSource {
  private readonly turns = new Map<string, ChatMsg[]>()
  private readonly busySince: Record<string, number> = {}
  private readonly subs = new Set<(feed: OfficeFeed) => void>()
  private snap: OfficeFeed | null = null
  private readonly off: Array<() => void> = []

  constructor(private readonly client: RemoteClient) {
    const tap = (msg: BridgeEvent): void => {
      if (!msg?.convId || !msg.event) return
      this.turns.set(msg.convId, track(this.turns.get(msg.convId) ?? [], msg))
      this.publish(client.state)
    }
    client.eventTaps.add(tap)
    this.off.push(() => client.eventTaps.delete(tap))
    this.off.push(client.store.subscribe(() => this.publish(client.state)))
    this.publish(client.state)
  }

  /** O feed de agora, a partir do estado do cliente. */
  build(s: AppState, now = Date.now()): OfficeFeed {
    const busyIds = new Set<string>()
    const permissions: Record<string, PermissionRequest> = {}
    const stalledSince: Record<string, number> = {}
    const conversations = s.conversations.map((c) => {
      if (c.busy) {
        busyIds.add(c.id)
        this.busySince[c.id] ??= now
      } else delete this.busySince[c.id]
      if (c.permission) permissions[c.id] = c.permission
      if (c.stalledSince) stalledSince[c.id] = c.stalledSince
      // A conversa aberta tem o histórico completo; as outras, o turno acompanhado pelo SSE.
      const msgs = c.id === s.convId && s.messages.length ? s.messages : (this.turns.get(c.id) ?? [])
      return toConversation(c, msgs)
    })
    return {
      conversations,
      activeId: s.convId,
      busyIds,
      busySince: { ...this.busySince },
      permissions,
      vigiaAlerts: {},
      vigiaAt: {},
      poDiagnostics: {},
      memoristaDiagnostics: {},
      observersOn: { po: false, vigia: false, memorista: false },
      stalledSince,
      tracks: {},
      projectIcons: {},
      usageLimits: s.usage,
      speakingId: null
    }
  }

  private publish(s: AppState): void {
    this.snap = this.build(s)
    for (const cb of [...this.subs]) cb(this.snap)
  }

  getSnapshot(): OfficeFeed | null {
    return this.snap
  }

  subscribe(cb: (feed: OfficeFeed) => void): () => void {
    this.subs.add(cb)
    return () => void this.subs.delete(cb)
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f()
    this.subs.clear()
  }
}
