/**
 * O Quadro real visto pelo Escritório 3D — PURO (sem three, sem DOM). Cada sala
 * guarda o retrato do quadro do projeto (o mesmo `boardList` da aba Quadro em
 * "Projeto inteiro"), compara com o retrato novo pelo id do cartão e transforma
 * cada mudança em PASSOS com autor e texto, na ordem real (`at` dos eventos).
 *
 * Status e título são os EFETIVOS, pelas mesmas funções da tela
 * (`boardItemStatus`/`boardItemTitle` de `@shared/ipc`); a ordem é a que o main
 * devolve (`compareBoardItems`), nunca recalculada aqui.
 *
 * Mudanças (por id):
 *   new        apareceu (nunca visto nesta sala)
 *   moved      o status efetivo mudou (mudou de coluna)
 *   renamed    o título efetivo mudou
 *   removed    sumiu: dispensado ou o agente refez o plano
 *   restored   voltou depois de ter sumido
 *   justified  a revisão subiu sem mudar coluna nem título (o motivo mudou)
 *
 * Passos: um por evento novo do cartão (`boardItemEvents` depois do último já
 * visto). Sem evento novo, o passo nasce do próprio retrato e é do AGENTE: PO,
 * usuário e regras do sistema sempre gravam evento; a ingestão do plano do
 * agente só grava criação e troca de status (o título reescrito e o cartão que
 * sumiu do plano — a linha é apagada — não deixam rastro). Leitura de eventos
 * que falhou: sem autor e com texto neutro (`NEUTRAL_TEXT`). O 3D nunca espera o motivo.
 */
import {
  boardItemAwaitingBadge,
  boardItemStatus,
  boardItemTitle,
  type BoardItem,
  type BoardItemEvent,
  type BoardItemEventActor,
  type BoardItemStatus,
  type BoardTurnEndKind,
  type ProjectBoard
} from '@shared/ipc'

/** As três colunas, na ordem da tela, com a cor da bolinha de cada uma no Quadro do app. */
export const BOARD_COLUMNS: ReadonlyArray<{ status: BoardItemStatus; label: string; color: string }> = [
  { status: 'pending', label: 'A fazer', color: '#5b5854' },
  { status: 'in_progress', label: 'Fazendo', color: '#e0a458' },
  { status: 'completed', label: 'Concluído', color: '#7fae6f' }
]

export function columnIndex(status: BoardItemStatus): number {
  return status === 'pending' ? 0 : status === 'in_progress' ? 1 : 2
}

export function columnLabel(status: BoardItemStatus): string {
  return BOARD_COLUMNS[columnIndex(status)].label
}

/** O que o 3D precisa de um cartão (efetivo). */
export interface BoardCard {
  id: string
  status: BoardItemStatus
  title: string
  revision: number
  conversationId: string
  origin: 'agent' | 'po'
  activeForm: string | null
  /** "Aguardando você" (result) ou "Interrompido" (error); null nos outros. */
  awaiting: BoardTurnEndKind | null
  updatedAt: string
}

/** Retrato de um quadro: `available: false` é "não consegui ler", diferente de vazio. */
export interface BoardSnap {
  available: boolean
  /** Na ordem do main (`compareBoardItems`); dispensados fora. */
  cards: BoardCard[]
}

export function boardCard(item: BoardItem): BoardCard {
  return {
    id: item.id,
    status: boardItemStatus(item),
    title: boardItemTitle(item),
    revision: item.revision,
    conversationId: item.conversationId,
    origin: item.origin,
    activeForm: item.activeForm,
    awaiting: boardItemAwaitingBadge(item)?.kind ?? null,
    updatedAt: item.updatedAt
  }
}

export function boardSnap(board: ProjectBoard): BoardSnap {
  if (!board.available) return { available: false, cards: [] }
  return { available: true, cards: board.items.filter((i) => i.dismissedAt === null).map(boardCard) }
}

export type BoardChangeKind = 'new' | 'moved' | 'renamed' | 'removed' | 'restored' | 'justified'

export interface BoardChange {
  kind: BoardChangeKind
  /** O cartão como ficou (o de antes, em `removed`). */
  card: BoardCard
  prev: BoardCard | null
}

/**
 * Compara dois retratos pelo id. `gone` = ids que já sumiram desta sala antes
 * (quem reaparece "voltou"). Uma mudança por cartão: coluna > título > motivo.
 */
export function diffBoard(prev: BoardSnap, next: BoardSnap, gone: ReadonlySet<string> = new Set()): BoardChange[] {
  const before = new Map(prev.cards.map((c) => [c.id, c]))
  const out: BoardChange[] = []
  for (const card of next.cards) {
    const old = before.get(card.id)
    if (!old) {
      out.push({ kind: gone.has(card.id) ? 'restored' : 'new', card, prev: null })
      continue
    }
    before.delete(card.id)
    if (old.status !== card.status) out.push({ kind: 'moved', card, prev: old })
    else if (old.title !== card.title) out.push({ kind: 'renamed', card, prev: old })
    else if (card.revision > old.revision) out.push({ kind: 'justified', card, prev: old })
  }
  for (const old of before.values()) out.push({ kind: 'removed', card: old, prev: old })
  return out
}

