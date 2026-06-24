import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Persistence layout (per user, NOT per project):
 *
 *  ~/.agent-code/location.json      ← pointer: ONLY the path of the cache folder
 *  <chosen>/agent-code/             ← cache folder (name fixed = the project name)
 *    ├─ agent-code.db               ← SQLite: all system data (config, android token,
 *    │                                 conversations…) as a simple key→JSON store
 *    └─ memories/                   ← .md memory files (used by the memory feature later)
 *
 * The cache folder holds ONLY the .db and the .md memories — no libraries. SQLite is
 * the built-in node:sqlite (no native/npm dependency), so nothing else lands there.
 */

const APP_DIRNAME = 'agent-code'
const POINTER_DIR = join(homedir(), '.agent-code')
const POINTER_FILE = join(POINTER_DIR, 'location.json')

let db: DatabaseSync | null = null
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

/** Open (creating if needed) the cache folder + its SQLite db, and the memories dir. */
function open(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memories'), { recursive: true })
  if (db) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  db = new DatabaseSync(join(dir, 'agent-code.db'))
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  cacheDir = dir
}

/**
 * Initialize the store. Reads the pointer; on first run defaults to Documents/agent-code
 * and migrates any legacy settings.json. Idempotent and lazily called by the kv helpers,
 * so call order doesn't matter.
 */
export function initStore(): void {
  if (db) return
  const saved = readPointer()
  const firstRun = !saved
  const dir = saved || defaultCacheDir()
  open(dir)
  writePointer(dir)
  if (firstRun) migrateLegacyConfig()
}

function ensure(): DatabaseSync {
  if (!db) initStore()
  return db as DatabaseSync
}

// ---- key→value (value is always a JSON string) ----------------------------

export function kvGet(key: string): string | null {
  const row = ensure().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value ?? null
}

export function kvSet(key: string, value: string): void {
  ensure()
    .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

// ---- cache folder management ----------------------------------------------

export function getCacheInfo(): CacheInfo {
  ensure()
  return { dir: cacheDir, dbPath: join(cacheDir, 'agent-code.db'), memoriesDir: join(cacheDir, 'memories') }
}

/**
 * Point the store at a new cache folder and reload from it. The folder name is
 * always `agent-code`: if the user picks a folder already named that, it's used
 * as-is; otherwise an `agent-code` subfolder is created inside the chosen path.
 * If the target already has a db/memories, they're simply loaded (open() opens
 * the existing db without wiping it).
 */
export function setCacheDir(chosen: string): CacheInfo {
  const target = basename(chosen) === APP_DIRNAME ? chosen : join(chosen, APP_DIRNAME)
  open(target)
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
