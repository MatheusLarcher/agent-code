import { boardItemStatus, boardTurnEndReason, parseBoardTurnEndReason, type BoardItem, type BoardTurnEndKind } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import type { PoPhase } from './poPrompt'
import type { PoOp } from './poVerdict'

/**
 * Os cartões de OUTRAS conversas do mesmo projeto, vistos pelo PO desta.
 *
 * A tela mostra o quadro do PROJETO inteiro, mas o PO de cada conversa só lia
 * os cartões criados nela. O caso que isso quebrava: o usuário vê um cartão "a
 * fazer" no quadro e escreve no chat de outra conversa "corrige isso" — o agente
 * corrige, diz que fez, e o PO não tinha como concluir um cartão que nem via.
 * Pelo botão do quadro funcionava só porque o botão manda a mensagem para a
 * conversa DONA do cartão.
 *
 * O que entra, e só isso:
 * - os cartões "a fazer" das outras conversas: a abertura pode pôr um deles em
 *   andamento (ANDAMENTO) e o fechamento pode concluí-lo (CONCLUIR) — nada de
 *   renomear, reprovar ou contestar o cartão de outra conversa;
 * - os ADOTADOS: o cartão de outra conversa que a abertura desta pôs em
 *   andamento. Até o fim do turno ele é desta conversa como qualquer outro —
 *   entra no padrão do fechamento (sem PENDENTE, conclui) — e o que não foi
 *   concluído volta para "a fazer" aqui, porque o fim de turno do quadro
 *   (`BoardService.closeTurn`) só rebaixa os cartões da própria conversa.
 *
 * O "em andamento" de outra conversa fica de fora de propósito: é trabalho que o
 * agente de lá está fazendo agora, e o PO daqui não tem o que julgar nele.
 */

/** Teto dos cartões "a fazer" de outras conversas no digest: sobra lugar para
 *  os da própria conversa dentro de PO_MAX_CARDS. */
export const PO_MAX_FOREIGN_CARDS = 15

type PoBoardReader = Pick<BoardService, 'list'>

export interface PoBoardView {
  /** O quadro que a rodada julga: adotados, os da conversa e os "a fazer" de fora. */
  cards: BoardItem[]
  /** Os ids de outra conversa NÃO adotados — só ANDAMENTO/CONCLUIR valem neles. */
  foreign: ReadonlySet<string>
  /** Todos os ids de outra conversa (os "a fazer" e os adotados): a conferência
   *  contra o quadro fresco (`withForeignCards`) precisa achar os dois. */
  outside: ReadonlySet<string>
}

/** `null`: quadro indisponível (o mesmo contrato de `BoardService.list`). */
export async function listPoBoard(
  board: PoBoardReader,
  cwd: string,
  convId: string,
  adopted: ReadonlySet<string>
): Promise<PoBoardView | null> {
  const own = await board.list(cwd, { conversationId: convId })
  if (!own) return null
  // O projeto inteiro é extra: sem ele, a rodada segue com o quadro da conversa.
  const project = (await board.list(cwd).catch(() => null)) ?? []
  const ownIds = new Set(own.map((card) => card.id))
  const outside = project.filter((card) => !ownIds.has(card.id) && card.conversationId !== convId && card.dismissedAt === null)
  const adoptedCards = outside.filter((card) => adopted.has(card.id))
  const pending = outside
    .filter((card) => !adopted.has(card.id) && boardItemStatus(card) === 'pending')
    .slice(0, PO_MAX_FOREIGN_CARDS)
  return {
    cards: [...adoptedCards, ...own, ...pending],
    foreign: new Set(pending.map((card) => card.id)),
    outside: new Set([...adoptedCards, ...pending].map((card) => card.id))
  }
}

/** No cartão de outra conversa, só pôr em andamento (abertura) ou concluir (fechamento). */
export function keepForeignSafe(ops: PoOp[], foreign: ReadonlySet<string> | undefined, phase: PoPhase): PoOp[] {
  if (!foreign || foreign.size === 0) return ops
  return ops.filter((op) => {
    if (op.kind === 'create' || !foreign.has(op.id)) return true
    return phase === 'open' ? op.kind === 'start' : op.kind === 'complete'
  })
}

/** A lista fresca da conferência (`confirmCreates`) com os cartões de fora que o
 *  veredito cita — sem eles, o ANDAMENTO num cartão de outra conversa cairia. */
export async function withForeignCards(
  board: PoBoardReader,
  cwd: string,
  fresh: BoardItem[],
  outside: ReadonlySet<string> | undefined,
  ops: readonly PoOp[]
): Promise<BoardItem[]> {
  if (!outside || !ops.some((op) => op.kind !== 'create' && outside.has(op.id))) return fresh
  const project = (await board.list(cwd).catch(() => null)) ?? []
  const have = new Set(fresh.map((card) => card.id))
  return [...fresh, ...project.filter((card) => outside.has(card.id) && !have.has(card.id))]
}

/**
 * Devolve para "a fazer" o adotado que o turno não concluiu — o papel que o fim
 * de turno do quadro cumpre para os cartões da própria conversa, com a mesma
 * frase (e a justificativa do PENDENTE, quando houver) e autoria "Sistema". A
 * escrita é condicional: o cartão concluído (pelo veredito, pelo usuário ou pela
 * conversa dona) não é tocado. Esvazia `adopted`. Nunca lança.
 */
export async function releaseAdopted(
  board: Pick<BoardService, 'list' | 'applyPo'>,
  cwd: string,
  adopted: Set<string>,
  kind: BoardTurnEndKind
): Promise<void> {
  if (adopted.size === 0) return
  const ids = new Set(adopted)
  adopted.clear()
  try {
    const cards = ((await board.list(cwd)) ?? []).filter((card) => ids.has(card.id) && boardItemStatus(card) === 'in_progress')
    for (const card of cards) {
      const justification = parseBoardTurnEndReason(card.poReason)?.justification
      const keep = card.poUserAction
        ? { userAction: card.poUserAction, ...(card.poReplyKind ? { replyKind: card.poReplyKind } : {}) }
        : {}
      await board
        .applyPo({
          id: card.id,
          poStatus: 'pending',
          poReason: boardTurnEndReason(kind, justification),
          ...keep,
          actor: 'system',
          onlyIf: (current) => boardItemStatus(current) === 'in_progress'
        })
        .catch(() => null)
    }
  } catch {
    // Quadro fora do ar: o cartão fica como está, e o próximo turno o julga.
  }
}

/**
 * Depois de uma rodada: na abertura, o cartão de fora que entrou em andamento
 * vira adotado desta conversa; no fechamento, o adotado não concluído volta.
 */
export async function settleAdoption(
  board: Pick<BoardService, 'list' | 'applyPo'>,
  input: { cwd: string; phase: PoPhase; adopted: Set<string>; foreign: ReadonlySet<string>; touched: readonly string[] }
): Promise<void> {
  if (input.phase === 'open') {
    for (const id of input.touched) if (input.foreign.has(id)) input.adopted.add(id)
    return
  }
  await releaseAdopted(board, input.cwd, input.adopted, 'result')
}
