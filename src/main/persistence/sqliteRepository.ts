import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SessionKey, SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { hashAggregate, hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import { parseStoredAppConfig } from './configData'
import { initializeSqliteV2, SQLITE_V2_SCHEMA } from './sqliteSchema'
import { createSqliteSessionStore, type SqliteStoreIo } from './sqliteSessionStore'
import { writeDbAtomically } from '../atomicDb'
import {
  StorageError,
  type ApplicationSnapshot,
  type ConversationDelete,
  type ConversationLease,
  type ConversationRecord,
  type ConversationWrite,
  type ExportSnapshot,
  type KvAddress,
  type KvWrite,
  type LeaseFence,
  type PersistenceRepository,
  type RepositoryChange,
  type RepositoryChangeHandler,
  type VersionedConversation,
  type VersionedKv
} from './types'

interface KvRow {
  scope: 'global' | 'device'
  key: string
  value_text: string
  revision: number
  content_hash: string
  updated_at: string
}

interface ConversationRow {
  id: string
  payload_json: string
  revision: number
  content_hash: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function close(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

function kvFromRow(row: KvRow): VersionedKv {
  return {
    scope: row.scope,
    key: row.key,
    value: row.value_text,
    revision: Number(row.revision),
    contentHash: row.content_hash,
    updatedAt: row.updated_at
  }
}

function conversationFromRow(row: ConversationRow): VersionedConversation {
  return {
    id: row.id,
    payload: JSON.parse(row.payload_json) as ConversationRecord,
    revision: Number(row.revision),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {})
  }
}

function scopeStore(base: SessionStore, conversationId: string): SessionStore {
  const scope = (key: SessionKey): SessionKey => ({
    ...key,
    projectKey: `conversation:${conversationId}`
  })
  return {
    append: (key, entries) => base.append(scope(key), entries),
    load: (key) => base.load(scope(key)),
    listSessions: base.listSessions ? () => base.listSessions!(`conversation:${conversationId}`) : undefined,
    listSessionSummaries: base.listSessionSummaries
      ? () => base.listSessionSummaries!(`conversation:${conversationId}`)
      : undefined,
    delete: base.delete ? (key) => base.delete!(scope(key)) : undefined,
    listSubkeys: base.listSubkeys ? (key) => base.listSubkeys!(scope(key)) : undefined
  }
}

export class SqliteRepository implements PersistenceRepository, SqliteStoreIo {
  readonly backend = 'sqlite' as const
  private initialized = false
  private changeId = 0
  private handlers = new Set<RepositoryChangeHandler>()
  private leases = new Map<string, ConversationLease>()
  private leaseEpochs = new Map<string, number>()

  constructor(
    private readonly cacheDir: string,
    private readonly dbPath: string,
    private readonly installationId: string
  ) {}

  async initialize(): Promise<void> {
    initializeSqliteV2(this.cacheDir, this.dbPath)
    this.initialized = true
  }

  async close(): Promise<void> {
    this.initialized = false
    this.handlers.clear()
    this.leases.clear()
    this.leaseEpochs.clear()
  }

  read<T>(fn: (db: DatabaseSync) => T): T {
    this.assertInitialized()
    const db = new DatabaseSync(this.dbPath, { readOnly: true })
    try {
      return fn(db)
    } finally {
      close(db)
    }
  }

  write<T>(fn: (db: DatabaseSync) => T): T {
    this.assertInitialized()
    let result: T | undefined
    writeDbAtomically(
      this.dbPath,
      (db) => {
        db.exec(SQLITE_V2_SCHEMA)
        result = fn(db)
      },
      { seed: true }
    )
    return result as T
  }

  async loadSnapshot(): Promise<ApplicationSnapshot> {
    const kv = this.read((db) => {
      const rows = db
        .prepare(
          `SELECT scope, key, value_text, revision, content_hash, updated_at
           FROM persistent_kv_v2 ORDER BY scope, key`
        )
        .all() as unknown as KvRow[]
      return rows.map(kvFromRow)
    })
    const conversations = await this.loadConversations()
    const rawConfig = kv.find((entry) => entry.scope === 'device' && entry.key === 'config')?.value ?? null
    return {
      backend: this.backend,
      config: parseStoredAppConfig(rawConfig),
      kv,
      conversations,
      watermark: this.watermark(kv, conversations)
    }
  }

  async getKv(address: KvAddress): Promise<VersionedKv | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          `SELECT scope, key, value_text, revision, content_hash, updated_at
           FROM persistent_kv_v2 WHERE scope = ? AND key = ?`
        )
        .get(address.scope, address.key) as KvRow | undefined
      return row ? kvFromRow(row) : null
    })
  }

  async setKv(write: KvWrite): Promise<VersionedKv> {
    const result = this.write((db) => {
      const current = db
        .prepare(
          `SELECT scope, key, value_text, revision, content_hash, updated_at
           FROM persistent_kv_v2 WHERE scope = ? AND key = ?`
        )
        .get(write.scope, write.key) as KvRow | undefined
      this.assertExpectedRevision(write.expectedRevision, current?.revision, `KV ${write.scope}:${write.key}`)
      const revision = Number(current?.revision ?? 0) + 1
      const updatedAt = new Date().toISOString()
      const contentHash = hashText(write.value)
      db.prepare(
        `INSERT INTO persistent_kv_v2(scope, key, value_text, revision, content_hash, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_text = excluded.value_text,
           revision = excluded.revision,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`
      ).run(write.scope, write.key, write.value, revision, contentHash, updatedAt)
      return {
        scope: write.scope,
        key: write.key,
        value: write.value,
        revision,
        contentHash,
        updatedAt
      }
    })
    this.emit(write.scope === 'global' ? 'global-kv' : 'device-kv', write.key, result.revision)
    return result
  }

  async loadConversations(options?: { includeDeleted?: boolean }): Promise<VersionedConversation[]> {
    return this.read((db) => {
      const where = options?.includeDeleted ? '' : 'WHERE deleted_at IS NULL'
      const rows = db
        .prepare(
          `SELECT id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
           FROM conversations_v2 ${where} ORDER BY updated_at DESC, id`
        )
        .all() as unknown as ConversationRow[]
      return rows.map(conversationFromRow)
    })
  }

  async upsertConversation(write: ConversationWrite): Promise<VersionedConversation> {
    this.assertLeaseFence(write.id, write.lease)
    const result = this.write((db) => this.upsertConversationInDb(db, write))
    this.emit('conversation', write.id, result.revision)
    return result
  }

  async deleteConversation(input: ConversationDelete): Promise<VersionedConversation> {
    this.assertLeaseFence(input.id, input.lease)
    const result = this.write((db) => {
      const current = this.conversationRow(db, input.id)
      if (!current) throw new StorageError('REVISION_CONFLICT', `Conversa ${input.id} não existe.`)
      this.assertExpectedRevision(input.expectedRevision, current.revision, `Conversa ${input.id}`)
      const revision = Number(current.revision) + 1
      const deletedAt = new Date().toISOString()
      db.prepare(
        `UPDATE conversations_v2
         SET revision = ?, updated_at = ?, deleted_at = ?
         WHERE id = ?`
      ).run(revision, deletedAt, deletedAt, input.id)
      return conversationFromRow({ ...current, revision, updated_at: deletedAt, deleted_at: deletedAt })
    })
    this.emit('conversation', input.id, result.revision)
    return result
  }

  async replaceAllConversations(records: ConversationRecord[]): Promise<void> {
    const changes = this.write((db) => {
      const currentRows = db
        .prepare(
          `SELECT id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
           FROM conversations_v2`
        )
        .all() as unknown as ConversationRow[]
      const current = new Map(currentRows.map((row) => [row.id, row]))
      const seen = new Set<string>()
      const changed: Array<{ id: string; revision: number }> = []
      for (const record of records) {
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (!id || seen.has(id)) {
          if (!id) throw new StorageError('INVALID_PERSISTED_DATA', 'Conversa sem ID não pode ser salva.')
          continue
        }
        seen.add(id)
        const row = current.get(id)
        const stored = this.upsertConversationInDb(db, {
          id,
          payload: record,
          ...(row ? { expectedRevision: Number(row.revision) } : {})
        })
        if (!row || row.content_hash !== stored.contentHash || row.deleted_at) {
          changed.push({ id, revision: stored.revision })
        }
      }
      const now = new Date().toISOString()
      for (const row of currentRows) {
        if (seen.has(row.id) || row.deleted_at) continue
        const revision = Number(row.revision) + 1
        db.prepare(
          `UPDATE conversations_v2 SET revision = ?, updated_at = ?, deleted_at = ? WHERE id = ?`
        ).run(revision, now, now, row.id)
        changed.push({ id: row.id, revision })
      }
      return changed
    })
    for (const change of changes) this.emit('conversation', change.id, change.revision)
  }

  async readExportSnapshot(): Promise<ExportSnapshot> {
    const conversations = await this.loadConversations()
    return {
      backend: this.backend,
      conversations: conversations.map((entry) => entry.payload),
      watermark: this.watermark([], conversations)
    }
  }

  createSessionStore(conversationId: string): SessionStore {
    if (!conversationId.trim()) throw new TypeError('conversationId é obrigatório para o SessionStore.')
    return scopeStore(createSqliteSessionStore(this), conversationId)
  }

  async sessionResumeReady(conversationId: string, sessionId: string): Promise<boolean> {
    const entries = await this.createSessionStore(conversationId).load({
      projectKey: conversationId,
      sessionId
    })
    return Boolean(entries?.length)
  }

  async markSessionResumeReady(): Promise<void> {
    // SQLite SessionStore commits synchronously inside append(); successful
    // presence is sufficient because there is no cross-device handoff.
  }

  async acquireConversationLease(conversationId: string): Promise<ConversationLease> {
    const current = this.leases.get(conversationId)
    // Only another installation blocks us; our own live lease is an orphan from
    // a session that never released it, and must not lock us out.
    if (
      current &&
      Date.parse(current.expiresAt) > Date.now() &&
      current.ownerInstallationId !== this.installationId
    ) {
      throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Esta conversa já está em execução.')
    }
    const fencingEpoch = (this.leaseEpochs.get(conversationId) ?? 0) + 1
    const lease: ConversationLease = {
      conversationId,
      ownerInstallationId: this.installationId,
      token: randomUUID(),
      fencingEpoch,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
    this.leaseEpochs.set(conversationId, fencingEpoch)
    this.leases.set(conversationId, lease)
    this.emit('lease', conversationId, lease.fencingEpoch)
    return lease
  }

  async renewConversationLease(lease: ConversationLease): Promise<ConversationLease> {
    const current = this.leases.get(lease.conversationId)
    if (!current || current.token !== lease.token || current.fencingEpoch !== lease.fencingEpoch) {
      throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'O lease desta conversa não pertence mais a este processo.')
    }
    const renewed = { ...current, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    this.leases.set(lease.conversationId, renewed)
    return renewed
  }

  async releaseConversationLease(lease: ConversationLease): Promise<void> {
    const current = this.leases.get(lease.conversationId)
    if (current?.token === lease.token && current.fencingEpoch === lease.fencingEpoch) {
      this.leases.delete(lease.conversationId)
      this.emit('lease', lease.conversationId, lease.fencingEpoch)
    }
  }

  private assertLeaseFence(conversationId: string, fence?: LeaseFence): void {
    const current = this.leases.get(conversationId)
    if (!current || Date.parse(current.expiresAt) <= Date.now()) return
    // Our own lease never rejects our own plain writes (draft, title, streamed
    // messages); revision CAS already orders them. Only a foreign lease fences.
    if (!fence) {
      if (current.ownerInstallationId !== this.installationId) {
        throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Esta conversa possui outro writer ativo.')
      }
      return
    }
    if (current.token !== fence.token || current.fencingEpoch !== fence.fencingEpoch) {
      throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Esta conversa possui outro writer ativo.')
    }
  }

  subscribe(handler: RepositoryChangeHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private assertInitialized(): void {
    if (!this.initialized || !existsSync(this.dbPath)) {
      throw new StorageError('STORAGE_OFFLINE', 'O repositório SQLite ainda não foi inicializado.')
    }
  }

  private assertExpectedRevision(expected: number | undefined, actual: number | undefined, label: string): void {
    if (actual === undefined) {
      if (expected !== undefined && expected !== 0) {
        throw new StorageError('REVISION_CONFLICT', `${label} não existe na revisão esperada.`)
      }
      return
    }
    if (expected === undefined || Number(expected) !== Number(actual)) {
      throw new StorageError('REVISION_CONFLICT', `${label} foi alterado por outra gravação.`)
    }
  }

  private conversationRow(db: DatabaseSync, id: string): ConversationRow | undefined {
    return db
      .prepare(
        `SELECT id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
         FROM conversations_v2 WHERE id = ?`
      )
      .get(id) as ConversationRow | undefined
  }

  private upsertConversationInDb(db: DatabaseSync, write: ConversationWrite): VersionedConversation {
    const payload = normalizeJson(write.payload)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new StorageError('INVALID_PERSISTED_DATA', 'Payload de conversa inválido.')
    }
    if (payload.id !== write.id) {
      throw new StorageError('INVALID_PERSISTED_DATA', 'O ID da conversa não corresponde ao payload.')
    }
    const current = this.conversationRow(db, write.id)
    this.assertExpectedRevision(write.expectedRevision, current?.revision, `Conversa ${write.id}`)
    const contentHash = hashJson(payload as JsonValue)
    if (current && current.content_hash === contentHash && !current.deleted_at) return conversationFromRow(current)

    const now = new Date().toISOString()
    const revision = Number(current?.revision ?? 0) + 1
    const createdAt = current?.created_at ?? now
    db.prepare(
      `INSERT INTO conversations_v2(
         id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
       ) VALUES(?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         revision = excluded.revision,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    ).run(write.id, JSON.stringify(payload), revision, contentHash, createdAt, now)
    return {
      id: write.id,
      payload: payload as ConversationRecord,
      revision,
      contentHash,
      createdAt,
      updatedAt: now
    }
  }

  private watermark(kv: VersionedKv[], conversations: VersionedConversation[]): string {
    return `sqlite:${hashAggregate([
      ...kv.map((entry) => ({ entity: `kv:${entry.scope}`, id: entry.key, contentHash: entry.contentHash })),
      ...conversations.map((entry) => ({ entity: 'conversation', id: entry.id, contentHash: entry.contentHash }))
    ])}`
  }

  private emit(entity: RepositoryChange['entity'], entityId: string, revision?: number): void {
    this.changeId += 1
    const change: RepositoryChange = {
      changeId: String(this.changeId),
      entity,
      entityId,
      ...(revision === undefined ? {} : { revision }),
      installationId: this.installationId
    }
    for (const handler of this.handlers) {
      try {
        handler([change])
      } catch {
        // A UI/listener failure happens after the SQLite commit and must not
        // turn a successful durable write into a rejected mutation.
      }
    }
  }
}
