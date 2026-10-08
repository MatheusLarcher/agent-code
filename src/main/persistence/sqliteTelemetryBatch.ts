import type { DatabaseSync } from 'node:sqlite'
import type { TelemetryBatch } from './telemetryBatch'

/**
 * O lote de telemetria (telemetryBatch.ts) no SQLite: tudo dentro de UM `write()`
 * do repositório — no SQLite o caro de cada gravação é a cópia atômica do arquivo
 * inteiro (atomicDb.ts), e antes eram duas por chamada de LLM.
 */
export function writeSqliteTelemetryBatch(db: DatabaseSync, batch: TelemetryBatch): void {
  const insertCall = db.prepare(
    `INSERT INTO llm_calls(
       id, conv_id, turn_id, node_id, parent_node_id, subagent_type, task_description,
       seq, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, input_preview, output_preview, created_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )
  for (const call of batch.calls) {
    insertCall.run(
      call.id, call.convId, call.turnId, call.nodeId, call.parentNodeId, call.subagentType, call.taskDescription,
      call.seq, call.model, call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens,
      call.costUsd, call.inputPreview, call.outputPreview, call.createdAt
    )
  }
  const updateCall = db.prepare(
    `UPDATE llm_calls SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
     WHERE id = ?`
  )
  for (const patch of batch.updates) {
    updateCall.run(patch.inputTokens, patch.outputTokens, patch.cacheReadTokens, patch.cacheWriteTokens, patch.costUsd, patch.id)
  }
  const upsertTotal = db.prepare(
    `INSERT INTO llm_usage_totals(
       conv_id, day, model, subagent_type, sum_input, sum_output, sum_cache_read, sum_cache_write, sum_cost, call_count
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conv_id, day, model, subagent_type) DO UPDATE SET
       sum_input = sum_input + excluded.sum_input,
       sum_output = sum_output + excluded.sum_output,
       sum_cache_read = sum_cache_read + excluded.sum_cache_read,
       sum_cache_write = sum_cache_write + excluded.sum_cache_write,
       sum_cost = CASE
         WHEN excluded.sum_cost IS NULL THEN sum_cost
         ELSE COALESCE(sum_cost, 0) + excluded.sum_cost
       END,
       call_count = call_count + excluded.call_count`
  )
  for (const total of batch.totals) {
    upsertTotal.run(
      total.convId, total.day, total.model, total.subagentType, total.sumInput, total.sumOutput,
      total.sumCacheRead, total.sumCacheWrite, total.sumCost, total.callCount
    )
  }
  const insertTurn = db.prepare(
    `INSERT INTO conversation_turn_time(id, conv_id, turn_id, duration_ms, created_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )
  for (const turn of batch.turnTimes) {
    insertTurn.run(turn.id, turn.convId, turn.turnId, Math.max(0, Math.round(turn.durationMs)), turn.createdAt)
  }
}
