import { boardItemStatus, boardItemTurnEndKind, parseBoardTurnEndReason, type BoardItem } from '../../shared/ipc'
import { RESUME_REASON } from '../board/boardService'
import { PO_MAX_CARDS, PO_MAX_RETURNED_CARDS } from './poPrompt'

/**
 * O PADRÃO do fechamento: tarefa entregue vira concluída.
 *
 * Antes, o cartão que ficava "em andamento" no fim do turno só escapava do
 * "a fazer" se o PO emitisse CONCLUIR — e o prompt mandava o contrário na
 * dúvida ("Na dúvida, responda OK"). No diário real, 68 de 178 fechamentos não
 * mudaram nada, e o cartão entregue voltava para "a fazer" toda vez que a
 * resposta terminava com uma pergunta. Agora é o inverso: cada cartão da seção
 * de devolvidos do digest é concluído, a menos que o PO escreva PENDENTE para
 * ele — o único jeito de um turno normal deixar um cartão "a fazer".
 *
 * O padrão só vale com um veredito LIDO. Sem resposta do PO (teto de 30 s, sem
 * conta, falha, gate dizendo que o turno foi só conversa) nada é concluído: o
 * fim do turno devolve para "a fazer" e o veredito atrasado conclui depois.
 * Turno interrompido (erro, Stop) nem chega aqui — o PO não fecha esse turno.
 */

/** O motivo gravado no cartão concluído pelo padrão (sem CONCLUIR explícito). */
export const PO_DEFAULT_COMPLETE_REASON = 'entregue: o turno terminou e a resposta não diz que faltou algo'

export interface PoReturnedInput {
  /** O quadro da conversa como a rodada o leu (já na ordem do quadro). */
  cards: readonly BoardItem[]
  /** Trabalho em segundo plano rodando: o fechamento é delegado e nada volta. */
  background: boolean
  /** Os ids que o último fim de turno rebaixou (`BoardService.reopenedAtLastTurnEnd`). */
  demotedAtTurnEnd?: ReadonlySet<string> | null
  /** Rodada da fila (cooldown, retentativa) com um turno NOVO rodando: o que está
   *  em andamento é dele, e quem o julga é o fechamento dele. */
  turnRunning?: boolean
}

/** Rebaixado por um fim de turno NORMAL e ainda sem PENDENTE nenhum. */
function unjudgedResultEnd(card: BoardItem): boolean {
  if (boardItemTurnEndKind(card) !== 'result') return false
  return !parseBoardTurnEndReason(card.poReason)?.justification
}

/** Em andamento SÓ porque a mensagem do usuário o retomou (`resumeTurn`): ninguém
 *  disse ainda que este turno é sobre ele. */
export function isResumedCard(card: BoardItem): boolean {
  return card.poStatus === 'in_progress' && card.poReason === RESUME_REASON
}

/** O cartão que a ABERTURA deste turno criou para o pedido (NOVA nasce em
 *  andamento, com o status na camada do agente). Todo fim de turno conclui ou
 *  rebaixa o que está em andamento, então um desses só pode ser do turno atual. */
function openedThisTurn(card: BoardItem): boolean {
  return card.origin === 'po' && card.poStatus === null && card.sourceStatus === 'in_progress'
}

/**
 * Os cartões que ESTE fechamento julga — a seção de devolvidos do digest e,
 * sem PENDENTE, os concluídos pelo padrão.
 *
 * São os que ficaram "em andamento" e, quando a rodada veio da fila do cooldown
 * (o fim do turno já os rebaixou antes de o PO rodar), os que aquele fim de
 * turno acabou de devolver para "a fazer" sem justificativa. Nos mesmos tetos
 * do digest: cartão que o modelo não viu não é concluído por ele.
 *
 * A exceção é o cartão RETOMADO quando a abertura criou um cartão novo para o
 * pedido: o usuário mudou de assunto, o retomado não andou, e concluí-lo pelo
 * padrão marcaria como pronto o que ficou esperando. Ele volta para "a fazer"
 * no fim do turno, como sempre voltou (o vai-e-vem), salvo CONCLUIR explícito.
 */
export function poReturnedCards(input: PoReturnedInput): BoardItem[] {
  if (input.background || input.turnRunning) return []
  const demoted = input.demotedAtTurnEnd ?? null
  const visible = input.cards.slice(0, PO_MAX_CARDS)
  const newSubject = visible.some(openedThisTurn)
  return visible
    .filter((card) => {
      if (card.dismissedAt !== null) return false
      if (boardItemStatus(card) === 'in_progress') return !(newSubject && isResumedCard(card))
      return demoted?.has(card.id) === true && unjudgedResultEnd(card)
    })
    .slice(0, PO_MAX_RETURNED_CARDS)
}

const VERB_LINE = /^(OK|CONCLUIR|ANDAMENTO|TITULO|PENDENTE|FEITA|NOVA|SEGURAR)\b/i

function cleanLines(raw: string): string[] {
  return (raw ?? '').split(/\r?\n/).map((line) => line.replace(/^[`\s>*-]+/, '').trim())
}

/** Resposta no formato pedido (OK ou alguma linha de operação). Texto solto não
 *  é veredito: o modelo não respondeu à pergunta, e o padrão não vale. */
export function isReadablePoVerdict(raw: string): boolean {
  return cleanLines(raw).some((line) => VERB_LINE.test(line))
}

/** Os ids que o veredito já julgou: CONCLUIR e PENDENTE, inclusive o PENDENTE
 *  sem motivo que o parser descarta — o modelo quis segurar o cartão, e
 *  concluí-lo pelo padrão seria o contrário do que ele disse. */
function judgedIds(raw: string): Set<string> {
  const ids = new Set<string>()
  for (const line of cleanLines(raw)) {
    const match = /^(?:CONCLUIR|PENDENTE)\s+([^\s|]+)/i.exec(line)
    if (match) ids.add(match[1])
  }
  return ids
}

/** Os devolvidos que o veredito não citou: estes viram concluídos pelo padrão. */
export function defaultCompletions(raw: string, returned: readonly BoardItem[]): BoardItem[] {
  if (!isReadablePoVerdict(raw)) return []
  const judged = judgedIds(raw)
  return returned.filter((card) => !judged.has(card.id))
}

/**
 * A guarda da conclusão pelo padrão, conferida com o cartão travado na escrita:
 * ele continua como o fim do turno o deixou — intocado desde a leitura da
 * rodada, ou rebaixado por um fim de turno normal e sem PENDENTE. Retomado pela
 * mensagem seguinte, arrastado pelo usuário ou dispensado, a decisão mais nova
 * vale. (O CONCLUIR explícito não tem guarda: é o PO falando daquele cartão.)
 */
export function untouchedSinceTurnEnd(listed: BoardItem): (current: BoardItem) => boolean {
  return (current) => current.dismissedAt === null && (current.revision === listed.revision || unjudgedResultEnd(current))
}
