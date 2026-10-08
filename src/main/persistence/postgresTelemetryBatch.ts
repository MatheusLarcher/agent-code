import type { Pool, PoolClient } from 'pg'
import { encodePostgresText } from './postgresEncoding'
import { rollbackOrDiscard } from './postgresTimeouts'
import type { TelemetryBatch } from './telemetryBatch'

/** Linhas por comando: 17 colunas × 500 fica bem abaixo do limite de 65 535 parâmetros. */
const ROWS_PER_STATEMENT = 500

function chunks<T>(items: T[], size = ROWS_PER_STATEMENT): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** `($1, $2, …), ($n+1, …)` para `rows` linhas de `columns` colunas. */
function placeholders(rows: number, columns: number, casts: string[] = []): string {
  const out: string[] = []
  for (let r = 0; r < rows; r += 1) {
    const cells: string[] = []
    for (let c = 0; c < columns; c += 1) cells.push(`$${r * columns + c + 1}${casts[c] ?? ''}`)
    out.push(`(${cells.join(', ')})`)
  }
  return out.join(', ')
}

const text = (value: string | null): string | null => (value ? encodePostgresText(value) : null)

async function insertCalls(client: PoolClient, batch: TelemetryBatch): Promise<void> {
  for (const rows of chunks(batch.calls)) {
    const values = rows.flatMap((call) => [
      call.id, call.convId, call.turnId, call.nodeId, call.parentNodeId, call.subagentType, text(call.taskDescription),
      call.seq, call.model, call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens,
      call.costUsd, text(call.inputPreview), text(call.outputPreview), call.createdAt
    ])
    // ON CONFLICT: um lote repetido depois de um commit ambíguo não duplica a chamada.
    await client.query(
      `INSERT INTO llm_calls(
         id, conv_id, turn_id, node_id, parent_node_id, subagent_type, task_description,
         seq, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, input_preview, output_preview, created_at
       ) VALUES ${placeholders(rows.length, 17)}
       ON CONFLICT(id) DO NOTHING`,
      values
    )
  }
}

async function updateCalls(client: PoolClient, batch: TelemetryBatch): Promise<void> {
  for (const rows of chunks(batch.updates)) {
    const values = rows.flatMap((patch) => [
      patch.id, patch.inputTokens, patch.outputTokens, patch.cacheReadTokens, patch.cacheWriteTokens, patch.costUsd
    ])
    await client.query(
      `UPDATE llm_calls SET
         input_tokens = u.input_tokens, output_tokens = u.output_tokens,
         cache_read_tokens = u.cache_read_tokens, cache_write_tokens = u.cache_write_tokens,
         cost_usd = u.cost_usd
       FROM (VALUES ${placeholders(rows.length, 6, ['::text', '::bigint', '::bigint', '::bigint', '::bigint', '::double precision'])})
         AS u(id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       WHERE llm_calls.id = u.id`,
      values
    )
  }
}

async function upsertTotals(client: PoolClient, batch: TelemetryBatch): Promise<void> {
  for (const rows of chunks(batch.totals)) {
    const values = rows.flatMap((total) => [
      total.convId, total.day, total.model, total.subagentType, total.sumInput, total.sumOutput,
      total.sumCacheRead, total.sumCacheWrite, total.sumCost, total.callCount
    ])
    await client.query(
      `INSERT INTO llm_usage_totals(
         conv_id, day, model, subagent_type, sum_input, sum_output, sum_cache_read, sum_cache_write, sum_cost, call_count
       ) VALUES ${placeholders(rows.length, 10, ['', '', '', '', '::bigint', '::bigint', '::bigint', '::bigint', '::double precision', '::bigint'])}
       ON CONFLICT(conv_id, day, model, subagent_type) DO UPDATE SET
         sum_input = llm_usage_totals.sum_input + EXCLUDED.sum_input,
         sum_output = llm_usage_totals.sum_output + EXCLUDED.sum_output,
         sum_cache_read = llm_usage_totals.sum_cache_read + EXCLUDED.sum_cache_read,
         sum_cache_write = llm_usage_totals.sum_cache_write + EXCLUDED.sum_cache_write,
         sum_cost = CASE
           WHEN EXCLUDED.sum_cost IS NULL THEN llm_usage_totals.sum_cost
           ELSE COALESCE(llm_usage_totals.sum_cost, 0) + EXCLUDED.sum_cost
         END,
         call_count = llm_usage_totals.call_count + EXCLUDED.call_count`,
      values
    )
  }
}

async function insertTurnTimes(client: PoolClient, batch: TelemetryBatch): Promise<void> {
  for (const rows of chunks(batch.turnTimes)) {
    const values = rows.flatMap((turn) => [turn.id, turn.convId, turn.turnId, Math.max(0, Math.round(turn.durationMs)), turn.createdAt])
    await client.query(
      `INSERT INTO conversation_turn_time(id, conv_id, turn_id, duration_ms, created_at)
       VALUES ${placeholders(rows.length, 5)} ON CONFLICT(id) DO NOTHING`,
      values
    )
  }
}

/** O lote inteiro numa transação: chamadas novas, correções, totais somados e tempos de turno. */
export async function writePostgresTelemetryBatch(pool: Pool, batch: TelemetryBatch): Promise<void> {
  const client = await pool.connect()
  let discard: Error | undefined
  try {
    await client.query('BEGIN')
    await insertCalls(client, batch)
    await updateCalls(client, batch)
    await upsertTotals(client, batch)
    await insertTurnTimes(client, batch)
    await client.query('COMMIT')
  } catch (error) {
    discard = await rollbackOrDiscard(client, error)
    throw error
  } finally {
    client.release(discard)
  }
}
