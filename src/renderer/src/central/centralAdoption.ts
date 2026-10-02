/**
 * Emenda A1: todo turno que começa NESTE PC — no campo da conversa, do celular
 * direto para ela, MCP, dreno da fila, "agora" — também aparece na Central.
 *
 * O App chama `adoptTurn` em cada ponto que cria a bolha do usuário. Fica de
 * fora: a Central (nunca se espelha) e o planejamento (tem tela própria). Bolha
 * com id pré-definido já tem dono na Central (entregue por ela, ou o mesmo turno
 * de volta à fila) e não é adotada de novo.
 */
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { readableMediaText } from '@shared/inlineMedia'
import { CENTRAL_ID, isCentralConversation, type CentralState } from '@shared/central'
import type { Conversation } from '../types'
import { withFallbackTitle } from '../conversationTitle'
import { centralAttachmentNames } from './centralRegistry'
import { adoptedRequestEntry, appendAdopted, markInjected } from './centralEntries'
import { conversationTarget } from './centralRecents'

/** Uma bolha do usuário que acabou de nascer numa conversa. */
export interface CentralTurnStart {
  /** A conversa ANTES da bolha (o título de recuo é calculado aqui). */
  conv: Conversation
  msgId: string
  text: string
  images: ImageAttachment[]
  files: FileAttachment[]
  fileRefs: FileRefAttachment[]
  /** O id da bolha veio decidido (âncora da Central, ou o turno de volta à fila). */
  preset?: boolean
  /** Ajuste injetado no turno em andamento ("agora" da fila). */
  injected?: boolean
}

export type CentralAdopt = (turn: CentralTurnStart) => void

export interface AdoptionDeps {
  /** `installationId` deste PC. */
  device: string | undefined
  sandboxRoot: string
  /** A Central na tela (o boot pode ainda estar lendo). */
  ensure: () => Promise<Conversation | null>
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
}

/** Muda a Central depois de garantir que ela está na tela; mudança vazia não toca nela. */
async function patchCentral(d: AdoptionDeps, fn: (s: CentralState | undefined) => CentralState): Promise<void> {
  if (!(await d.ensure())) return
  d.patchConv(CENTRAL_ID, (c) => {
    const next = fn(c.central)
    return next === c.central ? c : { ...c, central: next, updatedAt: Date.now() }
  })
}

export function adoptTurn(d: AdoptionDeps, turn: CentralTurnStart): void {
  const { conv } = turn
  // Planejamento pelo modo (A1: `mode: 'planning'`), mesmo sem o slug do plano.
  if (isCentralConversation(conv) || conv.mode === 'planning') return
  if (turn.preset) {
    // A mensagem da Central entrou como ajuste no turno de lá: bolha, sem resposta própria.
    if (turn.injected) void patchCentral(d, (s) => markInjected(s, conv.id, turn.msgId))
    return
  }
  const titled = withFallbackTitle(conv, readableMediaText(turn.text))
  const entry = adoptedRequestEntry({
    convId: conv.id,
    msgId: turn.msgId,
    text: turn.text,
    attachments: centralAttachmentNames(turn.images, turn.files, turn.fileRefs),
    target: conversationTarget(titled, d.sandboxRoot),
    device: d.device,
    injected: turn.injected
  })
  void patchCentral(d, (s) => appendAdopted(s, entry))
}
