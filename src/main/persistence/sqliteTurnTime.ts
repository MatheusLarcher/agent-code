import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TurnTimeTotals } from '../../shared/ipc'
import type { TurnTimeInsert } from './types'

/**
 * Migration 18 — o tempo de execução de cada turno (`conversation_turn_time`): um
 * registro por `result` do SDK, para a soma da conversa sobreviver a reinícios.
 * Tabela nova com `IF NOT EXISTS`: atravessa o guarda de `write()` sem custo. No
 * PostgreSQL é a migração 18 de postgresMigrations.ts (mesmo nome de tabela).
 */
export const SQLITE_TURN_TIME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation_turn_time (
    id TEXT PRIMARY KEY,
    conv_id TEXT NOT NULL,
    turn_id TEXT,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversation_turn_time_conv ON conversation_turn_time(conv_id, created_at);
`

export function insertSqliteTurnTime(db: DatabaseSync, input: TurnTimeInsert): void {
  db.prepare(
    `INSERT INTO conversation_turn_time(id, conv_id, turn_id, duration_ms, created_at) VALUES(?, ?, ?, ?, ?)`
  ).run(randomUUID(), input.convId, input.turnId, Math.max(0, Math.round(input.durationMs)), new Date().toISOString())
}

export function sqliteTurnTimeTotals(db: DatabaseSync, convId: string): TurnTimeTotals {
  const sum = db
    .prepare(`SELECT COALESCE(SUM(duration_ms), 0) AS total, COUNT(*) AS turns FROM conversation_turn_time WHERE conv_id = ?`)
    .get(convId) as unknown as { total: number; turns: number }
  const last = db
    .prepare(`SELECT duration_ms FROM conversation_turn_time WHERE conv_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(convId) as unknown as { duration_ms: number } | undefined
  return { totalMs: Number(sum.total), turns: Number(sum.turns), lastMs: last ? Number(last.duration_ms) : null }
}
