import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry
} from '@anthropic-ai/claude-agent-sdk'
import type { Pool } from 'pg'
import { hashJson, normalizeJson } from './hashes'
import {
  APPEND_ATTEMPT_MIN_MS,
  AppendDeadline,
  connectWithin,
  deadlineQueryable,
  type Queryable
} from './postgresAppendDeadline'
import { batchHash, PendingCommitUnresolvedError, pendingCommitsFor } from './postgresCommitAmbiguity'
import { decodePostgresJson, encodePostgresJson } from './postgresEncoding'
import { isTransientPostgresError, withTransientRetry, type TransientRetryOptions } from './postgresRetry'
import { appendBeginSql } from './postgresSessionSetup'
import { rollbackOrDiscard } from './postgresTimeouts'
import { planReplayBatch, sessionKeyId } from './replayDedup'

/** Versão exata do Agent SDK usada para gravar sessões. Mantida em sinc com a
 *  dependência fixada no package.json — ver docs/postgresql-persistence.md. */
export const SDK_VERSION = '0.3.278'

interface EntryRow {
  entry: SessionStoreEntry
}

interface SessionRow {
  session_id: string
  mtime_ms: string | number
}

interface SummaryRow extends SessionRow {
  data: Record<string, unknown>
}

function subpath(key: SessionKey): string {
  return key.subpath ?? ''
}

async function transaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let discard: Error | undefined
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    // Conexão que caiu ou travou no meio não volta ao pool: devolvida, o próximo
    // pedido a pegaria morta.
    discard = await rollbackOrDiscard(client, error)
    throw error
  } finally {
    client.release(discard)
  }
}

export interface PostgresSessionStoreOptions {
  /** Store do REPARO do espelho (replay do transcript local): entradas sem uuid
   *  só são gravadas se o banco ainda não tem aquela ocorrência — ver
   *  replayDedup.ts. O espelho normal do SDK nunca usa este modo. */
  replay?: boolean
  retry?: TransientRetryOptions
}

