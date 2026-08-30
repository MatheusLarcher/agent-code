import type { DatabaseSync } from 'node:sqlite'
import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry
} from '@anthropic-ai/claude-agent-sdk'

export interface SqliteStoreIo {
  read<T>(fn: (db: DatabaseSync) => T): T
  write<T>(fn: (db: DatabaseSync) => T): T
}

interface EntryRow {
  entry_json: string
}

interface SessionRow {
  session_id: string
  mtime_ms: number
}

interface SummaryRow {
  session_id: string
  mtime_ms: number
  data_json: string
}

function subpathOf(key: SessionKey): string {
  return key.subpath ?? ''
}

function parseEntry(row: EntryRow): SessionStoreEntry {
  return JSON.parse(row.entry_json) as SessionStoreEntry
}

export function createSqliteSessionStore(io: SqliteStoreIo): SessionStore {
  return {
    async append(key, entries) {
      if (!entries.length) return
      io.write((db) => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const subpath = subpathOf(key)
          const maxRow = db
            .prepare(
              `SELECT COALESCE(MAX(sequence), 0) AS sequence
               FROM sdk_session_entries_v2
               WHERE project_key = ? AND session_id = ? AND subpath = ?`
            )
            .get(key.projectKey, key.sessionId, subpath) as { sequence: number }
          let sequence = Number(maxRow.sequence)
          const appended: SessionStoreEntry[] = []
          for (const entry of entries) {
            if (entry.uuid) {
              const duplicate = db
                .prepare(
                  `SELECT 1 AS found FROM sdk_session_entries_v2
                   WHERE project_key = ? AND session_id = ? AND subpath = ? AND entry_uuid = ?`
                )
                .get(key.projectKey, key.sessionId, subpath, entry.uuid)
              if (duplicate) continue
            }
            sequence += 1
            db.prepare(
              `INSERT INTO sdk_session_entries_v2(
                 project_key, session_id, subpath, sequence, entry_uuid, entry_json, committed_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?)`
            ).run(
              key.projectKey,
              key.sessionId,
              subpath,
              sequence,
              entry.uuid ?? null,
              JSON.stringify(entry),
              new Date().toISOString()
            )
            appended.push(entry)
          }
          if (!appended.length) {
            db.exec('COMMIT')
            return
          }

          const mtime = Date.now()
          db.prepare(
            `INSERT INTO sdk_sessions_v2(project_key, session_id, mtime_ms)
             VALUES(?, ?, ?)
             ON CONFLICT(project_key, session_id) DO UPDATE SET mtime_ms = excluded.mtime_ms`
          ).run(key.projectKey, key.sessionId, mtime)

          const previousRow = db
            .prepare(
              `SELECT session_id, mtime_ms, data_json FROM sdk_session_summaries_v2
               WHERE project_key = ? AND session_id = ?`
            )
            .get(key.projectKey, key.sessionId) as SummaryRow | undefined
          const previous: SessionSummaryEntry | undefined = previousRow
            ? {
                sessionId: previousRow.session_id,
                mtime: Number(previousRow.mtime_ms),
                data: JSON.parse(previousRow.data_json) as Record<string, unknown>
              }
            : undefined
          const summary = foldSessionSummary(previous, key, appended, { mtime })
          db.prepare(
            `INSERT INTO sdk_session_summaries_v2(project_key, session_id, mtime_ms, data_json)
             VALUES(?, ?, ?, ?)
             ON CONFLICT(project_key, session_id) DO UPDATE SET
               mtime_ms = excluded.mtime_ms,
               data_json = excluded.data_json`
          ).run(key.projectKey, key.sessionId, summary.mtime, JSON.stringify(summary.data))
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
    },

    async load(key) {
      return io.read((db) => {
        const rows = db
          .prepare(
            `SELECT entry_json FROM sdk_session_entries_v2
             WHERE project_key = ? AND session_id = ? AND subpath = ?
             ORDER BY sequence`
          )
          .all(key.projectKey, key.sessionId, subpathOf(key)) as unknown as EntryRow[]
        return rows.length ? rows.map(parseEntry) : null
      })
    },

    async listSessions(projectKey) {
      return io.read((db) => {
        const rows = db
          .prepare(
            `SELECT session_id, mtime_ms FROM sdk_sessions_v2
             WHERE project_key = ? ORDER BY mtime_ms DESC`
          )
          .all(projectKey) as unknown as SessionRow[]
        return rows.map((row) => ({ sessionId: row.session_id, mtime: Number(row.mtime_ms) }))
      })
    },

    async listSessionSummaries(projectKey) {
      return io.read((db) => {
        const rows = db
          .prepare(
            `SELECT session_id, mtime_ms, data_json FROM sdk_session_summaries_v2
             WHERE project_key = ? ORDER BY mtime_ms DESC`
          )
          .all(projectKey) as unknown as SummaryRow[]
        return rows.map((row) => ({
          sessionId: row.session_id,
          mtime: Number(row.mtime_ms),
          data: JSON.parse(row.data_json) as Record<string, unknown>
        }))
      })
    },

    async delete(key) {
      io.write((db) => {
        db.exec('BEGIN IMMEDIATE')
        try {
          if (key.subpath === undefined) {
            db.prepare(
              `DELETE FROM sdk_session_entries_v2
               WHERE project_key = ? AND session_id = ?`
            ).run(key.projectKey, key.sessionId)
            db.prepare('DELETE FROM sdk_sessions_v2 WHERE project_key = ? AND session_id = ?').run(
              key.projectKey,
              key.sessionId
            )
            db.prepare('DELETE FROM sdk_session_summaries_v2 WHERE project_key = ? AND session_id = ?').run(
              key.projectKey,
              key.sessionId
            )
          } else {
            db.prepare(
              `DELETE FROM sdk_session_entries_v2
               WHERE project_key = ? AND session_id = ? AND subpath = ?`
            ).run(key.projectKey, key.sessionId, subpathOf(key))
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
    },

    async listSubkeys(key) {
      return io.read((db) => {
        const rows = db
          .prepare(
            `SELECT DISTINCT subpath FROM sdk_session_entries_v2
             WHERE project_key = ? AND session_id = ? AND subpath <> ''
             ORDER BY subpath`
          )
          .all(key.projectKey, key.sessionId) as unknown as Array<{ subpath: string }>
        return rows.map((row) => row.subpath)
      })
    }
  }
}
