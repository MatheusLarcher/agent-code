import { CARD_ETAPA_PREFIX, parseMs } from '../../shared/handoffTracking'
import { BOARD_USER_MOVE_REASON_PREFIX, boardItemStatus, parseBoardTurnEndReason, type BoardItem } from '../../shared/ipc'

/**
 * O casamento do cartão do Quadro com a etapa do envio, puro — a parte das
 * regras (handoffRules.ts, que reexporta tudo daqui) que diz QUAL cartão fala
 * por uma etapa e o que ele diz dela.
 */

const ETAPA_PREFIX = /^\s*\[([^\]\s]{1,64})\]/

/** O id da etapa no começo do título (`[id-da-etapa] …`), em minúsculas; `null` sem prefixo. */
export function etapaIdFromTitle(title: string | null | undefined): string | null {
  const match = ETAPA_PREFIX.exec(title ?? '')
  return match ? match[1].toLowerCase() : null
}

/** Folga da trava de época. O marco (`criadoEm` do envio) e o `createdAt` do
 *  cartão vêm do mesmo relógio, o do banco (Postgres `now()`; no SQLite, o do
 *  processo do repositório); a folga é só margem. */
export const CARD_EPOCH_SLACK_MS = 60_000

/** De quem é a entrega — o desempate entre cartões da mesma etapa. */
export interface CardPreference {
  conversationId?: string | null
  /** O cartão a que a entrega já está ligada. */
  boardItemId?: string | null
  /** A época do envio — o registro do lote (`criadoEm`): cartão criado antes
   *  dela, menos a folga, é de outro plano. `null`/ausente = sem trava. */
  since?: string | null
}

/** Concluído e não contestado pelo PO: é o que diz que a etapa foi feita. */
function isCardDone(card: BoardItem): boolean {
  return boardItemStatus(card) === 'completed' && poContestReason(card) === null
}

function isCardRunning(card: BoardItem): boolean {
  return boardItemStatus(card) === 'in_progress' && poContestReason(card) === null
}

/** Criado antes da época do envio (menos a folga). Data ilegível não trava. */
function predatesEnvio(card: BoardItem, since: string | null | undefined): boolean {
  const epoch = parseMs(since)
  const created = parseMs(card.createdAt)
  return epoch !== null && created !== null && created < epoch - CARD_EPOCH_SLACK_MS
}

/**
 * O cartão da etapa no Quadro do PROJETO: título (do agente ou do PO) com o
 * prefixo `[id]`, ou o próprio cartão em `card:<id>`; item sem prefixo é
 * subitem. Dispensado não conta — salvo o concluído e não contestado: a
 * expiração automática (2 dias) não desfaz a etapa. Trava de época: pelo
 * prefixo, o cartão criado antes do registro do lote (`pref.since`, menos a
 * folga) é de outro plano — o `[etapa-1]` repetido entre planos não conclui a etapa nova;
 * o já ligado e o `card:<id>` não passam pela trava. Vários: os concluídos
 * primeiro (o cartão novo pendente com o mesmo prefixo — a lista nova depois de
 * retomar — não regride a etapa feita); no empate, o em andamento > o já
 * ligado > o da mesma conversa > o atualizado por último.
 */
export function cardForEtapa(cards: readonly BoardItem[], etapaId: string, pref: CardPreference = {}): BoardItem | null {
  const byId = etapaId.startsWith(CARD_ETAPA_PREFIX) ? etapaId.slice(CARD_ETAPA_PREFIX.length) : null
  const id = etapaId.toLowerCase()
  const candidates = cards.filter((card) => {
    if (card.dismissedAt !== null && !isCardDone(card)) return false
    if (byId !== null) return card.id === byId
    if (etapaIdFromTitle(card.sourceTitle) !== id && etapaIdFromTitle(card.poTitle) !== id) return false
    return card.id === pref.boardItemId || !predatesEnvio(card, pref.since)
  })
  const done = candidates.filter(isCardDone)
  // Entre concluídos o "em andamento" empata (nenhum está); sem concluído, o que
  // está andando AGORA vence o ligado parado — a lista nova depois de retomar.
  const rank = (card: BoardItem): number[] => [
    isCardRunning(card) ? 1 : 0,
    card.id === pref.boardItemId ? 1 : 0,
    pref.conversationId && card.conversationId === pref.conversationId ? 1 : 0,
    parseMs(card.updatedAt) ?? 0
  ]
  let best: { card: BoardItem; rank: number[] } | null = null
  for (const card of done.length > 0 ? done : candidates) {
    const r = rank(card)
    // Empate completo: vale o último da lista (como sempre foi).
    if (!best || compareRank(r, best.rank) >= 0) best = { card, rank: r }
  }
  return best?.card ?? null
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * O motivo da contestação do PO, ou `null`. Contestado = o agente concluiu e o
 * PO sobrepôs outro status. NÃO é contestação: o fim de turno devolvendo
 * "fazendo" para "a fazer" (regra do app) nem o arrasto do usuário no Quadro.
 */
export function poContestReason(card: BoardItem): string | null {
  if (card.sourceStatus !== 'completed' || card.poStatus === null || card.poStatus === 'completed') return null
  if (parseBoardTurnEndReason(card.poReason)) return null
  if (card.poReason?.startsWith(BOARD_USER_MOVE_REASON_PREFIX)) return null
  return card.poReason?.trim() || 'sem motivo registrado'
}

/** Por que a etapa NÃO está concluída, dito pelo cartão (ou pela falta dele). */
export function blockReason(card: BoardItem | null, etapaId: string): string {
  if (!card) return `sem cartão no Quadro com o prefixo [${etapaId}]`
  const contest = poContestReason(card)
  if (contest) return `o PO contestou: ${contest}`
  const status = boardItemStatus(card)
  const label = status === 'in_progress' ? 'cartão em andamento' : status === 'pending' ? 'cartão a fazer' : 'cartão concluído'
  // O motivo do PO/do app diz o que o status sozinho não diz ("o turno terminou
  // sem concluir esta tarefa — falta verificar…").
  const why = card.poReason?.trim()
  return why ? `${label} (${why})` : label
}
