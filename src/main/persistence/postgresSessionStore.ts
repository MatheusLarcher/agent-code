import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry
} from '@anthropic-ai/claude-agent-sdk'
import type { Pool, PoolClient } from 'pg'
import { hashJson, normalizeJson } from './hashes'
import { decodePostgresJson, encodePostgresJson } from './postgresEncoding'

/** Versão exata do Agent SDK usada para gravar sessões. Mantida em sinc com a
 *  dependência fixada no package.json — ver docs/postgresql-persistence.md. */
export const SDK_VERSION = '0.3.257'

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

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function createPostgresSessionStore(pool: Pool, conversationId: string): SessionStore {
  return {
    async append(key, entries) {
      if (!entries.length) return
      await transaction(pool, async (client) => {
        const now = Date.now()
        await client.query(
          `INSERT INTO sdk_sessions(conversation_id, session_id, mtime_ms, sdk_version)
           VALUES($1, $2, $3, $4)
           ON CONFLICT(conversation_id, session_id) DO NOTHING`,
          [conversationId, key.sessionId, now, SDK_VERSION]
        )
        await client.query(
          'SELECT 1 FROM sdk_sessions WHERE conversation_id = $1 AND session_id = $2 FOR UPDATE',
          [conversationId, key.sessionId]
        )
        const max = await client.query<{ sequence: string | number }>(
          `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sdk_session_entries
           WHERE conversation_id = $1 AND session_id = $2 AND subpath = $3`,
          [conversationId, key.sessionId, subpath(key)]
        )
        let sequence = Number(max.rows[0]?.sequence ?? 0)
        const appended: SessionStoreEntry[] = []
        for (const entry of entries) {
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
        if (!appended.length) return
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
      })
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
