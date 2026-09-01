import { randomUUID } from 'node:crypto'
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { ClientConfig, Pool, PoolClient } from 'pg'
import { parseStoredAppConfig } from './configData'
import { hashAggregate, hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import { PostgresChangeFeed } from './postgresChangeFeed'
import { createPostgresSessionStore } from './postgresSessionStore'
import { decodePostgresJson, decodePostgresText, encodePostgresJson, encodePostgresText } from './postgresEncoding'
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
  type PersistenceRepository,
  type RepositoryChange,
  type RepositoryChangeHandler,
  type VersionedConversation,
  type VersionedKv
} from './types'

interface KvRow {
  key: string
  value_text: string
  revision: string | number
  content_hash: string
  updated_at: Date | string
}
interface ConversationRow {
  conversation_id: string
  payload: ConversationRecord
  revision: string | number
  content_hash: string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  device_state?: ConversationRecord | null
  project_path?: string | null
}
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
function kv(row: KvRow, scope: KvAddress['scope']): VersionedKv {
  return {
    scope,
    key: row.key,
    value: decodePostgresText(row.value_text),
    revision: Number(row.revision),
    contentHash: row.content_hash,
    updatedAt: iso(row.updated_at)
  }
}

function conversation(row: ConversationRow): VersionedConversation {
  const deviceState = decodePostgresJson(normalizeJson(row.device_state ?? {})) as ConversationRecord
  const payload = decodePostgresJson(normalizeJson(row.payload)) as ConversationRecord
  return {
    id: row.conversation_id,
    payload: {
      ...payload,
      ...deviceState,
      cwd: typeof row.project_path === 'string'
        ? row.project_path
        : typeof deviceState.cwd === 'string' ? deviceState.cwd : ''
    },
    revision: Number(row.revision),
    contentHash: row.content_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {})
  }
}

