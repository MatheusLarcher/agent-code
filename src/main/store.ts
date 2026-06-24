import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Persistence layout (per user, NOT per project):
 *
 *  ~/.agent-code/location.json      ← pointer: ONLY the path of the cache folder
 *  <chosen>/agent-code/             ← cache folder (name fixed = the project name)
 *    ├─ agent-code.db               ← SQLite: all system data (config, android token,
 *    │                                 conversations…) as a simple key→JSON store
 *    └─ memories/                   ← .md files of the persistent per-user memory
 *                                     (MEMORY.md index + one fact per <slug>.md)
 *
 * The cache folder holds ONLY the .db and the .md memories — no libraries. SQLite is
 * the built-in node:sqlite (no native/npm dependency), so nothing else lands there.
 *
 * IMPORTANT — file handles are NOT kept open. Every read/write opens the db, runs,
 * and CLOSES it again (see `withDb`). This way the .db file is never locked while the
 * app is idle, so the user can keep the cache folder inside OneDrive/Google Drive and
 * those clients can back it up without the app having to be closed. We also force the
 * rollback journal (`journal_mode = DELETE`) so no `-wal`/`-shm` side files linger
 * holding a handle between operations.
 */

const APP_DIRNAME = 'agent-code'
const POINTER_DIR = join(homedir(), '.agent-code')
const POINTER_FILE = join(POINTER_DIR, 'location.json')
const DB_NAME = 'agent-code.db'

/** Path of the active cache folder. Resolved lazily from the pointer on first use. */
let cacheDir = ''

export interface CacheInfo {
  /** Absolute path of the active cache folder (…/agent-code). */
  dir: string
  /** Absolute path of the SQLite database inside it. */
  dbPath: string
  /** Absolute path of the memories folder inside it. */
  memoriesDir: string
}

/** Default cache folder before the user picks one: Documents/agent-code. */
function defaultCacheDir(): string {
  let docs = ''
  try {
    docs = app.getPath('documents')
  } catch {
    docs = homedir()
  }
  return join(docs, APP_DIRNAME)
}

