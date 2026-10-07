import { createHash, randomUUID } from 'node:crypto'
import { boardItemStatus, boardItemTurnEndKind, parseBoardTurnEndReason } from '../../shared/ipc'
import type { TaskItem } from '../../shared/ipc'
import type {
  BoardItem,
  BoardItemEvent,
  BoardItemEventActor,
  BoardItemEventKind,
  BoardItemOrigin,
  BoardItemStatus,
  BoardDismissBy,
  BoardPoCreate,
  BoardPoWrite,
  BoardSourceItem
} from '../persistence/types'

/**
 * Regras puras do quadro de tarefas — o que os dois repositórios (SQLite e
 * PostgreSQL) compartilham: colunas, mapeamento linha↔objeto, id estável e a
 * sobreposição das duas camadas.
 *
 * Nada aqui toca banco. O que é regra de verdade mora aqui justamente para não
 * existir em duas versões que divergem em silêncio, que foi a lição da
 * allowlist de download.
 */

export const BOARD_STATUSES: readonly BoardItemStatus[] = ['pending', 'in_progress', 'completed']

/** Ordem de exibição: o que está em andamento primeiro, concluído por último. */
const STATUS_RANK: Record<BoardItemStatus, number> = { in_progress: 0, pending: 1, completed: 2 }

export const BOARD_COLUMNS = `
  id, project_id, project_cwd, conversation_id, origin, source_id, source_title, source_status,
  active_form, seq, po_title, po_note, po_status, po_reason, po_at, dismissed_at,
  revision, created_at, updated_at
`

/**
 * As colunas lidas, com o vínculo da pendência (`parent_id`). Fora de
 * `BOARD_COLUMNS` de propósito: as escritas que listam aquelas colunas ficam
 * como estavam, e o PostgreSQL compartilhado só lê esta lista quando a coluna
 * existe — uma versão mais velha do app no outro PC nunca a conhece.
 */
export const BOARD_SELECT_WITH_PARENT = `${BOARD_COLUMNS.trimEnd()}, parent_id`

export interface BoardItemRow {
  id: string
  project_id: string
  project_cwd: string
  conversation_id: string
  origin: string
  source_id: string | null
  source_title: string
  source_status: string
  active_form: string | null
  seq: number
  po_title: string | null
  po_note: string | null
  po_status: string | null
  po_reason: string | null
  po_at: string | null
  dismissed_at: string | null
  revision: number
  created_at: string
  updated_at: string
  /** Só quando a leitura usou `BOARD_SELECT_WITH_PARENT`. */
  parent_id?: string | null
}

export function isBoardStatus(value: unknown): value is BoardItemStatus {
  return typeof value === 'string' && (BOARD_STATUSES as readonly string[]).includes(value)
}

function asStatus(value: unknown, fallback: BoardItemStatus = 'pending'): BoardItemStatus {
  return isBoardStatus(value) ? value : fallback
}

function asOrigin(value: unknown): BoardItemOrigin {
  return value === 'po' ? 'po' : 'agent'
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function boardItemFromRow(row: BoardItemRow): BoardItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectCwd: String(row.project_cwd),
    conversationId: String(row.conversation_id),
    origin: asOrigin(row.origin),
    sourceId: row.source_id === null ? null : String(row.source_id),
    sourceTitle: String(row.source_title ?? ''),
    sourceStatus: asStatus(row.source_status),
    activeForm: text(row.active_form),
    seq: Number(row.seq) || 0,
    poTitle: text(row.po_title),
    poNote: text(row.po_note),
    poStatus: isBoardStatus(row.po_status) ? row.po_status : null,
    poReason: text(row.po_reason),
    poAt: text(row.po_at),
    dismissedAt: text(row.dismissed_at),
    revision: Number(row.revision) || 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    // Só a pendência carrega o campo: o cartão comum continua com a forma de
    // sempre (sem `parentId`), como o lido de um banco sem a coluna.
    ...(text(row.parent_id ?? null) ? { parentId: text(row.parent_id ?? null) } : {})
  }
}

/**
 * Id determinístico por (conversa, tarefa do CLI).
 *
 * Determinístico e não aleatório porque a ingestão é um UPSERT de snapshot
 * repetido muitas vezes: com id aleatório, a segunda leitura do mesmo plano
 * criaria um segundo cartão idêntico. O hash mantém o id curto e sem depender
 * do formato do id do CLI (que hoje é "1", "2"… e pode mudar).
 */
