/**
 * O espelho da Central (a volta), puro: dos pedidos ancorados, o que escrever.
 *
 * Para cada pedido deste PC com âncora e sem resposta terminada, o turno do
 * destino (`mirrorTurn`) vira UMA resposta: criada no primeiro conteúdo (vai
 * para o fim da lista, na ordem do tempo) e depois atualizada no lugar, pelo id
 * determinístico. Só o que a Central mostra é copiado — comentários, resposta
 * final, linha-resumo —; ferramentas, pensamento e subagentes nunca.
 */
import type { CentralAnchor, CentralEntry, CentralReplyEntry, CentralState } from '@shared/central'
import type { Conversation, UIMessage } from '../types'
import { mirrorTurn } from './centralMirror'
import { capAnswer, capNotes, isOwnEntry, removeReplyOf, replyIdFor, upsertReply } from './centralEntries'

export interface MirrorInput {
  entries: readonly CentralEntry[]
  convs: ReadonlyMap<string, Conversation>
  /** Conversas ocupadas agora. */
  busy: ReadonlySet<string>
  /** `installationId` deste PC (as entradas do outro PC, ele espelha). */
  self: string | undefined
  now: number
}

export interface MirrorPlan {
  /** Respostas a gravar (novas ou mudadas). */
  upserts: CentralReplyEntry[]
  /** Pedidos cuja resposta é de uma âncora velha ("não era aqui"): sai. */
  removals: string[]
  /** Destinos fora da tela com turno em aberto (re-link: carregar por id). */
  missing: string[]
}

const sameAnchor = (a: CentralAnchor | undefined, b: CentralAnchor | undefined): boolean =>
  !!a && !!b && a.convId === b.convId && a.msgId === b.msgId

/** A última mensagem do usuário que abre turno (o "agora" injetado não abre). */
function lastTurnAnchor(messages: readonly UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user' && !m.injected) return m.id
  }
  return undefined
}

/** O que a tela mostra de uma resposta (para não regravar a Central à toa). */
const shown = (r: CentralReplyEntry): string =>
  JSON.stringify([r.anchor, r.notes, r.answer ?? null, r.activity, r.done, r.device ?? null])

export function planMirror(input: MirrorInput): MirrorPlan {
  const { entries, convs, busy, self, now } = input
  const replies = new Map<string, CentralReplyEntry>()
  for (const e of entries) if (e.kind === 'reply') replies.set(e.requestId, e)
  const lastAnchors = new Map<string, string | undefined>()
  const plan: MirrorPlan = { upserts: [], removals: [], missing: [] }
  for (const e of entries) {
    if (e.kind !== 'request' || !e.anchor || e.injected || !isOwnEntry(e, self)) continue
    const anchor = e.anchor
    let reply = replies.get(e.id)
    if (reply && !sameAnchor(reply.anchor, anchor)) {
      plan.removals.push(e.id)
      reply = undefined
    }
    const dest = convs.get(anchor.convId)
    const running = busy.has(anchor.convId)
    if (reply?.done) {
      // Terminada fica parada — a não ser que o MESMO turno rode de novo (reenvio, retomada).
      if (!dest || !running) continue
      if (!lastAnchors.has(dest.id)) lastAnchors.set(dest.id, lastTurnAnchor(dest.messages))
      if (lastAnchors.get(dest.id) !== anchor.msgId) continue
    }
    if (!dest) {
      if (!plan.missing.includes(anchor.convId)) plan.missing.push(anchor.convId)
      continue
    }
    const turn = mirrorTurn(dest.messages, anchor.msgId, running)
    if (!turn?.started) continue
    const answer = capAnswer(turn.answer)
    const device = self ?? reply?.device
    const next: CentralReplyEntry = {
      kind: 'reply',
      id: reply?.id ?? replyIdFor(e.id),
      ts: reply?.ts ?? now,
      requestId: e.id,
      anchor: { convId: anchor.convId, msgId: anchor.msgId },
      notes: capNotes(turn.notes),
      ...(answer !== undefined ? { answer } : {}),
      activity: turn.activity,
      done: turn.done,
      ...(device ? { device } : {})
    }
    if (!reply || shown(reply) !== shown(next)) plan.upserts.push(next)
  }
  return plan
}

/**
 * Aplica o plano sobre o estado MAIS NOVO da Central (pode ter mudado desde o
 * cálculo): a resposta só entra se o pedido ainda tem aquela âncora.
 */
export function applyMirror(state: CentralState | undefined, plan: MirrorPlan): CentralState {
  let next: CentralState = state ?? { entries: [] }
  for (const requestId of plan.removals) next = removeReplyOf(next, requestId)
  for (const reply of plan.upserts) {
    const request = next.entries.find((e) => e.kind === 'request' && e.id === reply.requestId)
    if (request?.kind !== 'request' || !sameAnchor(request.anchor, reply.anchor)) continue
    next = upsertReply(next, reply)
  }
  return next
}