function readPointer(): string {
  try {
    const raw = readFileSync(POINTER_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { cacheDir?: string }
    return typeof parsed.cacheDir === 'string' ? parsed.cacheDir : ''
  } catch {
    return ''
  }
}

function writePointer(dir: string): void {
  try {
    mkdirSync(POINTER_DIR, { recursive: true })
    writeFileSync(POINTER_FILE, JSON.stringify({ cacheDir: dir }, null, 2), 'utf8')
  } catch {
    /* best-effort — if we can't persist the pointer, we still run this session */
  }
}

function dbPath(dir: string): string {
  return join(dir, DB_NAME)
}

/**
 * Create the cache folder structure and the db schema, then close the db. Opening
 * here is transient on purpose — see the file header: we never hold the handle.
 */
function prepare(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memories'), { recursive: true })
  const db = new DatabaseSync(dbPath(dir))
  try {
    // Rollback journal (no persistent -wal/-shm) so the folder is a clean,
    // self-contained .db when idle — friendly to cloud-sync backup.
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Initialize the store. Reads the pointer; on first run defaults to Documents/agent-code
 * and migrates any legacy settings.json. Idempotent and lazily called by the kv helpers,
 * so call order doesn't matter. Does NOT keep any db handle open.
 */
export function initStore(): void {
  if (cacheDir) return
  const saved = readPointer()
  const firstRun = !saved
  cacheDir = saved || defaultCacheDir()
  prepare(cacheDir)
  writePointer(cacheDir)
  if (firstRun) migrateLegacyConfig()
}

function ensureDir(): string {
  if (!cacheDir) initStore()
  return cacheDir
}

/**
 * Open the db, run `fn`, and ALWAYS close it before returning — releasing the OS
 * file handle so the .db isn't locked between operations. This is what lets a
 * cloud-sync client (OneDrive/Drive) back the folder up while the app is running.
 */
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const dir = ensureDir()
  const db = new DatabaseSync(dbPath(dir))
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    return fn(db)
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

// ---- key→value (value is always a JSON string) ----------------------------

export function kvGet(key: string): string | null {
  return withDb((db) => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  })
}

export function kvSet(key: string, value: string): void {
  withDb((db) =>
    db
      .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  )
}

// ---- cache folder management ----------------------------------------------

export function getCacheInfo(): CacheInfo {
  const dir = ensureDir()
  return { dir, dbPath: dbPath(dir), memoriesDir: join(dir, 'memories') }
}

/**
 * Move every entry from `from` into `to`. Tries a fast rename first; on a
 * cross-device move (different drive, or a cloud-synced folder on another volume)
 * falls back to a recursive copy + delete. Existing entries in `to` are left
 * untouched (never overwritten). Best-effort per entry.
 */
function moveAllContents(from: string, to: string): void {
  let entries: string[]
  try {
    entries = readdirSync(from)
  } catch {
    return // source unreadable/absent — nothing to move
  }
  mkdirSync(to, { recursive: true })
  for (const name of entries) {
    const src = join(from, name)
    const dest = join(to, name)
    if (existsSync(dest)) continue // keep whatever is already in the target
    try {
      renameSync(src, dest)
    } catch {
      // EXDEV / locked: copy then remove the original.
      try {
        cpSync(src, dest, { recursive: true })
        rmSync(src, { recursive: true, force: true })
      } catch {
        /* leave the source in place if we couldn't copy it */
      }
    }
  }
}

/** Recursively true if `dir` contains at least one `.md` file. */
function hasMarkdown(dir: string): boolean {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (hasMarkdown(join(dir, e.name))) return true
    } else if (e.name.toLowerCase().endsWith('.md')) {
      return true
    }
  }
  return false
}

/**
 * True if the folder already holds Agent Code cache data — the SQLite db and/or
 * any `.md` memory file. When this is the case the folder is loaded as-is and
 * nothing is moved into it.
 */
function hasCacheData(dir: string): boolean {
  return existsSync(dbPath(dir)) || hasMarkdown(dir)
}

/**
 * Point the store at a new cache folder and reload from it. The folder name is
 * always `agent-code`: if the user picks a folder already named that, it's used
 * as-is; otherwise an `agent-code` subfolder is created inside the chosen path.
 *
 * If the target already has cache data (the agent-code.db and/or any `.md`
 * memory), it's simply loaded as-is — nothing is moved, so existing data there is
 * never clobbered. ONLY when the target has none of those files do we move ALL
 * files from the current cache folder into it (db + memories + anything else), so
 * the user's data follows them to the new, empty location.
 *
 * No db handle is held open during the move — kv operations open/close per call —
 * so the .db file is free to be renamed/copied.
 */
export function setCacheDir(chosen: string): CacheInfo {
  const from = ensureDir()
  const target = basename(chosen) === APP_DIRNAME ? chosen : join(chosen, APP_DIRNAME)

  // Same folder selected → nothing to do.
  if (resolve(target) === resolve(from)) return getCacheInfo()

  mkdirSync(target, { recursive: true })
  // Move only into an empty target. If it already has the db and/or .md memories,
  // load it as-is.
  if (!hasCacheData(target)) moveAllContents(from, target)

  prepare(target) // ensure schema (no-op if the db was moved/already present)
  cacheDir = target
  writePointer(target)
  return getCacheInfo()
}

// ---- one-time migration from the old settings.json -------------------------

function migrateLegacyConfig(): void {
  try {
    const legacy = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(legacy)) return
    if (kvGet('config')) return // already have config in the db
    const raw = readFileSync(legacy, 'utf8')
    JSON.parse(raw) // validate it's JSON before storing
    kvSet('config', raw)
  } catch {
    /* no legacy file or unreadable — nothing to migrate */
  }
}
