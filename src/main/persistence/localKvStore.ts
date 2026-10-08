import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isReadableDb, quarantineDb } from '../atomicDb'

/**
 * O SQLite pequeno desta máquina (`%LOCALAPPDATA%\agent-code\config.db`): as
 * chaves `store: 'local'` do keyRegistry — configuração, contas Claude e estado da
 * tela. Síncrono (node:sqlite) e separado do banco de dados: o app lê a config
 * antes e sem o PostgreSQL. Arquivo novo, de KB — nunca o agent-code.db legado.
 *
 * Fora de pasta sincronizada, então grava no lugar (WAL), sem a cópia inteira do
 * arquivo que o `writeDbAtomically` faz para sobreviver ao OneDrive: cada
 * gravação custa uma fração de milissegundo no processo main.
 */
export class LocalKvStore {
  private db: DatabaseSync | null = null

  constructor(private readonly path: string) {}

  get(key: string): string | null {
    const row = this.open().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  }

  getMany(keys: string[]): Map<string, string | null> {
    const out = new Map<string, string | null>()
    const select = this.open().prepare('SELECT value FROM kv WHERE key = ?')
    for (const key of keys) out.set(key, (select.get(key) as { value?: string } | undefined)?.value ?? null)
    return out
  }

  set(key: string, value: string): void {
    this.setMany([[key, value]])
  }

  /** Várias chaves numa transação só. */
  setMany(entries: Array<[string, string]>): void {
    if (!entries.length) return
    const db = this.open()
    const upsert = db.prepare(
      `INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    const now = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of entries) upsert.run(key, value, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Marcadores internos (ex.: a cópia única do banco já foi feita). */
  meta(name: string): string | null {
    const row = this.open().prepare('SELECT value FROM meta WHERE name = ?').get(name) as { value?: string } | undefined
    return row?.value ?? null
  }

  setMeta(name: string, value: string): void {
    this.open()
      .prepare('INSERT INTO meta(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .run(name, value)
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      /* já fechado */
    }
    this.db = null
  }

  private open(): DatabaseSync {
    if (this.db) return this.db
    mkdirSync(dirname(this.path), { recursive: true })
    // Arquivo danificado é posto de lado (nunca apagado) e recomeça vazio: sem
    // isso, toda abertura falharia e o app ficaria sem configuração nenhuma.
    if (existsSync(this.path) && !isReadableDb(this.path)) quarantineDb(this.path)
    const db = new DatabaseSync(this.path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db = db
    return db
  }
}
