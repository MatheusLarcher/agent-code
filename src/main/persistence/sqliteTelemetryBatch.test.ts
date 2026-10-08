// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SQLITE_TOKEN_USAGE_SCHEMA } from './sqliteSchema'
import { writeSqliteTelemetryBatch } from './sqliteTelemetryBatch'
import { SQLITE_TURN_TIME_SCHEMA } from './sqliteTurnTime'
import type { TelemetryBatch } from './telemetryBatch'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SQLITE_TOKEN_USAGE_SCHEMA)
  db.exec(SQLITE_TURN_TIME_SCHEMA)
  return db
}

const call = (id: string, seq: number, inputTokens: number) => ({
  id, convId: 'c1', turnId: 't1', nodeId: 't1', parentNodeId: null, subagentType: null, taskDescription: null, seq,
  model: 'claude-opus-5-5', inputTokens, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null,
  inputPreview: 'p', outputPreview: null, createdAt: `2026-10-08T12:00:0${seq}.000Z`
})

const total = (sumInput: number, callCount: number) => ({
  convId: 'c1', day: '2026-10-08', model: 'claude-opus-5-5', subagentType: '', sumInput, sumOutput: 2 * callCount,
  sumCacheRead: 0, sumCacheWrite: 0, sumCost: null, callCount
})

describe('writeSqliteTelemetryBatch', () => {
  it('grava chamadas, correções, totais somados e tempos de turno; o lote repetido não duplica a chamada', () => {
    const db = database()
    const batch: TelemetryBatch = {
      calls: [call('a', 1, 10), call('b', 2, 20)],
      updates: [],
      totals: [total(30, 2)],
      turnTimes: [{ id: 'tt1', convId: 'c1', turnId: 't1', durationMs: 999.6, createdAt: '2026-10-08T12:00:05.000Z' }]
    }
    writeSqliteTelemetryBatch(db, batch)
    writeSqliteTelemetryBatch(db, {
      calls: [call('a', 1, 10)], // reenvio depois de um commit ambíguo
      updates: [{ id: 'b', inputTokens: 25, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 0, costUsd: 0.5 }],
      totals: [total(5, 0)],
      turnTimes: []
    })
    const calls = db.prepare('SELECT id, input_tokens, cache_read_tokens, cost_usd FROM llm_calls ORDER BY id').all()
    expect(calls).toEqual([
      { id: 'a', input_tokens: 10, cache_read_tokens: 0, cost_usd: null },
      { id: 'b', input_tokens: 25, cache_read_tokens: 7, cost_usd: 0.5 }
    ])
    expect(db.prepare('SELECT sum_input, sum_output, call_count, sum_cost FROM llm_usage_totals').all()).toEqual([
      { sum_input: 35, sum_output: 4, call_count: 2, sum_cost: null }
    ])
    expect(db.prepare('SELECT id, duration_ms FROM conversation_turn_time').all()).toEqual([{ id: 'tt1', duration_ms: 1000 }])
  })
})
