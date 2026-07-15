import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { DB_NAME } from './store'

/**
 * Per-project conversation storage. Instead of every conversation living in one
 * shared JSON blob, each distinct project (a conversation's `cwd`) gets its own
 * SQLite file under `<cacheDir>/data/`. `cacheDir` is always passed in by the
 * caller (never read from Electron's `app` module), so this module has zero
 * Electron dependency and is fully unit-testable against a plain temp directory.
 */

const DATA_DIRNAME = 'data'
/** Bucket for conversations with no/blank `cwd` — shouldn't normally happen. */
const NO_PROJECT_FILE = 'sem-projeto.db'
const CONVERSATIONS_KEY = 'conversations'
/** The key the single-blob store used to keep ALL conversations under, in the
 *  legacy shared `agent-code.db`. Read once for migration, never written again. */
const LEGACY_CONVERSATIONS_KEY = 'agentcode.conversations.v1'

/** A conversation as seen by this layer: opaque JSON, only `cwd` matters for grouping. */
export type ConversationRecord = Record<string, unknown>

function dataDir(cacheDir: string): string {
  return join(cacheDir, DATA_DIRNAME)
}

/**
 * Stable, collision-safe filename for a project's db, derived from its `cwd`.
 * Two folders with the same name under different parents never collide — the
 * hash covers the full absolute (case-insensitive) path.
 */
export function projectFileName(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) return NO_PROJECT_FILE
  const abs = resolve(cwd.trim())
  const slug = basename(abs).replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'projeto'
  const hash = createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8)
  return `${slug}-${hash}.db`
}

/** Open a project db, run `fn`, and always close it — never hold a handle open
 *  between calls (same rationale as `store.ts`: keeps the folder cloud-sync friendly). */
function withProjectDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    return fn(db)
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

function readConversations(path: string): ConversationRecord[] {
  return withProjectDb(path, (db) => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(CONVERSATIONS_KEY) as
      | { value?: string }
      | undefined
    if (!row?.value) return []
    try {
      const parsed = JSON.parse(row.value)
      return Array.isArray(parsed) ? (parsed as ConversationRecord[]) : []
    } catch {
      return []
    }
  })
}

function writeConversations(path: string, list: ConversationRecord[]): void {
  withProjectDb(path, (db) =>
    db
      .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(CONVERSATIONS_KEY, JSON.stringify(list))
  )
}

function listProjectFiles(cacheDir: string): string[] {
  try {
    return readdirSync(dataDir(cacheDir)).filter((f) => f.toLowerCase().endsWith('.db'))
  } catch {
    return []
  }
}

function groupByProject(list: ConversationRecord[]): Map<string, ConversationRecord[]> {
  const map = new Map<string, ConversationRecord[]>()
  for (const record of list) {
    const file = projectFileName(record?.cwd)
    const arr = map.get(file)
    if (arr) arr.push(record)
    else map.set(file, [record])
  }
  return map
}

/** Read the legacy single-blob conversations list straight out of the old
 *  `agent-code.db`, without touching `store.ts`'s global handle/singleton. */
function readLegacyConversations(cacheDir: string): ConversationRecord[] {
  const legacyPath = join(cacheDir, DB_NAME)
  if (!existsSync(legacyPath)) return []
  try {
    const db = new DatabaseSync(legacyPath)
    try {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(LEGACY_CONVERSATIONS_KEY) as
        | { value?: string }
        | undefined
      if (!row?.value) return []
      const parsed = JSON.parse(row.value)
      return Array.isArray(parsed) ? (parsed as ConversationRecord[]) : []
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

/**
 * One-time, idempotent split of the legacy blob into per-project files — runs
 * only when `data/` doesn't exist yet. Backs up the whole legacy db first (once);
 * the legacy key itself is left in place afterward as an inert backup, mirroring
 * how this codebase already keeps old localStorage values around post-migration.
 */
function migrateLegacyConversations(cacheDir: string): void {
  if (existsSync(dataDir(cacheDir))) return // already migrated (or nothing to migrate)
  const legacyList = readLegacyConversations(cacheDir)
  mkdirSync(dataDir(cacheDir), { recursive: true }) // marks migration as done, even if there was nothing to migrate
  if (!legacyList.length) return

  const legacyPath = join(cacheDir, DB_NAME)
  const backupPath = `${legacyPath}.bak`
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(legacyPath, backupPath)
    } catch {
      /* best-effort — the migration still proceeds even if the backup copy failed */
    }
  }

  for (const [file, records] of groupByProject(legacyList)) {
    writeConversations(join(dataDir(cacheDir), file), records)
  }
}

/** Load every conversation from every per-project db under `data/` — merged, the
 *  same "load everything at once" contract the single-blob store used to offer. */
export function loadAllConversationRecords(cacheDir: string): ConversationRecord[] {
  migrateLegacyConversations(cacheDir)
  const merged: ConversationRecord[] = []
  for (const file of listProjectFiles(cacheDir)) {
    merged.push(...readConversations(join(dataDir(cacheDir), file)))
  }
  return merged
}

/**
 * Persist the full conversation list, fanned out one file per project. A project
 * that no longer has any conversation (all deleted) has its file removed — no
 * ghost data resurrecting on a later load.
 */
export function saveAllConversationRecords(cacheDir: string, list: ConversationRecord[]): void {
  migrateLegacyConversations(cacheDir)
  mkdirSync(dataDir(cacheDir), { recursive: true })
  const grouped = groupByProject(list)
  const stale = new Set(listProjectFiles(cacheDir))
  for (const [file, records] of grouped) {
    writeConversations(join(dataDir(cacheDir), file), records)
    stale.delete(file)
  }
  for (const file of stale) {
    try {
      rmSync(join(dataDir(cacheDir), file), { force: true })
    } catch {
      /* best-effort */
    }
  }
}