export function boardItemId(conversationId: string, sourceId: string): string {
  // O separador (unit separator, 0x1F) nao pode aparecer em nenhum dos dois
  // operandos. Concatenando direto, ("ab","1") e ("a","b1") gerariam o MESMO
  // id, e o UPSERT de uma conversa sobrescreveria o cartao de outra: a colisao
  // acontece na chave primaria, antes de o indice unico (conversation_id,
  // source_id) ter chance de recusar.
  const digest = createHash('sha1').update(`${conversationId}\u001f${sourceId}`).digest('hex')
  return `bi-${digest.slice(0, 20)}`
}

/** Ordenação estável do quadro: em andamento, pendente, concluído; dentro de
 *  cada faixa, o mais recentemente modificado primeiro. */
export function compareBoardItems(a: BoardItem, b: BoardItem): number {
  const byStatus = STATUS_RANK[boardItemStatus(a)] - STATUS_RANK[boardItemStatus(b)]
  if (byStatus !== 0) return byStatus
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt)
  if (a.conversationId !== b.conversationId) return a.conversationId.localeCompare(b.conversationId)
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.id.localeCompare(b.id)
}

export function normalizeSourceItems(items: BoardSourceItem[]): BoardSourceItem[] {
  const seen = new Set<string>()
  const out: BoardSourceItem[] = []
  for (const item of items) {
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId.trim() : ''
    if (!sourceId || seen.has(sourceId)) continue
    seen.add(sourceId)
    out.push({
      sourceId,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      status: asStatus(item.status),
      activeForm: text(item.activeForm),
      seq: Number.isFinite(item.seq) ? Number(item.seq) : out.length
    })
  }
  return out
}

/**
 * Os cartões que o fim do turno precisa devolver para "a fazer".
 *
 * "Em andamento" só quer dizer alguma coisa enquanto existe trabalho
 * acontecendo. O snapshot do CLI não tem noção de "agora": o cartão que o
 * agente marcou ao começar e esqueceu de fechar fica em andamento para sempre,
 * e o quadro passa a mostrar um trabalho que ninguém está fazendo.
 *
 * Usa o status EFETIVO (`poStatus ?? sourceStatus`) de propósito — ler o
 * `source_status` cru desfaria, no mesmo instante, o "concluído" que o PO
 * acabou de gravar em cima de um cartão que o agente deixou em andamento. E é
 * isso que torna a reabertura idempotente: o cartão já reaberto tem
 * `poStatus = 'pending'` e não aparece de novo.
 */
export function boardItemsToReopen(items: BoardItem[]): BoardItem[] {
  return items.filter((item) => item.dismissedAt === null && boardItemStatus(item) === 'in_progress')
}

/**
 * A mesma seleção acima, descartando o cartão que o PO tocou DEPOIS do
 * instante em que este turno terminou (`cutoffMs`).
 *
 * A reabertura é assíncrona — espera a fila de escrita e o PO terminar de
 * analisar — e pode levar segundos: tempo suficiente para o usuário já ter
 * mandado a próxima mensagem e a rodada de ABERTURA do PO já ter promovido o
 * mesmo cartão de volta para "em andamento" antes desta releitura acontecer.
 * Sem o corte por tempo, a reabertura pegaria o quadro já promovido e o
 * derrubaria de novo para "a fazer" — desfazendo um trabalho que já
 * recomeçou de verdade. `poAt` é o carimbo de toda escrita do PO; um cartão
 * escrito depois do fim do turno tem uma decisão mais recente que a
 * reabertura, e prevalece.
 */
export function boardItemsToReopenBefore(items: BoardItem[], cutoffMs: number): BoardItem[] {
  return boardItemsToReopen(items).filter((item) => {
    // O PENDENTE do PO (justificativa do que faltou) é escrito SEMPRE depois do
    // fim do turno — o PO de fechamento roda no `result`. Pelo carimbo, o
    // cartão justificado escaparia da reabertura que ele mesmo explica. A
    // promoção posterior (abertura do PO, retomada, agente) troca o motivo, e aí
    // o corte por tempo volta a valer normalmente.
    if (parseBoardTurnEndReason(item.poReason)) return true
    if (!item.poAt) return true
    const poAtMs = Date.parse(item.poAt)
    return !Number.isFinite(poAtMs) || poAtMs <= cutoffMs
  })
}

/** A janela do fallback de `boardItemsToResume`: a reabertura grava os cartões
 *  de um mesmo fim de turno em sequência, um `applyPo` depois do outro. */
