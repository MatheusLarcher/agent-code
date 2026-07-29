import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Crash/sync-safe writes for the kv SQLite files.
 *
 * The cache folder normally lives inside OneDrive, and a cloud-sync client that
 * grabs (or restores) a .db mid-write leaves it "malformed" — SQLite then fails
 * every later open, so the app can neither read nor save that file again. The
 * same happens on a hard power loss during a commit.
 *
 * So we never write in place: the new content is built in a throwaway db under
 * the OS temp folder (local disk, never synced) and only then moved over the
 * real file in one step. The synced file is therefore always a complete,
 * consistent database — a partial write can only ever hit the temp copy.
 */

const KV_SCHEMA = 'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

/** Open a kv db with the rollback journal (no -wal/-shm side files linger). */
function openPrepared(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec(KV_SCHEMA)
  return db
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

/** True when the file opens and reads as a valid SQLite db. */
export function isReadableDb(path: string): boolean {
  if (!existsSync(path)) return false
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return true
  } catch {
    return false
  } finally {
    if (db) closeQuietly(db)
  }
}

/** Keep a damaged file instead of overwriting it — data may still be salvageable. */
export function quarantineDb(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    /* best-effort: if we can't move it aside, the write below replaces it */
  }
}

/** Move `tmp` onto `dest` in a single step, falling back to a copy across volumes. */
function replaceFile(tmp: string, dest: string): void {
  try {
    renameSync(tmp, dest)
  } catch {
    // EXDEV (temp on another drive) or a transient lock from the sync client.
    copyFileSync(tmp, dest)
  }
  // A rollback journal left behind by an interrupted in-place write would make
  // SQLite try to "recover" the file we just replaced.
  rmSync(`${dest}-journal`, { force: true })
}

export interface AtomicWriteOptions {
  /** Start from the current file's contents (needed when it holds other keys).
   *  A damaged current file is quarantined and the write starts empty. */
  seed?: boolean
  /** Quarantine the current file before replacing it (caller already knows it's
   *  unreadable — avoids re-probing it on every save). */
  quarantineFirst?: boolean
  /** Where the throwaway copy is built. Defaults to the OS temp folder; tests
   *  pass their own so they can assert on it without seeing other processes'
   *  files (a real app running in parallel writes there too). */
  tmpDir?: string
}

/**
 * Build the new database in temp and swap it in. `fn` receives a db that already
 * has the kv table (and the previous contents when `seed` is set).
 */
export function writeDbAtomically(
  dest: string,
  fn: (db: DatabaseSync) => void,
  { seed = false, quarantineFirst = false, tmpDir = tmpdir() }: AtomicWriteOptions = {}
): void {
  let tmp = join(tmpDir, `agent-code-${randomUUID()}.db`)
  let damaged = quarantineFirst
  try {
    if (seed && existsSync(dest)) {
      // Probe the copy: a damaged source must not become the new file.
      let probe: DatabaseSync | null = null
      try {
        copyFileSync(dest, tmp)
        probe = openPrepared(tmp)
      } catch {
        damaged = true
      } finally {
        if (probe) closeQuietly(probe)
      }
      if (damaged) {
        // Start from an empty db. Windows can still hold the failed open for a
        // moment, so fall back to a fresh temp name rather than fighting it.
        try {
          rmSync(tmp, { force: true })
        } catch {
          tmp = join(tmpDir, `agent-code-${randomUUID()}.db`)
        }
      }
    }
    const db = openPrepared(tmp)
    try {
      fn(db)
    } finally {
      closeQuietly(db)
    }
    if (damaged && existsSync(dest)) quarantineDb(dest)
    replaceFile(tmp, dest)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* already moved onto dest, or still held for a moment — the OS temp folder cleans it */
    }
  }
}
