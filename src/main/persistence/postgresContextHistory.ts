import type { Pool, PoolClient } from 'pg'
import type { ContextTurnDetail, ContextTurnSummary } from '../../shared/contextSnapshot'
import { pruneInBatches } from './changeLogPruner'
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
import type { JsonValue } from './hashes'
import { decodePostgresJson, decodePostgresText, encodePostgresJsonParam, encodePostgresText } from './postgresEncoding'
import { rollbackOrDiscard } from './postgresTimeouts'
import type { ContextTurnWrite } from './types'

/**
 * Histórico do contexto no PostgreSQL (migrations 15 e 16). O `PostgresRepository`
 * só delega para cá.
 *
 * Corrida entre gravar e podar: `saveContextTurn` insere o blob com `ON
 * CONFLICT DO NOTHING`, então um blob que JÁ existia como órfão continua órfão
 * para qualquer outra transação até o turno que o referencia ser commitado. Sem
 * coordenação, a poda poderia apagá-lo nesse intervalo e o turno nasceria
 * apontando para um texto que não existe mais. Por isso a gravação segura este
 * advisory lock em modo compartilhado (gravações não se bloqueiam entre si) e a
 * poda em modo exclusivo: ela espera as gravações em andamento terminarem e o
 * DELETE seguinte já enxerga os turnos commitados.
 */
const CONTEXT_BLOB_LOCK_KEY = 7_420_261_003

interface ContextTurnRow {
  conv_id: string
  turn_id: string
  pc: string
  started_at: string | number
  model: string
  provider: string
  request: string
  complete: boolean
  usage_json: JsonValue | null
  blocks_json: JsonValue
  memories_json: JsonValue
  secrets_json: JsonValue
  models_json: JsonValue | null
}

const TURN_COLUMNS = `conv_id, turn_id, pc, started_at, model, provider, request, complete, usage_json,
  blocks_json, memories_json, secrets_json, models_json`

function decodeJson(value: JsonValue | null): unknown {
  return value === null ? null : decodePostgresJson(value)
}

function record(row: ContextTurnRow): ContextTurnRecord {
  return {
    convId: row.conv_id,
    turnId: row.turn_id,
    pc: decodePostgresText(row.pc),
    startedAt: Number(row.started_at),
    model: decodePostgresText(row.model),
    provider: row.provider,
    request: decodePostgresText(row.request),
    complete: row.complete === true,
    usage: decodeJson(row.usage_json),
    blocks: decodeJson(row.blocks_json),
    memories: decodeJson(row.memories_json),
    secrets: decodeJson(row.secrets_json),
    models: decodeJson(row.models_json)
  }
}

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await pool.connect()
  let discard: Error | undefined
  try {
    await client.query(begin)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    discard = await rollbackOrDiscard(client, error)
    throw error
  } finally {
    client.release(discard)
  }
}

function jsonParam(raw: string | null): string | null {
  return raw === null ? null : encodePostgresJsonParam(JSON.parse(raw) as JsonValue)
}

