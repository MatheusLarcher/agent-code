import type { DatabaseSync } from 'node:sqlite'
import type { ContextTurnDetail, ContextTurnSummary } from '../../shared/contextSnapshot'
import {
  assertContextIds,
  clampContextLimit,
  contextTurnDetail,
  contextTurnHashes,
  contextTurnSummary,
  inflateContextBlob,
  prepareContextTurn,
  type ContextTurnRecord
} from './contextHistoryCodec'
import type { ContextTurnWrite } from './types'

/**
 * Histórico do contexto no SQLite (migrations 13 e 14). As funções recebem o `db` já
 * aberto pelo `SqliteRepository` (`read`/`write`), que só delega para cá: cada
 * `write()` é uma cópia atômica do arquivo, então tudo que roda dentro de uma
 * chamada entra junto ou não entra.
 */

interface ContextTurnRow {
  conv_id: string
  turn_id: string
  pc: string
  started_at: number | bigint
  model: string
  provider: string
  request: string
  complete: number | bigint
  usage_json: string | null
  blocks_json: string
  memories_json: string
  secrets_json: string
  models_json: string | null
}

const TURN_COLUMNS = `conv_id, turn_id, pc, started_at, model, provider, request, complete, usage_json,
  blocks_json, memories_json, secrets_json, models_json`

function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function record(row: ContextTurnRow): ContextTurnRecord {
  return {
    convId: row.conv_id,
    turnId: row.turn_id,
    pc: row.pc,
    startedAt: Number(row.started_at),
    model: row.model,
    provider: row.provider,
    request: row.request,
    complete: Number(row.complete) === 1,
    usage: parseJson(row.usage_json),
    blocks: parseJson(row.blocks_json),
    memories: parseJson(row.memories_json),
    secrets: parseJson(row.secrets_json),
    models: parseJson(row.models_json)
  }
}

export function saveSqliteContextTurn(db: DatabaseSync, write: ContextTurnWrite): void {
  const prepared = prepareContextTurn(write)
  db.exec('BEGIN IMMEDIATE')
  try {
    // `write()` é síncrono e troca o arquivo atomicamente: checar a tombstone
    // aqui impede um snapshot best-effort atrasado de ressuscitar o contexto.
    const conversation = db.prepare('SELECT deleted_at FROM conversations_v2 WHERE id = ?')
      .get(write.convId) as { deleted_at: string | null } | undefined
    if (conversation?.deleted_at) {
      db.exec('COMMIT')
      return
    }
    const insertBlob = db.prepare(
      'INSERT INTO context_blob(hash, gz, bytes) VALUES(?, ?, ?) ON CONFLICT(hash) DO NOTHING'
    )
    for (const blob of prepared.blobs) insertBlob.run(blob.hash, blob.gz, blob.bytes)
    db.prepare(
      `INSERT INTO context_turn(${TURN_COLUMNS}, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_id, turn_id) DO UPDATE SET
         pc = excluded.pc,
         started_at = excluded.started_at,
         model = excluded.model,
         provider = excluded.provider,
         request = excluded.request,
         complete = excluded.complete,
         usage_json = excluded.usage_json,
         blocks_json = excluded.blocks_json,
         memories_json = excluded.memories_json,
         secrets_json = excluded.secrets_json,
         models_json = excluded.models_json,
         updated_at = excluded.updated_at`
    ).run(
      write.convId,
      write.turnId,
      write.pc,
      Math.trunc(write.startedAt),
      write.model,
      write.provider,
      write.request,
      write.complete ? 1 : 0,
      prepared.usageJson,
      prepared.blocksJson,
      prepared.memoriesJson,
      prepared.secretsJson,
      prepared.modelsJson,
      new Date().toISOString()
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function listSqliteContextTurns(db: DatabaseSync, convId: string, limit: number): ContextTurnSummary[] {
  assertContextIds(convId)
  const rows = db
    .prepare(
      `SELECT ${TURN_COLUMNS} FROM context_turn WHERE conv_id = ?
       ORDER BY started_at DESC, turn_id DESC LIMIT ?`
    )
    .all(convId, clampContextLimit(limit)) as unknown as ContextTurnRow[]
  return rows.map((row) => contextTurnSummary(record(row)))
}

export function readSqliteContextTurn(db: DatabaseSync, convId: string, turnId: string): ContextTurnDetail | null {
  assertContextIds(convId, turnId)
  const row = db
    .prepare(`SELECT ${TURN_COLUMNS} FROM context_turn WHERE conv_id = ? AND turn_id = ?`)
    .get(convId, turnId) as unknown as ContextTurnRow | undefined
  if (!row) return null
  const turn = record(row)
  const hashes = contextTurnHashes(turn)
  const texts = new Map<string, string>()
  if (hashes.length) {
    const blobs = db
      .prepare(`SELECT hash, gz FROM context_blob WHERE hash IN (${hashes.map(() => '?').join(', ')})`)
      .all(...hashes) as unknown as Array<{ hash: string; gz: Uint8Array }>
    for (const blob of blobs) texts.set(blob.hash, inflateContextBlob(blob.gz))
  }
  return contextTurnDetail(turn, texts)
}

/** Usado também por `deleteConversation`, dentro da mesma escrita. */
export function deleteSqliteContextTurns(db: DatabaseSync, convId: string): number {
  assertContextIds(convId)
  return Number(db.prepare('DELETE FROM context_turn WHERE conv_id = ?').run(convId).changes)
}

/** Hashes referenciados por algum turno. `IS NOT NULL` importa: um único `NULL`
 *  dentro de um `NOT IN` faria a condição dar `NULL` para todas as linhas e a
 *  poda nunca apagaria nada. */
const ORPHAN_WHERE = `hash NOT IN (
  SELECT json_extract(block.value, '$.hash')
  FROM context_turn AS turn, json_each(turn.blocks_json) AS block
  WHERE json_extract(block.value, '$.hash') IS NOT NULL
)`

/** Barato e só leitura: a poda só abre uma escrita (cópia do arquivo inteiro)
 *  quando há o que apagar. */
export function countSqliteOrphanContextBlobs(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM context_blob WHERE ${ORPHAN_WHERE}`).get() as {
    total: number | bigint
  }
  return Number(row.total)
}

export function pruneSqliteOrphanContextBlobs(db: DatabaseSync): number {
  return Number(db.prepare(`DELETE FROM context_blob WHERE ${ORPHAN_WHERE}`).run().changes)
}