export const BOARD_RESUME_WINDOW_MS = 15_000

/**
 * Os cartões que a mensagem do usuário retoma: os que o fim do turno
 * IMEDIATAMENTE anterior devolveu para "a fazer" e que nada tocou depois
 * (`boardItemTurnEndKind` — motivo ainda é o do fim de turno, não dispensado).
 *
 * `reopened` são os ids que aquele fechamento rebaixou, quando o processo o
 * viu acontecer — é a resposta exata, sem relógio nenhum (o `poAt` vem do
 * relógio do banco e o fim do turno do relógio deste PC; comparar os dois
 * seria apostar na sincronia deles). Sem essa memória (app reiniciado, conversa
 * continuada noutro PC), o fallback é o último rebaixamento da conversa e os
 * que caíram na mesma janela curta — os órfãos de turnos mais antigos ficam.
 */
export function boardItemsToResume(items: readonly BoardItem[], reopened: ReadonlySet<string> | null): BoardItem[] {
  const demoted = items.filter((item) => boardItemTurnEndKind(item) !== null)
  if (reopened) return demoted.filter((item) => reopened.has(item.id))
  const stamped = demoted
    .map((item) => ({ item, at: Date.parse(item.poAt ?? '') }))
    .filter((entry) => Number.isFinite(entry.at))
  if (stamped.length === 0) return []
  const latest = Math.max(...stamped.map((entry) => entry.at))
  return stamped.filter((entry) => entry.at >= latest - BOARD_RESUME_WINDOW_MS).map((entry) => entry.item)
}

/** Sem mínimo: todo concluído velho expira, por poucos que sejam (o "só os 4
 *  últimos" da coluna é VISUAL, na tela — quem apaga é só o prazo). */
export const COMPLETED_EXPIRY_MIN_COUNT = 0
/** Idade (desde `updatedAt`, o mesmo carimbo do badge "há X" na tela) a partir
 *  da qual um concluído some: 2 dias. */
export const COMPLETED_EXPIRY_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

/**
 * Os cartões concluídos que devem sumir do quadro (via dismiss, reversível).
 *
 * Cada concluído é julgado pela PRÓPRIA idade: passou de 2 dias, sai. O limiar
 * (`minCount`) continua aceito, mas o padrão é 0 — o limite de 4 por coluna é
 * só da tela, porque o dedupe do PO e o casamento cartão↔etapa do acompanhamento
 * leem só os não dispensados (card "Limite de 4 é visual, quem apaga é o prazo").
 * `dismissedAt` já dispensado nunca é candidato de novo — expirar um cartão que
 * o usuário já escondeu não faz sentido nenhum.
 *
 * Usa o status EFETIVO (`boardItemStatus`), pelo mesmo motivo de sempre: um
 * concluído pelo PO sobre um `source_status` desatualizado ainda é concluído.
 */
export function boardItemsToExpire(
  items: readonly BoardItem[],
  now: number,
  opts: { minCount?: number; maxAgeMs?: number } = {}
): BoardItem[] {
  const minCount = opts.minCount ?? COMPLETED_EXPIRY_MIN_COUNT
  const maxAgeMs = opts.maxAgeMs ?? COMPLETED_EXPIRY_MAX_AGE_MS
  const completed = items.filter((item) => item.dismissedAt === null && boardItemStatus(item) === 'completed')
  if (completed.length <= minCount) return []
  return completed.filter((item) => {
    const updatedMs = Date.parse(item.updatedAt)
    return Number.isFinite(updatedMs) && now - updatedMs > maxAgeMs
  })
}

/** O estado atual de um cartão, na forma que a ingestão precisa comparar. */
export type BoardSyncCurrent = Pick<
  BoardItemRow,
  'project_id' | 'source_title' | 'source_status' | 'active_form' | 'seq' | 'po_status'
>

export interface BoardSyncPlan {
  /** Nada mudou no que o agente declarou: pular a escrita evita inflar `revision`. */
  unchanged: boolean
  /** Soltar `po_status`/`po_reason` — ver `planBoardSourceSync`. */
  clearPoStatus: boolean
}