function splitConversationPayload(payload: ConversationRecord): {
  shared: ConversationRecord
  device: ConversationRecord
} {
  const shared = { ...payload }
  const device: ConversationRecord = {}
  if (typeof shared.cwd === 'string') device.cwd = shared.cwd
  if (typeof shared.draft === 'string') device.draft = shared.draft
  delete shared.cwd
  delete shared.draft
  return { shared, device }
}

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export class PostgresRepository implements PersistenceRepository {
  readonly backend = 'postgres' as const
  private readonly handlers = new Set<RepositoryChangeHandler>()
  private readonly feed: PostgresChangeFeed
  private initialized = false

  constructor(
    private readonly pool: Pool,
    listenerConfig: ClientConfig,
    private readonly installationId: string,
    private readonly appVersion: string,
    onOffline: (error: unknown) => void = () => undefined
  ) {
    this.feed = new PostgresChangeFeed(
      listenerConfig,
      installationId,
      (changes) => this.emit(changes),
      onOffline
    )
  }

  async initialize(): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO installations(installation_id, app_version)
         VALUES($1, $2)
         ON CONFLICT(installation_id) DO UPDATE SET app_version = EXCLUDED.app_version, last_seen_at = clock_timestamp()`,
        [this.installationId, this.appVersion]
      )
      // A single Electron main process owns an installation. If it restarted
      // during a storage transition, its old in-memory tokens no longer exist
      // and must not block the first renderer autosave for another 60 seconds.
      await client.query(
        `UPDATE conversation_leases SET heartbeat_at = clock_timestamp(), expires_at = clock_timestamp()
         WHERE owner_installation_id = $1 AND expires_at > clock_timestamp()`,
        [this.installationId]
      )
    })
    await this.feed.start()
    this.initialized = true
  }

  async close(): Promise<void> {
    this.initialized = false
    this.handlers.clear()
    await this.feed.close()
    await this.pool.end()
  }

  async loadSnapshot(): Promise<ApplicationSnapshot> {
    const [global, device, conversations] = await Promise.all([
      this.pool.query<KvRow>('SELECT key, value_text, revision, content_hash, updated_at FROM global_kv ORDER BY key'),
      this.pool.query<KvRow>(
        `SELECT key, value_text, revision, content_hash, updated_at FROM device_kv
         WHERE installation_id = $1 ORDER BY key`,
        [this.installationId]
      ),
      this.loadConversations()
    ])
    const values = [...global.rows.map((row) => kv(row, 'global')), ...device.rows.map((row) => kv(row, 'device'))]
    const rawConfig = values.find((entry) => entry.scope === 'device' && entry.key === 'config')?.value ?? null
    return {
      backend: this.backend,
      config: parseStoredAppConfig(rawConfig),
      kv: values,
      conversations,
      watermark: this.watermark(values, conversations)
    }
  }

  async getKv(address: KvAddress): Promise<VersionedKv | null> {
    this.assertInitialized()
    const result =
      address.scope === 'global'
        ? await this.pool.query<KvRow>(
            'SELECT key, value_text, revision, content_hash, updated_at FROM global_kv WHERE key = $1',
            [address.key]
          )
        : await this.pool.query<KvRow>(
            `SELECT key, value_text, revision, content_hash, updated_at FROM device_kv
             WHERE installation_id = $1 AND key = $2`,
            [this.installationId, address.key]
          )
    return result.rows[0] ? kv(result.rows[0], address.scope) : null
  }

  async setKv(write: KvWrite): Promise<VersionedKv> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const address: KvAddress = { scope: write.scope, key: write.key }
      const current =
        write.scope === 'global'
          ? await client.query<KvRow>('SELECT * FROM global_kv WHERE key = $1 FOR UPDATE', [write.key])
          : await client.query<KvRow>(
              'SELECT * FROM device_kv WHERE installation_id = $1 AND key = $2 FOR UPDATE',
              [this.installationId, write.key]
            )
      this.assertRevision(write.expectedRevision, current.rows[0]?.revision, `KV ${write.scope}:${write.key}`)
      const revision = Number(current.rows[0]?.revision ?? 0) + 1
      const contentHash = hashText(write.value)
      const result =
        write.scope === 'global'
          ? await client.query<KvRow>(
              `INSERT INTO global_kv(key, value_text, revision, content_hash, updated_by)
               VALUES($1, $2, $3, $4, $5)
               ON CONFLICT(key) DO UPDATE SET value_text = EXCLUDED.value_text, revision = EXCLUDED.revision,
                 content_hash = EXCLUDED.content_hash, updated_at = clock_timestamp(), updated_by = EXCLUDED.updated_by
               RETURNING key, value_text, revision, content_hash, updated_at`,
              [write.key, encodePostgresText(write.value), revision, contentHash, this.installationId]
            )
          : await client.query<KvRow>(
              `INSERT INTO device_kv(installation_id, key, value_text, revision, content_hash)
               VALUES($1, $2, $3, $4, $5)
               ON CONFLICT(installation_id, key) DO UPDATE SET value_text = EXCLUDED.value_text,
                 revision = EXCLUDED.revision, content_hash = EXCLUDED.content_hash, updated_at = clock_timestamp()
               RETURNING key, value_text, revision, content_hash, updated_at`,
              [this.installationId, write.key, encodePostgresText(write.value), revision, contentHash]
            )
      return kv(result.rows[0], address.scope)
    })
  }

  async loadConversations(options?: { includeDeleted?: boolean }): Promise<VersionedConversation[]> {
    this.assertInitialized()
    const where = options?.includeDeleted ? '' : 'WHERE c.deleted_at IS NULL'
    const result = await this.pool.query<ConversationRow>(
      `SELECT c.conversation_id, c.payload, c.revision, c.content_hash, c.created_at, c.updated_at,
         c.deleted_at, s.state AS device_state, pd.local_path AS project_path
       FROM conversations c
       LEFT JOIN conversation_device_state s ON s.conversation_id = c.conversation_id AND s.installation_id = $1
       LEFT JOIN project_devices pd ON pd.project_id = c.project_id AND pd.installation_id = $1
       ${where} ORDER BY c.updated_at DESC, c.conversation_id`,
      [this.installationId]
    )
    return result.rows.map(conversation)
  }

  async upsertConversation(write: ConversationWrite): Promise<VersionedConversation> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      await this.assertFence(client, write.id, write.lease)
      const current = await client.query<ConversationRow>(
        'SELECT * FROM conversations WHERE conversation_id = $1 FOR UPDATE',
        [write.id]
      )
      this.assertRevision(write.expectedRevision, current.rows[0]?.revision, `Conversa ${write.id}`)
      const payload = normalizeJson(write.payload)
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || payload.id !== write.id) {
        throw new StorageError('INVALID_PERSISTED_DATA', 'Payload de conversa inválido.')
      }
      const { shared, device } = splitConversationPayload(payload as ConversationRecord)
      const projectId = await this.writeProjectMapping(client, shared, device)
      const normalizedShared = normalizeJson(shared)
      const contentHash = hashJson(normalizedShared)
      const existing = current.rows[0]
      if (existing && existing.content_hash === contentHash && !existing.deleted_at) {
        await this.writeDeviceConversationState(client, write.id, device)
        return conversation({ ...existing, device_state: device })
      }
      const revision = Number(existing?.revision ?? 0) + 1
      const result = await client.query<ConversationRow>(
        `INSERT INTO conversations(conversation_id, project_id, payload, revision, content_hash, updated_by)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(conversation_id) DO UPDATE SET payload = EXCLUDED.payload, revision = EXCLUDED.revision,
           project_id = EXCLUDED.project_id,
           content_hash = EXCLUDED.content_hash, updated_at = clock_timestamp(), deleted_at = NULL,
           updated_by = EXCLUDED.updated_by
         RETURNING conversation_id, payload, revision, content_hash, created_at, updated_at, deleted_at`,
        [write.id, projectId, encodePostgresJson(normalizedShared), revision, contentHash, this.installationId]
      )
      await this.writeDeviceConversationState(client, write.id, device)
      return conversation({ ...result.rows[0], device_state: device })
    })
  }

  async deleteConversation(input: ConversationDelete): Promise<VersionedConversation> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      await this.assertFence(client, input.id, input.lease)
      const current = await client.query<ConversationRow>(
        'SELECT * FROM conversations WHERE conversation_id = $1 FOR UPDATE',
        [input.id]
      )
      if (!current.rows[0]) throw new StorageError('REVISION_CONFLICT', `Conversa ${input.id} não existe.`)
      this.assertRevision(input.expectedRevision, current.rows[0].revision, `Conversa ${input.id}`)
      const result = await client.query<ConversationRow>(
        `UPDATE conversations SET revision = revision + 1, updated_at = clock_timestamp(),
           deleted_at = clock_timestamp(), updated_by = $2 WHERE conversation_id = $1
         RETURNING conversation_id, payload, revision, content_hash, created_at, updated_at, deleted_at`,
        [input.id, this.installationId]
      )
      return conversation(result.rows[0])
    })
  }

  async replaceAllConversations(records: ConversationRecord[]): Promise<void> {
    const current = await this.loadConversations({ includeDeleted: true })
    const byId = new Map(current.map((entry) => [entry.id, entry]))
    const seen = new Set<string>()
    for (const payload of records) {
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      await this.upsertConversation({
        id,
        payload,
        ...(byId.has(id) ? { expectedRevision: byId.get(id)!.revision } : {})
      })
    }
    for (const entry of current) {
      if (!entry.deletedAt && !seen.has(entry.id)) {
        await this.deleteConversation({ id: entry.id, expectedRevision: entry.revision })
      }
    }
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
    return createPostgresSessionStore(this.pool, conversationId)
  }

  async sessionResumeReady(conversationId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query<{ resume_ready: boolean }>(
      'SELECT resume_ready FROM sdk_sessions WHERE conversation_id = $1 AND session_id = $2',
      [conversationId, sessionId]
    )
    return result.rows[0]?.resume_ready === true
  }

  async markSessionResumeReady(
    conversationId: string,
    sessionId: string,
    ready: boolean,
    verifiedHash?: string
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE sdk_sessions SET resume_ready = $3, verified_hash = $4, mtime_ms = GREATEST(mtime_ms, $5)
       WHERE conversation_id = $1 AND session_id = $2`,
      [conversationId, sessionId, ready, verifiedHash ?? null, Date.now()]
    )
    if (!result.rowCount) throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'A sessão ainda não foi espelhada.')
  }

  async acquireConversationLease(conversationId: string): Promise<ConversationLease> {
    return transaction(this.pool, async (client) => {
      const current = await client.query<{
        owner_installation_id: string
        token: string
        fencing_epoch: string | number
        expires_at: Date | string
        valid: boolean
      }>(
        `SELECT owner_installation_id, token, fencing_epoch, expires_at, expires_at > clock_timestamp() AS valid
         FROM conversation_leases WHERE conversation_id = $1 FOR UPDATE`,
        [conversationId]
      )
      // Only ANOTHER installation blocks us. A live lease owned by this same
      // installation is our own orphan — the previous process died before it
      // could release it — and refusing it would lock the conversation out of
      // its own machine until the lease expired.
      if (current.rows[0]?.valid && current.rows[0].owner_installation_id !== this.installationId) {
        throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Esta conversa já possui um writer ativo.')
      }
      const fencingEpoch = Number(current.rows[0]?.fencing_epoch ?? 0) + 1
      const token = randomUUID()
      const result = await client.query<{ expires_at: Date | string }>(
        `INSERT INTO conversation_leases(
           conversation_id, owner_installation_id, token, fencing_epoch, expires_at
         ) VALUES($1, $2, $3, $4, clock_timestamp() + interval '60 seconds')
         ON CONFLICT(conversation_id) DO UPDATE SET owner_installation_id = EXCLUDED.owner_installation_id,
           token = EXCLUDED.token, fencing_epoch = EXCLUDED.fencing_epoch,
           acquired_at = clock_timestamp(), heartbeat_at = clock_timestamp(), expires_at = EXCLUDED.expires_at
         RETURNING expires_at`,
        [conversationId, this.installationId, token, fencingEpoch]
      )
      return {
        conversationId,
        ownerInstallationId: this.installationId,
        token,
        fencingEpoch,
        expiresAt: iso(result.rows[0].expires_at)
      }
    })
  }

  async renewConversationLease(lease: ConversationLease): Promise<ConversationLease> {
    const result = await this.pool.query<{ expires_at: Date | string }>(
      `UPDATE conversation_leases SET heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + interval '60 seconds'
       WHERE conversation_id = $1 AND owner_installation_id = $2 AND token = $3 AND fencing_epoch = $4
       RETURNING expires_at`,
      [lease.conversationId, this.installationId, lease.token, lease.fencingEpoch]
    )
    if (!result.rowCount) throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'O lease não pertence mais a esta instalação.')
    return { ...lease, expiresAt: iso(result.rows[0].expires_at) }
  }

  async releaseConversationLease(lease: ConversationLease): Promise<void> {
    await this.pool.query(
      `UPDATE conversation_leases SET heartbeat_at = clock_timestamp(), expires_at = clock_timestamp()
       WHERE conversation_id = $1 AND owner_installation_id = $2 AND token = $3 AND fencing_epoch = $4`,
      [lease.conversationId, this.installationId, lease.token, lease.fencingEpoch]
    )
  }

  subscribe(handler: RepositoryChangeHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private async assertFence(client: PoolClient, conversationId: string, fence?: ConversationWrite['lease']): Promise<void> {
    if (!fence) {
      // A lease guards against a REMOTE writer. Our own lease must not reject
      // this installation's plain writes (draft, title, streamed messages) —
      // those are the same user, and revision CAS already orders them.
      const held = await client.query(
        `SELECT 1 FROM conversation_leases WHERE conversation_id = $1
         AND owner_installation_id <> $2 AND expires_at > clock_timestamp()`,
        [conversationId, this.installationId]
      )
      if (held.rowCount) throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Esta conversa possui outro writer ativo.')
      return
    }
    const valid = await client.query(
      `SELECT 1 FROM conversation_leases WHERE conversation_id = $1 AND owner_installation_id = $2
       AND token = $3 AND fencing_epoch = $4 AND expires_at > clock_timestamp()`,
      [conversationId, this.installationId, fence.token, fence.fencingEpoch]
    )
    if (!valid.rowCount) throw new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
  }

  private async writeDeviceConversationState(
    client: PoolClient,
    conversationId: string,
    device: ConversationRecord
  ): Promise<void> {
    await client.query(
      `INSERT INTO conversation_device_state(conversation_id, installation_id, state, revision)
       VALUES($1, $2, $3, 1)
       ON CONFLICT(conversation_id, installation_id) DO UPDATE SET state = EXCLUDED.state,
         revision = conversation_device_state.revision + 1, updated_at = clock_timestamp()`,
      [conversationId, this.installationId, encodePostgresJson(normalizeJson(device))]
    )
  }

  private async writeProjectMapping(
    client: PoolClient,
    shared: ConversationRecord,
    device: ConversationRecord
  ): Promise<string | null> {
    const projectId = typeof shared.projectId === 'string' ? shared.projectId : ''
    const signature = typeof shared.projectSignature === 'string' ? shared.projectSignature : ''
    if (!projectId || !signature) return null
    const remoteGit = typeof shared.projectRemoteGit === 'string' ? shared.projectRemoteGit : null
    await client.query(
      `INSERT INTO projects(project_id, remote_git, signature)
       VALUES($1, $2, $3)
       ON CONFLICT(project_id) DO UPDATE SET remote_git = COALESCE(projects.remote_git, EXCLUDED.remote_git),
         updated_at = clock_timestamp()`,
      [projectId, remoteGit, signature]
    )
    if (typeof device.cwd === 'string' && device.cwd) {
      await client.query(
        `INSERT INTO project_devices(project_id, installation_id, local_path, signature)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(project_id, installation_id) DO UPDATE SET local_path = EXCLUDED.local_path,
           signature = EXCLUDED.signature, updated_at = clock_timestamp()`,
        [projectId, this.installationId, device.cwd, signature]
      )
    }
    return projectId
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new StorageError('STORAGE_OFFLINE', 'O repositório PostgreSQL está offline.', true)
  }

  private assertRevision(expected: number | undefined, actual: string | number | undefined, label: string): void {
    if (actual === undefined) {
      if (expected !== undefined && expected !== 0) throw new StorageError('REVISION_CONFLICT', `${label} não existe.`)
      return
    }
    if (expected === undefined || Number(expected) !== Number(actual)) {
      throw new StorageError('REVISION_CONFLICT', `${label} foi alterado por outra gravação.`)
    }
  }

  private watermark(values: VersionedKv[], conversations: VersionedConversation[]): string {
    return `postgres:${hashAggregate([
      ...values.map((entry) => ({ entity: `kv:${entry.scope}`, id: entry.key, contentHash: entry.contentHash })),
      ...conversations.map((entry) => ({ entity: 'conversation', id: entry.id, contentHash: entry.contentHash }))
    ])}`
  }

  private emit(changes: RepositoryChange[]): void {
    for (const handler of this.handlers) {
      try {
        handler(changes)
      } catch {
        // The durable change remains available in change_log. A consumer bug
        // must not be misclassified as a PostgreSQL outage.
      }
    }
  }
}
