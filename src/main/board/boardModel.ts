import { createHash } from 'node:crypto'
import { boardItemStatus } from '../../shared/ipc'
import type {
  BoardItem,
  BoardItemOrigin,
  BoardItemStatus,
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
    updatedAt: String(row.updated_at)
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
 *  cada faixa, a ordem que o próprio CLI numerou. */
export function compareBoardItems(a: BoardItem, b: BoardItem): number {
  const byStatus = STATUS_RANK[boardItemStatus(a)] - STATUS_RANK[boardItemStatus(b)]
  if (byStatus !== 0) return byStatus
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

export function assertPoCreate(input: BoardPoCreate): void {
  if (!input.conversationId?.trim()) throw new TypeError('conversationId é obrigatório.')
  if (!input.projectId?.trim()) throw new TypeError('projectId é obrigatório.')
  if (!input.title?.trim()) throw new TypeError('Cartão do PO precisa de título.')
  if (!input.reason?.trim()) throw new TypeError('Cartão criado pelo PO exige um motivo.')
  if (!isBoardStatus(input.status)) throw new TypeError(`Status inválido: ${String(input.status)}`)
}