/**
 * O que a ingestão do snapshot faz com um cartão que já existe.
 *
 * A camada `po_*` sobrevive à releitura do MESMO snapshot — é isso que impede
 * o agente de desfazer, sem aviso, a correção do PO. Mas preservá-la sempre
 * trava o cartão: depois que o PO grava um `po_status`, nada que o agente
 * declare volta a aparecer no quadro, e um cartão reaberto continuaria "a
 * fazer" com o agente trabalhando nele de novo.
 *
 * A regra do meio-termo tem duas metades, e as duas tratam a mesma pergunta:
 * quem falou por último sobre o estado?
 *
 * 1. O `source_status` MUDOU de valor: foi o agente. A correção do PO cai.
 * 2. O cartão está "a fazer" por correção e o agente declara trabalho EM
 *    ANDAMENTO. Aqui o `source_status` pode nem ter mudado — o cartão que a
 *    reabertura devolveu para "a fazer" continua `in_progress` na lista do
 *    CLI, e o agente que retoma o trabalho reemite exatamente esse valor. A
 *    reabertura é uma afirmação sobre um MOMENTO ("no fim daquele turno
 *    ninguém estava trabalhando nisto") e ela expira assim que alguém volta a
 *    trabalhar; sem esta metade, o cartão ficaria travado em "a fazer" com o
 *    agente mexendo nele, que é o oposto do que a reabertura quer.
 *
 * Um "concluído" do PO NÃO cai por releitura: aquilo é afirmação sobre o
 * TRABALHO, e snapshot velho reemitido não o refuta — só o agente mudando o
 * status. E `po_title`/`po_note` ficam nos dois casos, porque título legível
 * não é estado e não envelhece quando o trabalho anda.
 *
 * Mora aqui, e não no SQL de cada repositório, porque SQLite e PostgreSQL
 * precisam decidir a MESMA coisa: em duas versões, o quadro cross-device
 * divergiria conforme o PC — e nenhum teste quebraria, porque cada cópia teria
 * a sua.
 */
export function planBoardSourceSync(
  current: BoardSyncCurrent,
  incoming: BoardSourceItem,
  projectId: string
): BoardSyncPlan {
  const statusChanged = current.source_status !== incoming.status
  const reopenExpired = current.po_status === 'pending' && incoming.status === 'in_progress'
  const clearPoStatus = current.po_status !== null && (statusChanged || reopenExpired)
  const sourceSame =
    !statusChanged &&
    current.source_title === incoming.title &&
    (current.active_form ?? null) === incoming.activeForm &&
    Number(current.seq) === incoming.seq &&
    current.project_id === projectId
  // Soltar o `po_status` É uma mudança no cartão: sem isto, a escrita seria
  // pulada justamente no caso em que só a camada do PO muda.
  return { unchanged: sourceSame && !clearPoStatus, clearPoStatus }
}

export function assertPoWrite(input: BoardPoWrite): void {
  if (!input.id?.trim()) throw new TypeError('id do cartão é obrigatório.')
  if (input.poStatus !== undefined && input.poStatus !== null && !isBoardStatus(input.poStatus)) {
    throw new TypeError(`Status inválido para o PO: ${String(input.poStatus)}`)
  }
  // Correção sem motivo é exatamente o que torna o quadro impossível de
  // auditar quando o PO erra — e ele vai errar alguma hora.
  if (input.poStatus !== undefined && input.poStatus !== null && !input.poReason?.trim()) {
    throw new TypeError('Mudança de status pelo PO exige um motivo.')
  }
}

/** Dispensar/restaurar pelo clique é ato do USUÁRIO: a linha do tempo diz
 *  "Você", não "Sistema" nem "PO" — atribuir a outro esconderia quem decidiu.
 *  A expiração automática, essa sim, é regra do app (`system`). */
export const DISMISS_BY_USER: Record<'dismiss' | 'restore', BoardDismissBy> = {
  dismiss: { actor: 'user', note: 'você dispensou o cartão' },
  restore: { actor: 'user', note: 'você restaurou o cartão' }
}
export const EXPIRE_BY: BoardDismissBy = { actor: 'system', note: 'concluído há mais de 5 dias' }

/** O que mudou numa escrita do PO, já resolvido por quem leu o banco (cada
 *  repositório compara no próprio formato — o PostgreSQL guarda texto escapado). */
export interface PoWriteChange {
  priorStatus: BoardItemStatus
  nextStatus: BoardItemStatus | null
  /** O status efetivo DEPOIS da escrita. */
  effectiveStatus: BoardItemStatus
  titleChanged: boolean
  noteChanged: boolean
  reasonChanged: boolean
  /** Valores planos (não escapados). */
  nextTitle: string | null
  nextNote: string | null
  nextReason: string | null
}