export async function savePostgresContextTurn(pool: Pool, write: ContextTurnWrite): Promise<void> {
  const prepared = prepareContextTurn(write)
  await transaction(pool, async (client) => {
    // A captura best-effort pode terminar depois do delete. O mesmo lock de
    // linha usado por deleteConversation serializa as duas operações: se o
    // delete ganhou, não ressuscita o contexto; se o save ganhou, o delete
    // seguinte remove o turno. Conversa inexistente é permitida.
    const conversation = await client.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM conversations WHERE conversation_id = $1 FOR UPDATE',
      [write.convId]
    )
    if (conversation.rows[0]?.deleted_at) return
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [CONTEXT_BLOB_LOCK_KEY])
    for (const blob of prepared.blobs) {
      await client.query(
        'INSERT INTO context_blob(hash, gz, bytes) VALUES($1, $2, $3) ON CONFLICT(hash) DO NOTHING',
        [blob.hash, blob.gz, blob.bytes]
      )
    }
    await client.query(
      `INSERT INTO context_turn(${TURN_COLUMNS}, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, clock_timestamp())
       ON CONFLICT(conv_id, turn_id) DO UPDATE SET
         pc = EXCLUDED.pc,
         started_at = EXCLUDED.started_at,
         model = EXCLUDED.model,
         provider = EXCLUDED.provider,
         request = EXCLUDED.request,
         complete = EXCLUDED.complete,
         usage_json = EXCLUDED.usage_json,
         blocks_json = EXCLUDED.blocks_json,
         memories_json = EXCLUDED.memories_json,
         secrets_json = EXCLUDED.secrets_json,
         models_json = EXCLUDED.models_json,
         updated_at = EXCLUDED.updated_at`,
      [
        write.convId,
        write.turnId,
        encodePostgresText(write.pc),
        Math.trunc(write.startedAt),
        encodePostgresText(write.model),
        write.provider,
        encodePostgresText(write.request),
        write.complete,
        jsonParam(prepared.usageJson),
        jsonParam(prepared.blocksJson),
        jsonParam(prepared.memoriesJson),
        jsonParam(prepared.secretsJson),
        jsonParam(prepared.modelsJson)
      ]
    )
  })
}

export async function listPostgresContextTurns(pool: Pool, convId: string, limit: number): Promise<ContextTurnSummary[]> {
  assertContextIds(convId)
  const result = await pool.query<ContextTurnRow>(
    `SELECT ${TURN_COLUMNS} FROM context_turn WHERE conv_id = $1
     ORDER BY started_at DESC, turn_id DESC LIMIT $2`,
    [convId, clampContextLimit(limit)]
  )
  return result.rows.map((row) => contextTurnSummary(record(row)))
}

export async function readPostgresContextTurn(
  pool: Pool,
  convId: string,
  turnId: string
): Promise<ContextTurnDetail | null> {
  assertContextIds(convId, turnId)
  // Mesmo snapshot para o turno e seus blobs: um upsert/delete seguido de
  // poda entre os dois SELECTs não pode transformar a leitura em texto vazio.
  return transaction(pool, async (client) => {
    const result = await client.query<ContextTurnRow>(
      `SELECT ${TURN_COLUMNS} FROM context_turn WHERE conv_id = $1 AND turn_id = $2`,
      [convId, turnId]
    )
    if (!result.rows[0]) return null
    const turn = record(result.rows[0])
    const hashes = contextTurnHashes(turn)
    const texts = new Map<string, string>()
    if (hashes.length) {
      const blobs = await client.query<{ hash: string; gz: Buffer }>(
        'SELECT hash, gz FROM context_blob WHERE hash = ANY($1::text[])',
        [hashes]
      )
      for (const blob of blobs.rows) texts.set(blob.hash, inflateContextBlob(blob.gz))
    }
    return contextTurnDetail(turn, texts)
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
}

/** Recebe o client da transação: `deleteConversation` apaga os turnos na MESMA
 *  transação do soft delete. */
export async function deletePostgresContextTurns(client: Pick<PoolClient, 'query'>, convId: string): Promise<number> {
  assertContextIds(convId)
  const result = await client.query('DELETE FROM context_turn WHERE conv_id = $1', [convId])
  return result.rowCount ?? 0
}

/** Em lotes (mesmo motivo de `pruneInBatches`): cada lote é uma transação curta
 *  com o lock exclusivo, e devolve a vaga do pool entre um e outro. */
export async function prunePostgresOrphanContextBlobs(pool: Pool): Promise<number> {
  return pruneInBatches((limit) =>
    transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [CONTEXT_BLOB_LOCK_KEY])
      const result = await client.query(
        `DELETE FROM context_blob WHERE hash IN (
           SELECT blob.hash FROM context_blob AS blob
           WHERE NOT EXISTS (
             SELECT 1 FROM context_turn AS turn
             CROSS JOIN LATERAL jsonb_array_elements(turn.blocks_json) AS block
             WHERE block->>'hash' = blob.hash
           )
           LIMIT $1
         )`,
        [limit]
      )
      return result.rowCount ?? 0
    })
  )
}
