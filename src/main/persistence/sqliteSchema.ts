import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import {
  isRegisteredPersistedKey,
  migrationScopeForUnknownKey,
  persistedKeyDefinition
} from './keyRegistry'
import { StorageError, type ConversationRecord, type KvScope } from './types'
import { writeDbAtomically } from '../atomicDb'

const MIGRATION_VERSION = 1
const LEGACY_CONVERSATIONS_KEY = 'agentcode.conversations.v1'
const DATA_DIRNAME = 'data'

export const SQLITE_V2_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS persistent_kv_v2 (
    scope TEXT NOT NULL CHECK(scope IN ('global', 'device')),
    key TEXT NOT NULL,
    value_text TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, key)
  );
  CREATE TABLE IF NOT EXISTS conversations_v2 (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sdk_sessions_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    PRIMARY KEY(project_key, session_id)
  );
  CREATE TABLE IF NOT EXISTS sdk_session_entries_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    sequence INTEGER NOT NULL,
    entry_uuid TEXT,
    entry_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(project_key, session_id, subpath, sequence)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sdk_session_entries_uuid_v2
    ON sdk_session_entries_v2(project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sdk_session_summaries_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(project_key, session_id)
  );
`

interface LegacyKv {
  key: string
  value: string
  scope: KvScope
}

function close(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

function withReadableDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return fn(db)
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError('INVALID_PERSISTED_DATA', `Banco SQLite ilegível: ${path}`, false, { cause })
  } finally {
    if (db) close(db)
  }
}

function readLegacyKv(dbPath: string): LegacyKv[] {
  if (!existsSync(dbPath)) return []
  return withReadableDb(dbPath, (db) => {
    const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    if (!hasKv) return []
    const rows = db.prepare('SELECT key, value FROM kv ORDER BY key').all() as unknown as Array<{
      key: string
      value: string
    }>
    return rows
      .filter((row) => row.key !== LEGACY_CONVERSATIONS_KEY)
      .map((row) => ({
        key: row.key,
        value: row.value,
        scope: isRegisteredPersistedKey(row.key)
          ? persistedKeyDefinition(row.key).scope
          : migrationScopeForUnknownKey()
      }))
  })
}

function parseConversationArray(raw: string, source: string): ConversationRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Histórico inválido em ${source}.`, false, { cause })
  }
  if (!Array.isArray(parsed)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Histórico em ${source} não é uma lista.`)
  }
  return parsed as ConversationRecord[]
}

function readLegacyConversationBlob(dbPath: string): ConversationRecord[] {
  if (!existsSync(dbPath)) return []
  return withReadableDb(dbPath, (db) => {
    const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    if (!hasKv) return []
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(LEGACY_CONVERSATIONS_KEY) as
      | { value?: string }
      | undefined
    return row?.value ? parseConversationArray(row.value, `${dbPath}:${LEGACY_CONVERSATIONS_KEY}`) : []
  })
}

function readProjectConversations(cacheDir: string): ConversationRecord[] {
  const dir = join(cacheDir, DATA_DIRNAME)
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.db'))
  } catch {
    return []
  }
  const records: ConversationRecord[] = []
  for (const file of files) {
    const path = join(dir, file)
    records.push(
      ...withReadableDb(path, (db) => {
        const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
        if (!hasKv) throw new StorageError('INVALID_PERSISTED_DATA', `Tabela kv ausente em ${path}.`)
        const row = db.prepare("SELECT value FROM kv WHERE key = 'conversations'").get() as
          | { value?: string }
          | undefined
        return row?.value ? parseConversationArray(row.value, path) : []
      })
    )
  }
  return records
}

function numericField(record: ConversationRecord, field: string): number {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function messageCount(record: ConversationRecord): number {
  return Array.isArray(record.messages) ? record.messages.length : 0
}

function richer(left: ConversationRecord, right: ConversationRecord): ConversationRecord {
  const byUpdatedAt = numericField(left, 'updatedAt') - numericField(right, 'updatedAt')
  if (byUpdatedAt !== 0) return byUpdatedAt > 0 ? left : right
  return messageCount(left) >= messageCount(right) ? left : right
}

function conflictCopy(record: ConversationRecord, originalId: string, hash: string): ConversationRecord {
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : 'Conversa'
  return {
    ...record,
    id: `${originalId}-conflict-${hash.slice(0, 8)}`,
    title: `${title} (conflito importado)`,
    legacyConflictOf: originalId
  }
}

function normalizeConversations(records: ConversationRecord[]): ConversationRecord[] {
  const byId = new Map<string, { record: ConversationRecord; hash: string }>()
  const conflicts: ConversationRecord[] = []
  for (const raw of records) {
    const record = normalizeJson(raw) as ConversationRecord & JsonValue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id) throw new StorageError('INVALID_PERSISTED_DATA', 'Conversa sem ID no histórico SQLite.')
    const hash = hashJson(record)
    const current = byId.get(id)
    if (!current) {
      byId.set(id, { record, hash })
      continue
    }
    if (current.hash === hash) continue
    const winner = richer(current.record, record)
    const loser = winner === current.record ? record : current.record
    const loserHash = winner === current.record ? hash : current.hash
    byId.set(id, { record: winner, hash: hashJson(winner as JsonValue) })
    conflicts.push(conflictCopy(loser, id, loserHash))
  }
  return [...[...byId.values()].map((value) => value.record), ...conflicts]
}

function isoFromRecord(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString()
}

function hasMigration(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  return withReadableDb(dbPath, (db) => {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get()
    if (!table) return false
    const newest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null
    }
    if (Number(newest.version ?? 0) > MIGRATION_VERSION) {
      throw new StorageError('SCHEMA_TOO_NEW', 'O schema SQLite foi criado por uma versão mais nova do Agent Code.')
    }
    const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(MIGRATION_VERSION) as
      | { checksum: string }
      | undefined
    if (!row) return false
    if (row.checksum !== hashText(SQLITE_V2_SCHEMA)) {
      throw new StorageError('SCHEMA_CHECKSUM_MISMATCH', 'O checksum da migration SQLite v2 não confere.')
    }
    for (const name of [
      'persistent_kv_v2',
      'conversations_v2',
      'sdk_sessions_v2',
      'sdk_session_entries_v2',
      'sdk_session_summaries_v2'
    ]) {
      const found = db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name)
      if (!found) throw new StorageError('INVALID_PERSISTED_DATA', `Tabela SQLite v2 ausente: ${name}.`)
    }
    return true
  })
}

export function initializeSqliteV2(cacheDir: string, dbPath: string): void {
  mkdirSync(cacheDir, { recursive: true })
  if (hasMigration(dbPath)) return

  const appliedAt = new Date().toISOString()
  const legacyKv = readLegacyKv(dbPath)
  const legacyConversations = normalizeConversations([
    ...readLegacyConversationBlob(dbPath),
    ...readProjectConversations(cacheDir)
  ])
  const backupPath = `${dbPath}.pre-v2.bak`
  if (existsSync(dbPath) && !existsSync(backupPath)) {
    try {
      copyFileSync(dbPath, backupPath)
    } catch (cause) {
      throw new StorageError('MIGRATION_VERIFICATION_FAILED', 'Não foi possível criar o backup pré-v2.', false, {
        cause
      })
    }
  }

  writeDbAtomically(
    dbPath,
    (db) => {
      db.exec(SQLITE_V2_SCHEMA)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const entry of legacyKv) {
          db.prepare(
            `INSERT INTO persistent_kv_v2(scope, key, value_text, revision, content_hash, updated_at)
             VALUES(?, ?, ?, 1, ?, ?)
             ON CONFLICT(scope, key) DO NOTHING`
          ).run(entry.scope, entry.key, entry.value, hashText(entry.value), appliedAt)
        }
        for (const record of legacyConversations) {
          const id = record.id as string
          const payload = normalizeJson(record)
          db.prepare(
            `INSERT INTO conversations_v2(
               id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
             ) VALUES(?, ?, 1, ?, ?, ?, NULL)
             ON CONFLICT(id) DO NOTHING`
          ).run(
            id,
            JSON.stringify(payload),
            hashJson(payload),
            isoFromRecord(record.createdAt, appliedAt),
            isoFromRecord(record.updatedAt, appliedAt)
          )
        }
        db.prepare(
          `INSERT INTO schema_migrations(version, name, checksum, applied_at)
           VALUES(?, 'sqlite-v2-base', ?, ?)`
        ).run(MIGRATION_VERSION, hashText(SQLITE_V2_SCHEMA), appliedAt)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    { seed: true }
  )
}