export interface PoWriteEvent {
  kind: BoardItemEventKind
  fromStatus?: BoardItemStatus | null
  toStatus?: BoardItemStatus | null
  note: string | null
}

/**
 * O evento que uma escrita do PO registra — UM fato por escrita. Status ganha
 * prioridade (é o que a reabertura e a auditoria mais precisam enxergar), depois
 * título, observação e, por último, o motivo sozinho: o PENDENTE do PO grava só
 * o motivo, e antes isso sobrescrevia `po_reason` sem deixar rastro nenhum.
 * Mora aqui pelo mesmo motivo do resto: SQLite e PostgreSQL decidem igual.
 */
export function planPoWriteEvent(input: BoardPoWrite, change: PoWriteChange): PoWriteEvent | null {
  if (input.poStatus !== undefined && change.nextStatus !== change.priorStatus) {
    return {
      kind: 'status_changed',
      fromStatus: change.priorStatus,
      toStatus: change.nextStatus,
      note: input.eventNote ?? change.nextReason
    }
  }
  if (input.poTitle !== undefined && change.titleChanged) {
    const why = (input.eventNote ?? (input.poReason !== undefined ? input.poReason : null))?.trim()
    // Sem motivo, a nota continua sendo só o título (o formato de antes).
    const note = why ? `título → "${change.nextTitle ?? ''}": ${why}` : change.nextTitle
    return { kind: 'retitled', note }
  }
  if (input.poNote !== undefined && change.noteChanged) return { kind: 'note_changed', note: change.nextNote }
  if (input.poReason !== undefined && change.reasonChanged && change.nextReason) {
    return {
      kind: 'justified',
      fromStatus: change.effectiveStatus,
      toStatus: change.effectiveStatus,
      note: input.eventNote ?? change.nextReason
    }
  }
  return null
}

export function assertPoCreate(input: BoardPoCreate): void {
  if (!input.conversationId?.trim()) throw new TypeError('conversationId é obrigatório.')
  if (!input.projectId?.trim()) throw new TypeError('projectId é obrigatório.')
  if (!input.title?.trim()) throw new TypeError('Cartão do PO precisa de título.')
  if (!input.reason?.trim()) throw new TypeError('Cartão criado pelo PO exige um motivo.')
  if (!isBoardStatus(input.status)) throw new TypeError(`Status inválido: ${String(input.status)}`)
}

// ---------------------------------------------------------------------------
// Histórico do cartão (board_item_events) — a linha do tempo que `po_reason`
// sozinho não guarda, porque ele só tem o ÚLTIMO motivo.
// ---------------------------------------------------------------------------

export const BOARD_EVENT_COLUMNS = `id, board_item_id, at, kind, actor, from_status, to_status, note`

export interface BoardItemEventRow {
  id: string
  board_item_id: string
  at: string
  kind: string
  actor: string
  from_status: string | null
  to_status: string | null
  note: string | null
}

export function boardItemEventFromRow(row: BoardItemEventRow): BoardItemEvent {
  return {
    id: String(row.id),
    boardItemId: String(row.board_item_id),
    at: String(row.at),
    kind: row.kind as BoardItemEventKind,
    actor: row.actor as BoardItemEventActor,
    fromStatus: isBoardStatus(row.from_status) ? row.from_status : null,
    toStatus: isBoardStatus(row.to_status) ? row.to_status : null,
    note: text(row.note)
  }
}

/** Um evento novo, pronto para `INSERT` — id gerado aqui para não duplicar a
 *  regra nos dois repositórios. */
export function newBoardItemEvent(input: {
  boardItemId: string
  at: string
  kind: BoardItemEventKind
  actor: BoardItemEventActor
  fromStatus?: BoardItemStatus | null
  toStatus?: BoardItemStatus | null
  note?: string | null
}): BoardItemEvent {
  return {
    id: `bie-${randomUUID().slice(0, 20)}`,
    boardItemId: input.boardItemId,
    at: input.at,
    kind: input.kind,
    actor: input.actor,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    note: input.note ?? null
  }
}

/** `TaskItem` (o que a sessão publica) → a forma que o quadro grava. */
export function toSourceItems(items: TaskItem[]): BoardSourceItem[] {
  return items.map((item, index) => ({
    sourceId: String(item.id ?? index),
    title: typeof item.content === 'string' ? item.content : '',
    status: item.status,
    activeForm: typeof item.activeForm === 'string' && item.activeForm.trim() ? item.activeForm : null,
    seq: index
  }))
}
