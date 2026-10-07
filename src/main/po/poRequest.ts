import type { BoardConfig, BoardItem, BoardItemStatus } from '../../shared/ipc'
import { isResumedCard } from './poCloseDefault'
import type { PoGitEvidence } from './poGit'
import { formatPoNextPrompt, type PoNextPrompt } from './poHold'
import type { PoAuthorization } from '../../shared/poAuthorization'
import { formatPoAuthorizationClose, formatPoAuthorizationOpen } from './poAuthorization'
import { buildPoPrompt, type PoCall, type PoLedgerTask, type PoPhase } from './poPrompt'
import type { PoObserverRequest } from './poProviders'

/**
 * A montagem do pedido de UMA rodada do PO ao modelo: o digest e a requisição
 * congelada que as rotas (Claude, Luna) recebem. Saiu de po.ts pelo teto de
 * tamanho — lá fica a fila, o cooldown e a ordem das coisas; aqui, só o que vai
 * no pedido.
 */

/** O cartão como o digest e o gate o veem: id, título efetivo e status efetivo. */
export interface PoDigestCard {
  id: string
  title: string
  status: BoardItemStatus
}

export function poDigestCards(cards: readonly BoardItem[]): PoDigestCard[] {
  return cards.map((card) => ({
    id: card.id,
    title: card.poTitle ?? card.sourceTitle,
    status: card.poStatus ?? card.sourceStatus
  }))
}

export interface PoRequestInput {
  config: BoardConfig
  convId: string
  cwd: string
  projectId: string
  phase: PoPhase
  cards: readonly BoardItem[]
  userText: string
  calls: readonly PoCall[]
  reply?: string | null
  ledgerTasks: PoLedgerTask[]
  background: readonly string[]
  /** Os cartões que este fechamento julga (`poReturnedCards`). */
  returned: readonly BoardItem[]
  /** O git da pasta (poGit.ts); `null`/ausente: a seção some. */
  git?: PoGitEvidence | null
  /** Só no fechamento: o próximo prompt da fila (poHold.ts); ausente, sem SEGURAR. */
  next?: PoNextPrompt | null
  /** A autorização de commit/push da conversa e se ela tem fila (poAuthorization.ts). */
  authorization?: { current: PoAuthorization | null; hasQueue: boolean } | null
  correlationId: string
}

/** As seções que só existem conforme a conversa: a autorização e o próximo prompt. */
function extraSections(input: PoRequestInput): string[] {
  const out: string[] = []
  const auth = input.authorization
  if (input.phase === 'open' && auth) out.push(formatPoAuthorizationOpen(auth.current, auth.hasQueue))
  if (input.phase === 'close' && auth?.current) out.push(formatPoAuthorizationClose(auth.current))
  if (input.phase === 'close' && input.next) out.push(formatPoNextPrompt(input.next))
  return out
}

export function buildPoRequest(input: PoRequestInput): PoObserverRequest {
  const base = buildPoPrompt({
    userText: input.userText,
    cards: poDigestCards(input.cards),
    calls: [...input.calls],
    phase: input.phase,
    ledgerTasks: input.ledgerTasks,
    agentReply: input.reply,
    background: input.background,
    returned: input.returned.map((card) => card.id),
    resumed: input.returned.filter(isResumedCard).map((card) => card.id),
    git: input.git
  })
  const prompt = [base, ...extraSections(input)].join('\n\n')
  return Object.freeze({
    prompt,
    model: input.config.po.model,
    conversationId: input.convId,
    cwd: input.cwd,
    projectId: input.projectId,
    phase: input.phase,
    cards: Object.freeze(input.cards.map((card) => Object.freeze({
      id: card.id,
      projectId: card.projectId,
      projectCwd: card.projectCwd,
      conversationId: card.conversationId,
      sourceTitle: card.sourceTitle,
      sourceStatus: card.sourceStatus,
      poTitle: card.poTitle,
      poStatus: card.poStatus
    }))),
    correlationId: input.correlationId
  })
}
