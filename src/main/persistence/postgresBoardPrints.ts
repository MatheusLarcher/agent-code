import type { Pool } from 'pg'
import { decodePostgresText, encodePostgresText } from './postgresEncoding'
import type { BoardItemPrintQuery, BoardItemPrintRecord, BoardItemPrintWrite } from './boardPrintTypes'

/**
 * Os prints dos cartões no PostgreSQL COMPARTILHADO: a tabela
 * `board_item_prints`, SEM migração numerada — pelo mesmo motivo do
 * `parent_id` (postgresBoardParent.ts): uma migração 18 faria a versão mais
 * velha do app, no outro PC, recusar o banco inteiro (`SCHEMA_TOO_NEW`). A
 * tabela é nova e ninguém mais a lê, então a versão velha segue igual. Aqui
 * ela é garantida na abertura (com teto de espera pelo lock) e o repositório
 * só a usa quando existe — sem ela, o print é recusado com motivo.
 */

const LOCK_TIMEOUT_MS = 5_000

const CREATE = `
  CREATE TABLE IF NOT EXISTS board_item_prints (
    id text PRIMARY KEY,
    board_item_id text NOT NULL,
    project_id text NOT NULL,
    conversation_id text NOT NULL,
    mime text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    bytes integer NOT NULL,
    legenda text,
    data bytea NOT NULL,
    thumb bytea NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_item_prints_item ON board_item_prints(board_item_id, created_at);
  CREATE INDEX IF NOT EXISTS board_item_prints_project ON board_item_prints(project_id, created_at);
`

const HAS_TABLE = `
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_name = 'board_item_prints'
`

async function hasTable(pool: Pool): Promise<boolean> {
  const result = await pool.query(HAS_TABLE)
  return (result.rowCount ?? 0) > 0
}

/** `true` quando a tabela existe (já existia ou acabou de ser criada). Nunca lança. */
export async function ensurePostgresBoardPrints(pool: Pool): Promise<boolean> {
  try {
    if (await hasTable(pool)) return true
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`)
      await client.query(CREATE)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return await hasTable(pool)
  } catch (error) {
    console.warn(`[quadro] prints dos cartões indisponíveis no PostgreSQL: ${(error as Error)?.message ?? error}`)
    return false
  }
}

const META = 'id, board_item_id, project_id, conversation_id, mime, width, height, bytes, legenda, created_at, thumb'

type Row = Record<string, unknown>

function bytesOf(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0)
}

function fromRow(row: Row): BoardItemPrintRecord {
  const at = row.created_at
  return {
    id: String(row.id),
    boardItemId: String(row.board_item_id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    mime: String(row.mime),
    width: Number(row.width),
    height: Number(row.height),
    bytes: Number(row.bytes),
    legenda: row.legenda === null || row.legenda === undefined ? null : decodePostgresText(String(row.legenda)),
    createdAt: (at instanceof Date ? at : new Date(String(at))).toISOString(),
    thumb: bytesOf(row.thumb)
  }
}

export async function addPostgresBoardItemPrint(pool: Pool, print: BoardItemPrintWrite, keep: number): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO board_item_prints (id, board_item_id, project_id, conversation_id, mime, width, height, bytes, legenda, data, thumb, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        print.id, print.boardItemId, print.projectId, print.conversationId, print.mime, print.width, print.height,
        print.data.length, print.legenda === null ? null : encodePostgresText(print.legenda),
        Buffer.from(print.data), Buffer.from(print.thumb), print.createdAt
      ]
    )
    // Fica com os `keep` mais novos do cartão.
    await client.query(
      `DELETE FROM board_item_prints WHERE board_item_id = $1 AND id NOT IN (
         SELECT id FROM board_item_prints WHERE board_item_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
      [print.boardItemId, Math.max(0, keep)]
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function listPostgresBoardItemPrints(pool: Pool, query: BoardItemPrintQuery): Promise<BoardItemPrintRecord[]> {
  const clauses: string[] = []
  const params: unknown[] = []
  if (query.projectId) {
    params.push(query.projectId)
    clauses.push(`project_id = $${params.length}`)
  }
  if (query.boardItemId) {
    params.push(query.boardItemId)
    clauses.push(`board_item_id = $${params.length}`)
  }
  if (clauses.length === 0) return []
  const result = await pool.query(`SELECT ${META} FROM board_item_prints WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`, params)
  return (result.rows as Row[]).map(fromRow)
}

export async function getPostgresBoardItemPrint(pool: Pool, id: string): Promise<(BoardItemPrintRecord & { data: Uint8Array }) | null> {
  const result = await pool.query(`SELECT ${META}, data FROM board_item_prints WHERE id = $1`, [id])
  const row = result.rows[0] as Row | undefined
  return row ? { ...fromRow(row), data: bytesOf(row.data) } : null
}

/** A faxina dos 30 dias (ver BoardPrintRepository.pruneBoardItemPrints). */
export async function prunePostgresBoardItemPrints(pool: Pool, cutoffIso: string): Promise<number> {
  const result = await pool.query(
    `DELETE FROM board_item_prints WHERE id IN (
       SELECT p.id FROM board_item_prints p
       LEFT JOIN board_items b ON b.id = p.board_item_id
       WHERE p.created_at < $1::timestamptz
         AND (b.id IS NULL OR (COALESCE(b.po_status, b.source_status) = 'completed' AND b.updated_at < $1::timestamptz)))`,
    [cutoffIso]
  )
  return result.rowCount ?? 0
}
