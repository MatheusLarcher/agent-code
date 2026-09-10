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

const LEGACY_CONVERSATIONS_KEY = 'agentcode.conversations.v1'
const DATA_DIRNAME = 'data'

/** Migration 1 — the v2 base. Its text is frozen: the checksum stored in every
 *  existing install is `hashText(SQLITE_V2_SCHEMA)`, so new tables go into
 *  later, additive migrations instead of editing this string. */
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

const TASK_STATUS_CHECK = "CHECK(status IN ('pending', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'))"

/** Migration 2 — task ledger (see docs/superpowers/specs/2026-09-10-registro-de-tarefas…). */
export const SQLITE_TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    project_cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL ${TASK_STATUS_CHECK},
    owner_agent TEXT,
    write_scope_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[]}',
    parent_task_id TEXT REFERENCES tasks(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_token TEXT,
    lease_expires_at TEXT,
    fencing_epoch INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_status_created_at ON tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS tasks_project_cwd ON tasks(project_cwd);
  CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('analyze', 'implement', 'verify', 'review', 'handoff')),
    status TEXT NOT NULL ${TASK_STATUS_CHECK},
    agent TEXT,
    sdk_session_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, seq)
  );
  CREATE TABLE IF NOT EXISTS task_deliverables (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    step_id TEXT REFERENCES task_steps(id),
    kind TEXT NOT NULL CHECK(kind IN ('diff', 'test_run', 'note', 'file', 'screenshot')),
    summary TEXT NOT NULL,
    payload_path TEXT,
    payload_hash TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    verified_by TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_deliverables_task_id ON task_deliverables(task_id);
  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    step_id TEXT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS task_events_task_at ON task_events(task_id, at);
`

const MEMORY_SCOPE_CHECK = "CHECK(scope IN ('user', 'project', 'domain'))"

/** Migration 3 — memory service (memory_entries + memory_proposals queue). */
export const SQLITE_MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    scope TEXT NOT NULL ${MEMORY_SCOPE_CHECK},
    project_cwd TEXT,
    domain TEXT,
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
    origin_conversation_id TEXT,
    origin_message_id TEXT,
    origin_agent TEXT,
    supersedes_id TEXT REFERENCES memory_entries(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_entries_status ON memory_entries(status);
  CREATE TABLE IF NOT EXISTS memory_proposals (
    id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES memory_entries(id),
    op TEXT NOT NULL CHECK(op IN ('create', 'update', 'retire')),
    rel_path TEXT NOT NULL,
    title TEXT,
    hook TEXT,
    body TEXT,
    scope TEXT NOT NULL ${MEMORY_SCOPE_CHECK},
    project_cwd TEXT,
    domain TEXT,
    origin_conversation_id TEXT,
    origin_message_id TEXT,
    origin_agent TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'rejected', 'conflict')),
    reason TEXT,
    proposed_by TEXT NOT NULL,
    expected_revision INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_proposals_status_created_at ON memory_proposals(status, created_at);
`

export interface SqliteMigration {
  version: number
  name: string
  sql: string
  checksum: string
}

function migration(version: number, name: string, sql: string): SqliteMigration {
  return { version, name, sql, checksum: hashText(sql) }
}

/** Ordered, additive. Every statement is `IF NOT EXISTS`, so the concatenation
 *  (`SQLITE_SCHEMA`) can be re-run on every write as an idempotent guard. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  migration(1, 'sqlite-v2-base', SQLITE_V2_SCHEMA),
  migration(2, 'sqlite-v2-tasks', SQLITE_TASKS_SCHEMA),
  migration(3, 'sqlite-v2-memory', SQLITE_MEMORY_SCHEMA)
]

export const SQLITE_SCHEMA = SQLITE_MIGRATIONS.map((entry) => entry.sql).join('\n')

const LATEST_VERSION = SQLITE_MIGRATIONS.at(-1)!.version

/** Marks every migration as applied in a freshly built db (all DDL already executed). */
export function recordSqliteMigrations(db: DatabaseSync, appliedAt: string): void {
  const insert = db.prepare(
    `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(version) DO NOTHING`
  )
  for (const entry of SQLITE_MIGRATIONS) insert.run(entry.version, entry.name, entry.checksum, appliedAt)
}

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

/** Versions already recorded in `schema_migrations`, after verifying each one's
 *  checksum. Empty when the file is missing or still pre-v2 (legacy `kv` only). */
function appliedMigrations(dbPath: string): Set<number> {
  if (!existsSync(dbPath)) return new Set()
  return withReadableDb(dbPath, (db) => {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get()
    if (!table) return new Set<number>()
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as unknown as Array<{
      version: number
      checksum: string
    }>
    const applied = new Set<number>()
    for (const row of rows) {
      const version = Number(row.version)
      if (version > LATEST_VERSION) {
        throw new StorageError('SCHEMA_TOO_NEW', 'O schema SQLite foi criado por uma versão mais nova do Agent Code.')
      }
      const known = SQLITE_MIGRATIONS.find((entry) => entry.version === version)
      if (!known || known.checksum !== row.checksum) {
        throw new StorageError('SCHEMA_CHECKSUM_MISMATCH', `O checksum da migration SQLite ${version} não confere.`)
      }
      applied.add(version)
    }
    if (applied.has(1)) {
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
    }
    return applied
  })
}

/** Additive upgrade of an existing v2 db: run only the missing migrations, each
 *  recorded in the same transaction, on an atomically swapped copy. */
function applyPendingMigrations(dbPath: string, applied: Set<number>): void {
  const pending = SQLITE_MIGRATIONS.filter((entry) => !applied.has(entry.version))
  if (pending.length === 0) return
  const appliedAt = new Date().toISOString()
  writeDbAtomically(
    dbPath,
    (db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const entry of pending) {
          db.exec(entry.sql)
          db.prepare(
            `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)`
          ).run(entry.version, entry.name, entry.checksum, appliedAt)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    { seed: true }
  )
}

export function initializeSqliteV2(cacheDir: string, dbPath: string): void {
  mkdirSync(cacheDir, { recursive: true })
  const applied = appliedMigrations(dbPath)
  if (applied.has(1)) {
    applyPendingMigrations(dbPath, applied)
    return
  }

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
      db.exec(SQLITE_SCHEMA)
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
        recordSqliteMigrations(db, appliedAt)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    { seed: true }
  )
}
