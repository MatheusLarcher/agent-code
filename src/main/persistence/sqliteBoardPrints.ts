import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { BoardItemPrintQuery, BoardItemPrintRecord, BoardItemPrintWrite } from './boardPrintTypes'

/**
 * Migration 17 — os prints dos cartões (`board_item_prints`) no SQLite. Tabela
 * nova com `IF NOT EXISTS`: atravessa o guarda de `write()` sem custo. No
 * PostgreSQL a mesma tabela NÃO é migração numerada — ver postgresBoardPrints.ts.
 */
export const SQLITE_BOARD_PRINTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_item_prints (
    id TEXT PRIMARY KEY,
    board_item_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    legenda TEXT,
    data BLOB NOT NULL,
    thumb BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_item_prints_item ON board_item_prints(board_item_id, created_at);
  CREATE INDEX IF NOT EXISTS board_item_prints_project ON board_item_prints(project_id, created_at);
`

const META = 'id, board_item_id, project_id, conversation_id, mime, width, height, bytes, legenda, created_at, thumb'

type Row = Record<string, SQLInputValue>

function bytesOf(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0)
}

function fromRow(row: Row): BoardItemPrintRecord {
  return {
    id: String(row.id),
    boardItemId: String(row.board_item_id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    mime: String(row.mime),
    width: Number(row.width),
    height: Number(row.height),
    bytes: Number(row.bytes),
    legenda: row.legenda === null || row.legenda === undefined ? null : String(row.legenda),
    createdAt: String(row.created_at),
    thumb: bytesOf(row.thumb)
  }
}

export function addSqliteBoardItemPrint(db: DatabaseSync, print: BoardItemPrintWrite, keep: number): void {
  db.prepare(
    `INSERT INTO board_item_prints (id, board_item_id, project_id, conversation_id, mime, width, height, bytes, legenda, data, thumb, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    print.id, print.boardItemId, print.projectId, print.conversationId, print.mime, print.width, print.height,
    print.data.length, print.legenda, print.data, print.thumb, print.createdAt
  )
  // Fica com os `keep` mais novos do cartão.
  db.prepare(
    `DELETE FROM board_item_prints WHERE board_item_id = ? AND id NOT IN (
       SELECT id FROM board_item_prints WHERE board_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`
  ).run(print.boardItemId, print.boardItemId, Math.max(0, keep))
}

export function listSqliteBoardItemPrints(db: DatabaseSync, query: BoardItemPrintQuery): BoardItemPrintRecord[] {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  if (query.projectId) {
    clauses.push('project_id = ?')
    params.push(query.projectId)
  }
  if (query.boardItemId) {
    clauses.push('board_item_id = ?')
    params.push(query.boardItemId)
  }
  if (clauses.length === 0) return []
  const rows = db
    .prepare(`SELECT ${META} FROM board_item_prints WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`)
    .all(...params) as Row[]
  return rows.map(fromRow)
}

export function getSqliteBoardItemPrint(db: DatabaseSync, id: string): (BoardItemPrintRecord & { data: Uint8Array }) | null {
  const row = db.prepare(`SELECT ${META}, data FROM board_item_prints WHERE id = ?`).get(id) as Row | undefined
  return row ? { ...fromRow(row), data: bytesOf(row.data) } : null
}

/** Os prints vencidos (ver BoardPrintRepository.pruneBoardItemPrints). */
const EXPIRED = `
  SELECT p.id FROM board_item_prints p
  LEFT JOIN board_items b ON b.id = p.board_item_id
  WHERE p.created_at < ?
    AND (b.id IS NULL OR (COALESCE(b.po_status, b.source_status) = 'completed' AND b.updated_at < ?))
`

export function countSqliteExpiredBoardItemPrints(db: DatabaseSync, cutoffIso: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${EXPIRED})`).get(cutoffIso, cutoffIso) as Row | undefined
  return Number(row?.n ?? 0)
}

export function pruneSqliteBoardItemPrints(db: DatabaseSync, cutoffIso: string): number {
  const result = db.prepare(`DELETE FROM board_item_prints WHERE id IN (${EXPIRED})`).run(cutoffIso, cutoffIso)
  return Number(result.changes ?? 0)
}