export function createPostgresSessionStore(
  pool: Pool,
  conversationId: string,
  options: PostgresSessionStoreOptions = {}
): SessionStore {
  const replaySeen = options.replay ? new Map<string, Map<string, number>>() : null
  const commits = pendingCommitsFor(pool)
  // Espelho vivo e reparo não compartilham pendência: um não resolve a do outro.
  const pendingKeyOf = (key: SessionKey): string =>
    `${options.replay ? 'replay' : 'live'}\u0000${conversationId}\u0000${sessionKeyId(key)}`

  /** Grava o lote numa transação já aberta. No modo replay devolve o contador de
   *  ocorrências sem uuid atualizado — o chamador só o guarda depois do COMMIT. */
  async function appendBatch(
    client: Queryable,
    key: SessionKey,
    entries: SessionStoreEntry[]
  ): Promise<Map<string, number> | undefined> {
    const now = Date.now()
    await client.query(
      `INSERT INTO sdk_sessions(conversation_id, session_id, mtime_ms, sdk_version)
       VALUES($1, $2, $3, $4)
       ON CONFLICT(conversation_id, session_id) DO NOTHING`,
      [conversationId, key.sessionId, now, SDK_VERSION]
    )
    await client.query('SELECT 1 FROM sdk_sessions WHERE conversation_id = $1 AND session_id = $2 FOR UPDATE', [
      conversationId,
      key.sessionId
    ])
    let batch = entries
    let seen: Map<string, number> | undefined
    if (replaySeen && entries.some((entry) => !entry.uuid)) {
      // Contado DEPOIS do FOR UPDATE: nenhum outro append da sessão grava entre
      // a contagem e o insert, e o que o espelho vivo gravou antes já conta.
      const stored = await client.query<{ content_hash: string; copies: string | number }>(
        `SELECT content_hash, COUNT(*) AS copies FROM sdk_session_entries
         WHERE conversation_id = $1 AND session_id = $2 AND subpath = $3 AND entry_uuid IS NULL
         GROUP BY content_hash`,
        [conversationId, key.sessionId, subpath(key)]
      )
      const plan = planReplayBatch(
        entries,
        new Map(stored.rows.map((row) => [row.content_hash, Number(row.copies)])),
        replaySeen.get(sessionKeyId(key)) ?? new Map()
      )
      batch = plan.keep
      seen = plan.seen
    }
    const max = await client.query<{ sequence: string | number }>(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sdk_session_entries
       WHERE conversation_id = $1 AND session_id = $2 AND subpath = $3`,
      [conversationId, key.sessionId, subpath(key)]
    )
    let sequence = Number(max.rows[0]?.sequence ?? 0)
    const appended: SessionStoreEntry[] = []
    for (const entry of batch) {
      const normalized = normalizeJson(entry)
      sequence += 1
      const inserted = await client.query(
        `INSERT INTO sdk_session_entries(
           conversation_id, session_id, subpath, sequence, entry_uuid, entry, content_hash
         ) VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(conversation_id, session_id, subpath, entry_uuid)
         WHERE entry_uuid IS NOT NULL DO NOTHING`,
        [
          conversationId,
          key.sessionId,
          subpath(key),
          sequence,
          entry.uuid ?? null,
          encodePostgresJson(normalized),
          hashJson(normalized)
        ]
      )
      if (inserted.rowCount) appended.push(entry)
      else sequence -= 1
    }
    if (!appended.length) return seen
    await client.query(
      `UPDATE sdk_sessions SET mtime_ms = $3, sdk_version = $4,
         resume_ready = false, verified_hash = NULL
       WHERE conversation_id = $1 AND session_id = $2`,
      [conversationId, key.sessionId, now, SDK_VERSION]
    )
    const previousResult = await client.query<SummaryRow>(
      `SELECT session_id, mtime_ms, data FROM sdk_session_summaries
       WHERE conversation_id = $1 AND session_id = $2`,
      [conversationId, key.sessionId]
    )
    const previousRow = previousResult.rows[0]
    const previous: SessionSummaryEntry | undefined = previousRow
      ? {
          sessionId: previousRow.session_id,
          mtime: Number(previousRow.mtime_ms),
          data: decodePostgresJson(normalizeJson(previousRow.data)) as Record<string, unknown>
        }
      : undefined
    const summary = foldSessionSummary(previous, key, appended, { mtime: now })
    await client.query(
      `INSERT INTO sdk_session_summaries(conversation_id, session_id, mtime_ms, data)
       VALUES($1, $2, $3, $4)
       ON CONFLICT(conversation_id, session_id) DO UPDATE SET
         mtime_ms = EXCLUDED.mtime_ms, data = EXCLUDED.data`,
      [conversationId, key.sessionId, summary.mtime, encodePostgresJson(normalizeJson(summary.data))]
    )
    return seen
  }

  /**
   * Uma tentativa do append, toda dentro do prazo: conexão, resolução de um
   * COMMIT ambíguo anterior da mesma sessão/subpath e a transação. Se o COMMIT
   * sai e a resposta não volta, guarda txid + hash do lote para a próxima
   * chamada perguntar ao servidor o desfecho (postgresCommitAmbiguity.ts).
   */
  async function appendAttempt(
    key: SessionKey,
    entries: SessionStoreEntry[],
    hash: string,
    deadline: AppendDeadline
  ): Promise<void> {
    const pendingKey = pendingKeyOf(key)
    const client = await connectWithin(pool, deadline)
    const db = deadlineQueryable(client, deadline)
    let discard: Error | undefined
    let txid: string | null = null
    let seen: Map<string, number> | undefined
    let commitSent = false
    try {
      const pending = await commits.resolve(db, pendingKey, hash)
      if (pending.alreadyWritten) {
        if (replaySeen && pending.seen) replaySeen.set(sessionKeyId(key), pending.seen)
        return
      }
      await db.query(appendBeginSql())
      const current = await db.query<{ txid: string }>('SELECT txid_current()::text AS txid')
      txid = current.rows[0]?.txid ?? null
      seen = await appendBatch(db, key, entries)
      commitSent = true
      await db.query('COMMIT')
      if (replaySeen && seen) replaySeen.set(sessionKeyId(key), seen)
    } catch (error) {
      if (commitSent && txid) commits.record(pendingKey, { txid, batchHash: hash, seen })
      // Conexão que caiu ou travou não volta ao pool; o ROLLBACK, se houver,
      // também respeita o prazo.
      discard = await rollbackOrDiscard(db, error)
      throw error
    } finally {
      client.release(discard)
    }
  }

  return {
    /**
     * O SDK chama isto DEPOIS de gravar o transcript local e repete uma rejeição
     * só 3x com backoff curto, descartando o lote em seguida (mirror_error). Uma
     * queda de rede de segundos derrubava o lote. Aqui a falha de CONEXÃO é
     * repetida com backoff, tudo dentro de um PRAZO ÚNICO por chamada (45s,
     * MIRROR_APPEND_RETRY_BUDGET_MS) bem abaixo dos 60s do SDK; erro de SQL/dado
     * continua falhando na hora.
     *
     * Repetir — aqui ou pelo próprio SDK, que repete toda rejeição que não é o
     * timeout dele — é seguro: entrada com uuid tem ON CONFLICT, a transação que
     * falhou antes do COMMIT não gravou nada, e quando a falha vem DEPOIS de o
     * COMMIT sair (pode ter gravado) a próxima chamada da mesma sessão/subpath
     * pergunta ao servidor pelo txid se ele gravou antes de gravar de novo
     * (postgresCommitAmbiguity.ts). Assim as entradas sem uuid não duplicam.
     */
    async append(key, entries) {
      if (!entries.length) return
      const deadline = new AppendDeadline(options.retry?.budgetMs, options.retry?.now)
      const hash = batchHash(entries)
      await withTransientRetry(
        () => appendAttempt(key, entries, hash, deadline),
        {
          ...options.retry,
          deadlineAt: deadline.at,
          attemptMinMs: APPEND_ATTEMPT_MIN_MS,
          isRetryable: (error) => isTransientPostgresError(error) || error instanceof PendingCommitUnresolvedError,
          onRetry: (error, attempt, delay) => {
            console.warn(
              `[session-store] append falhou (tentativa ${attempt}, nova em ${delay}ms) conversation=${conversationId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
            options.retry?.onRetry?.(error, attempt, delay)
          }
        }
      )
    },

    async load(key) {
      const rows = await pool.query<EntryRow>(
        `SELECT entry FROM sdk_session_entries
         WHERE conversation_id = $1 AND session_id = $2 AND subpath = $3 ORDER BY sequence`,
        [conversationId, key.sessionId, subpath(key)]
      )
      return rows.rowCount
        ? rows.rows.map((row) => decodePostgresJson(normalizeJson(row.entry)) as SessionStoreEntry)
        : null
    },

    async listSessions() {
      const rows = await pool.query<SessionRow>(
        'SELECT session_id, mtime_ms FROM sdk_sessions WHERE conversation_id = $1 ORDER BY mtime_ms DESC',
        [conversationId]
      )
      return rows.rows.map((row) => ({ sessionId: row.session_id, mtime: Number(row.mtime_ms) }))
    },

    async listSessionSummaries() {
      const rows = await pool.query<SummaryRow>(
        `SELECT session_id, mtime_ms, data FROM sdk_session_summaries
         WHERE conversation_id = $1 ORDER BY mtime_ms DESC`,
        [conversationId]
      )
      return rows.rows.map((row) => ({
        sessionId: row.session_id,
        mtime: Number(row.mtime_ms),
        data: decodePostgresJson(normalizeJson(row.data)) as Record<string, unknown>
      }))
    },

    async delete(key) {
      await transaction(pool, async (client) => {
        if (key.subpath === undefined) {
          await client.query(
            `DELETE FROM sdk_session_entries
             WHERE conversation_id = $1 AND session_id = $2`,
            [conversationId, key.sessionId]
          )
          await client.query(
            'DELETE FROM sdk_session_summaries WHERE conversation_id = $1 AND session_id = $2',
            [conversationId, key.sessionId]
          )
          await client.query('DELETE FROM sdk_sessions WHERE conversation_id = $1 AND session_id = $2', [
            conversationId,
            key.sessionId
          ])
        } else {
          await client.query(
            `DELETE FROM sdk_session_entries
             WHERE conversation_id = $1 AND session_id = $2 AND subpath = $3`,
            [conversationId, key.sessionId, subpath(key)]
          )
        }
      })
    },

    async listSubkeys(key) {
      const rows = await pool.query<{ subpath: string }>(
        `SELECT DISTINCT subpath FROM sdk_session_entries
         WHERE conversation_id = $1 AND session_id = $2 AND subpath <> '' ORDER BY subpath`,
        [conversationId, key.sessionId]
      )
      return rows.rows.map((row) => row.subpath)
    }
  }
}