/** Um passo de mudança: o que aconteceu com um cartão, quem fez e por quê. */
export interface BoardStep {
  roomId: string
  cardId: string
  kind: BoardChangeKind
  /** null = não se sabe (sem evento ou leitura que falhou). */
  actor: BoardItemEventActor | null
  /** O motivo (nota do evento) ou um texto curto do que aconteceu; NEUTRAL_TEXT se a leitura falhou. */
  text: string
  /** Quando aconteceu (ISO): a ordem da fila. */
  at: string
  /** Coluna de destino quando o passo muda de coluna (ou cria/restaura). */
  toStatus: BoardItemStatus | null
  convId: string
  title: string
  /** O "fazendo agora" do agente (a fala "Comecei: …"); null sem ele. */
  activeForm?: string | null
}

export const NEUTRAL_TEXT = 'Quadro atualizado'

const EVENT_KIND: Record<BoardItemEvent['kind'], BoardChangeKind> = {
  created: 'new',
  status_changed: 'moved',
  retitled: 'renamed',
  note_changed: 'justified',
  dismissed: 'removed',
  restored: 'restored',
  justified: 'justified'
}

/** Texto do passo quando o evento não traz nota (ou quando o passo nasce do retrato). */
export function stepText(kind: BoardChangeKind, toStatus: BoardItemStatus | null): string {
  switch (kind) {
    case 'new':
      return 'criou o cartão'
    case 'moved':
      return toStatus ? `mudou para ${columnLabel(toStatus).toLowerCase()}` : 'mudou de coluna'
    case 'renamed':
      return 'reescreveu o título'
    case 'removed':
      return 'tirou do quadro'
    case 'restored':
      return 'restaurou o cartão'
    case 'justified':
      return 'justificou'
  }
}

/**
 * Os passos de UMA mudança. `events`: a linha do tempo do cartão (null = a
 * leitura falhou); `since`: o último `at` já visto (só o que veio depois vira
 * passo). Ordenados por `at`.
 */
export function stepsFor(roomId: string, change: BoardChange, events: readonly BoardItemEvent[] | null, since: string | null): BoardStep[] {
  const { card } = change
  const base = { roomId, cardId: card.id, convId: card.conversationId, title: card.title, activeForm: card.activeForm }
  const statusOf = (kind: BoardChangeKind): BoardItemStatus | null => (kind === 'removed' ? null : card.status)
  if (events === null) {
    return [{ ...base, kind: change.kind, actor: null, text: NEUTRAL_TEXT, at: card.updatedAt, toStatus: statusOf(change.kind) }]
  }
  const fresh = events.filter((e) => since === null || e.at > since).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  if (fresh.length === 0) {
    // Sem evento: foi a ingestão do plano do agente (o cartão que sumiu teve a linha apagada).
    return [{ ...base, kind: change.kind, actor: 'agent', text: stepText(change.kind, statusOf(change.kind)), at: card.updatedAt, toStatus: statusOf(change.kind) }]
  }
  return fresh.map((e) => {
    const kind = EVENT_KIND[e.kind]
    const toStatus = kind === 'removed' ? null : (e.toStatus ?? (kind === 'moved' ? card.status : kind === 'new' || kind === 'restored' ? card.status : null))
    const note = e.note?.trim()
    return { ...base, kind, actor: e.actor, text: note || stepText(kind, toStatus), at: e.at, toStatus }
  })
}

/** Maior `at` de uma lista de eventos (o novo "último visto"); `fallback` sem eventos. */
export function lastEventAt(events: readonly BoardItemEvent[] | null, fallback: string | null): string | null {
  let best = fallback
  for (const e of events ?? []) if (best === null || e.at > best) best = e.at
  return best
}

/**
 * A fila de passos de mudança — o ponto de extensão da coreografia. O sync
 * empurra os passos (já na ordem real); quem anima drena. Hoje quem drena é o
 * deslize automático (o papel vai sozinho para o lugar novo).
 */
export class BoardStepQueue {
  private items: BoardStep[] = []
  /** Chamado a cada `push` com passos novos. */
  onPush: () => void = () => {}

  push(steps: readonly BoardStep[]): void {
    if (steps.length === 0) return
    this.items.push(...steps)
    this.onPush()
  }

  /** Tira e devolve todos os passos pendentes (na ordem). */
  drain(): BoardStep[] {
    const out = this.items
    this.items = []
    return out
  }

  get size(): number {
    return this.items.length
  }

  clear(): void {
    this.items = []
  }
}
