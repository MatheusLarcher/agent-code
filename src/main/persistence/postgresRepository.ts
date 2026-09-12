import { randomUUID } from 'node:crypto'
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { ClientConfig, Pool, PoolClient } from 'pg'
import { parseStoredAppConfig } from './configData'
import { lockPostgresTransferRecords, postgresTransferClock, prepareTransferRecords, readPostgresTransferRecords, type TransferRecords } from './transferRecords'
import { hashAggregate, hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import { PostgresChangeFeed } from './postgresChangeFeed'
import { createPostgresSessionStore } from './postgresSessionStore'
import {
  decodePostgresJson,
  decodePostgresText,
  encodePostgresJsonParam,
  encodePostgresText
} from './postgresEncoding'
import {
  assertDeliverableKind,
  assertStepFinalStatus,
  assertStepKind,
  assertTaskFence,
  assertTaskTransition,
  normalizeTaskCreate,
  TASK_LEASE_TTL_MS,
  taskDeliverableFromRow,
  taskEventFromRow,
  taskFromRow,
  taskStepFromRow,
  LEASE_RELEASING_STATUSES,
  type TaskDeliverableRow,
  type TaskEventRow,
  type TaskRow,
  type TaskStepRow
} from '../tasks/taskModel'
import {
  assertProposalLease,
  assertMemoryProposalApplication,
  MEMORY_ENTRY_COLUMNS,
  MEMORY_PROPOSAL_COLUMNS,
  MEMORY_PROPOSAL_LEASE_TTL_MS,
  memoryEntryFromRow,
  memoryProposalFromRow,
  newMemoryId,
  normalizeMemoryEntryWrite,
  type MemoryEntryRow,
  type MemoryProposalRow
} from '../memory/memoryModel'
import {
  StorageError,
  type MemoryEntry,
  type MemoryEntryStatus,
  type MemoryEntryWrite,
  type MemoryProposal,
  type MemoryProposalClaim,
  type MemoryProposalCreate,
  type MemoryProposalQuery,
  type MemoryProposalSettle,
  type ApplicationSnapshot,
  type ConversationDelete,
  type ConversationLease,
  type ConversationRecord,
  type ConversationWrite,
  type ExportSnapshot,
  type KvAddress,
  type KvScope,
  type KvWrite,
  type LeaseFence,
  type PersistenceRepository,
  type RepositoryChange,
  type RepositoryChangeHandler,
  type VersionedConversation,
  type ConversationQuery,
  type ProjectConversationCount,
  type Task,
  type TaskClaim,
  type TaskClaimFilter,
  type TaskCreate,
  type TaskDeliverable,
  type TaskDeliverableAdd,
  type TaskEvent,
  type TaskEventAppend,
  type TaskQuery,
  type TaskStep,
  type TaskStepAppend,
  type TaskStepFinish,
  type TaskTransition,
  type VersionedKv
} from './types'

const TASK_COLUMNS = `id, conversation_id, project_cwd, title, goal, acceptance_json, status, owner_agent,
  write_scope_json, parent_task_id, attempts, max_attempts, lease_token, lease_expires_at, fencing_epoch,
  revision, created_at, updated_at`
const STEP_COLUMNS = `id, task_id, seq, kind, status, agent, sdk_session_id, started_at, finished_at, error_json,
  revision, created_at, updated_at`
const DELIVERABLE_COLUMNS = `id, task_id, step_id, kind, summary, payload_path, payload_hash, verified, verified_by,
  revision, created_at, updated_at`
const EVENT_COLUMNS = 'id, task_id, step_id, at, kind, data_json'

type LockedTaskRow = TaskRow & { lease_live: boolean | null }

function decodeTaskRow(row: TaskRow): TaskRow {
  return {
    ...row,
    title: decodePostgresText(row.title),
    goal: decodePostgresText(row.goal),
    acceptance_json: decodePostgresJson(normalizeJson(row.acceptance_json)),
    write_scope_json: decodePostgresJson(normalizeJson(row.write_scope_json))
  }
}

function decodeStepRow(row: TaskStepRow): TaskStepRow {
  return {
    ...row,
    error_json: row.error_json === null ? null : decodePostgresJson(normalizeJson(row.error_json))
  }
}

function decodeDeliverableRow(row: TaskDeliverableRow): TaskDeliverableRow {
  return { ...row, summary: decodePostgresText(row.summary) }
}

function decodeEventRow(row: TaskEventRow): TaskEventRow {
  return { ...row, data_json: decodePostgresJson(normalizeJson(row.data_json)) }
}

function decodeMemoryEntryRow(row: MemoryEntryRow): MemoryEntryRow {
  return {
    ...row,
    title: decodePostgresText(row.title),
    hook: decodePostgresText(row.hook),
    body: decodePostgresText(row.body)
  }
}

function decodeMemoryProposalRow(row: MemoryProposalRow): MemoryProposalRow {
  return {
    ...row,
    title: row.title === null ? null : decodePostgresText(row.title),
    hook: row.hook === null ? null : decodePostgresText(row.hook),
    body: row.body === null ? null : decodePostgresText(row.body),
    reason: row.reason === null ? null : decodePostgresText(row.reason)
  }
}

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

  async loadTransferRecords(): Promise<TransferRecords> {
    this.assertInitialized()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await lockPostgresTransferRecords(client)
      const records = await readPostgresTransferRecords(client)
      const snapshot = prepareTransferRecords(records, await postgresTransferClock(client))
      await client.query('COMMIT')
      return snapshot
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
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

  async verifyReadable(): Promise<void> {
    this.assertInitialized()
    // Uma linha de cada tabela que o boot depende: prova conexão, schema e
    // permissão de leitura sem trazer payload nenhum.
    await Promise.all([
      this.pool.query('SELECT 1 FROM global_kv LIMIT 1'),
      this.pool.query('SELECT 1 FROM device_kv WHERE installation_id = $1 LIMIT 1', [this.installationId]),
      this.pool.query('SELECT 1 FROM conversations LIMIT 1')
    ])
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

  async getKvMany(scope: KvScope, keys: string[]): Promise<VersionedKv[]> {
    this.assertInitialized()
    if (!keys.length) return []
    const result =
      scope === 'global'
        ? await this.pool.query<KvRow>(
            `SELECT key, value_text, revision, content_hash, updated_at FROM global_kv
             WHERE key = ANY($1::text[])`,
            [keys]
          )
        : await this.pool.query<KvRow>(
            `SELECT key, value_text, revision, content_hash, updated_at FROM device_kv
             WHERE installation_id = $1 AND key = ANY($2::text[])`,
            [this.installationId, keys]
          )
    return result.rows.map((row) => kv(row, scope))
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

  async loadConversations(options?: ConversationQuery): Promise<VersionedConversation[]> {
    this.assertInitialized()
    if (options?.ids && options.ids.length === 0) return []
    if (options?.cwds && options.cwds.length === 0) return []
    // The folder a conversation belongs to ON THIS DEVICE — same rule `conversation()`
    // applies to the row: the project's local path, else the device-state cwd.
    const cwdExpr = "COALESCE(pd.local_path, s.state->>'cwd', '')"
    const liveOnly =
      !options?.includeDeleted ||
      options.perProject !== undefined ||
      options.cwd !== undefined ||
      options.cwds !== undefined
    const params: unknown[] = [this.installationId]
    const clauses: string[] = []
    if (liveOnly) clauses.push('c.deleted_at IS NULL')
    if (options?.cwd !== undefined) {
      params.push(options.cwd)
      clauses.push(`${cwdExpr} = $${params.length}`)
    }
    if (options?.cwds !== undefined) {
      params.push(options.cwds)
      clauses.push(`${cwdExpr} = ANY($${params.length}::text[])`)
    }
    if (options?.ids) {
      params.push(options.ids)
      clauses.push(`c.conversation_id = ANY($${params.length}::text[])`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const columns = `c.conversation_id, c.payload, c.revision, c.content_hash, c.created_at, c.updated_at,
         c.deleted_at, s.state AS device_state, pd.local_path AS project_path`
    const joins = `FROM conversations c
       LEFT JOIN conversation_device_state s ON s.conversation_id = c.conversation_id AND s.installation_id = $1
       LEFT JOIN project_devices pd ON pd.project_id = c.project_id AND pd.installation_id = $1`
    if (options?.perProject !== undefined) {
      // DUAS consultas de propósito, e é a diferença entre abrir em segundos e
      // abrir em dezenas deles.
      //
      // A partição é por `COALESCE(pd.local_path, s.state->>'cwd', '')`, uma
      // expressão sobre TRÊS tabelas — nenhum índice pode cobri-la, então o
      // ROW_NUMBER() só sai de um Sort do resultado já juntado. Com `payload` na
      // lista do subselect, esse Sort carrega o payload junto: o servidor
      // "destoasta" a conversa inteira de TODA linha candidata (megabytes cada)
      // e derrama em arquivo temporário, só para depois jogar fora tudo que não
      // é uma das N mais recentes. Medido num PostgreSQL remoto: 37,5 s para
      // devolver 2,4 MB — o custo era ler o que seria descartado.
      //
      // Passo 1 roda a mesma janela sem payload nenhum (linhas minúsculas);
      // passo 2 busca só os ids escolhidos, pela chave primária.
      params.push(Math.max(1, Math.floor(options.perProject)))
      const ranked = await this.pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM (
           SELECT c.conversation_id,
                  ROW_NUMBER() OVER (PARTITION BY ${cwdExpr} ORDER BY c.updated_at DESC, c.conversation_id) AS rn
           ${joins} ${where}
         ) q WHERE q.rn <= $${params.length}`,
        params
      )
      if (!ranked.rowCount) return []
      const result = await this.pool.query<ConversationRow>(
        `SELECT ${columns} ${joins}
         WHERE c.conversation_id = ANY($2::text[])
         ORDER BY c.updated_at DESC, c.conversation_id`,
        [this.installationId, ranked.rows.map((row) => row.conversation_id)]
      )
      return result.rows.map(conversation)
    }
    const sql = `SELECT ${columns} ${joins} ${where} ORDER BY c.updated_at DESC, c.conversation_id`
    const result = await this.pool.query<ConversationRow>(sql, params)
    return result.rows.map(conversation)
  }

  async countConversationsByProject(): Promise<ProjectConversationCount[]> {
    this.assertInitialized()
    const result = await this.pool.query<{ cwd: string; total: string | number; updated_at: Date | string }>(
      `SELECT COALESCE(pd.local_path, s.state->>'cwd', '') AS cwd, COUNT(*) AS total,
              MAX(c.updated_at) AS updated_at
       FROM conversations c
       LEFT JOIN conversation_device_state s ON s.conversation_id = c.conversation_id AND s.installation_id = $1
       LEFT JOIN project_devices pd ON pd.project_id = c.project_id AND pd.installation_id = $1
       WHERE c.deleted_at IS NULL
       GROUP BY 1`,
      [this.installationId]
    )
    return result.rows.map((row) => ({
      cwd: row.cwd,
      total: Number(row.total),
      updatedAt: row.updated_at ? iso(row.updated_at) : new Date(0).toISOString()
    }))
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
        [write.id, projectId, encodePostgresJsonParam(normalizedShared), revision, contentHash, this.installationId]
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

  // -------------------------------------------------------------------------
  // Task ledger. Each mutation is one transaction that locks the task row
  // (FOR UPDATE), checks fence + state machine and appends its task_events row;
  // the trigger on task_events fans the change out to other installations.
  // -------------------------------------------------------------------------

  async createTask(input: TaskCreate): Promise<Task> {
    this.assertInitialized()
    const create = normalizeTaskCreate(input)
    return transaction(this.pool, async (client) => {
      if (create.parentTaskId) {
        const parent = await client.query('SELECT 1 FROM tasks WHERE id = $1', [create.parentTaskId])
        if (!parent.rowCount) {
          throw new StorageError('INVALID_PERSISTED_DATA', `Tarefa-mãe ${create.parentTaskId} não existe.`)
        }
      }
      const existing = await client.query('SELECT 1 FROM tasks WHERE id = $1', [create.id])
      if (existing.rowCount) throw new StorageError('REVISION_CONFLICT', `Tarefa ${create.id} já existe.`)
      await client.query(
        `INSERT INTO tasks(id, conversation_id, project_cwd, title, goal, acceptance_json, status, write_scope_json,
           parent_task_id, max_attempts, updated_by)
         VALUES($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)`,
        [
          create.id,
          create.conversationId,
          create.projectCwd,
          encodePostgresText(create.title),
          encodePostgresText(create.goal),
          encodePostgresJsonParam(create.acceptance),
          encodePostgresJsonParam(normalizeJson(create.writeScope)),
          create.parentTaskId,
          create.maxAttempts,
          this.installationId
        ]
      )
      await this.insertTaskEvent(client, create.id, null, 'created', { title: create.title })
      return this.requireTask(client, create.id)
    })
  }

  async claimTask(agentId: string, filter: TaskClaimFilter = {}): Promise<TaskClaim | null> {
    this.assertInitialized()
    if (!agentId.trim()) throw new TypeError('agentId é obrigatório para reivindicar uma tarefa.')
    return transaction(this.pool, async (client) => {
      // SKIP LOCKED: two installations claiming at once each get a different task.
      const candidate = await client.query<{ id: string; fencing_epoch: string | number }>(
        `SELECT id, fencing_epoch FROM tasks
         WHERE status = 'pending' AND attempts < max_attempts
           AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
           AND ($1::text IS NULL OR project_cwd = $1)
           AND ($2::text IS NULL OR id = $2)
         ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [filter.projectCwd ?? null, filter.taskId ?? null]
      )
      const row = candidate.rows[0]
      if (!row) return null
      const token = randomUUID()
      const fencingEpoch = Number(row.fencing_epoch) + 1
      const updated = await client.query<{ lease_expires_at: Date | string }>(
        `UPDATE tasks SET lease_token = $2, lease_expires_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
           fencing_epoch = $4, owner_agent = $5, attempts = attempts + 1, revision = revision + 1,
           updated_at = clock_timestamp(), updated_by = $6
         WHERE id = $1 RETURNING lease_expires_at`,
        [row.id, token, TASK_LEASE_TTL_MS, fencingEpoch, agentId, this.installationId]
      )
      await this.insertTaskEvent(client, row.id, null, 'claimed', { agent: agentId, fencingEpoch })
      return {
        task: await this.requireTask(client, row.id),
        token,
        fencingEpoch,
        expiresAt: iso(updated.rows[0].lease_expires_at)
      }
    })
  }

  async renewTaskLease(taskId: string, fence: LeaseFence): Promise<TaskClaim> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const locked = await this.lockTask(client, taskId)
      assertTaskFence(taskFromRow(locked), fence, locked.lease_live === true)
      const updated = await client.query<{ lease_expires_at: Date | string }>(
        `UPDATE tasks SET lease_expires_at = clock_timestamp() + ($2::int * interval '1 millisecond'),
           updated_at = clock_timestamp()
         WHERE id = $1 RETURNING lease_expires_at`,
        [taskId, TASK_LEASE_TTL_MS]
      )
      return {
        task: await this.requireTask(client, taskId),
        token: fence.token,
        fencingEpoch: fence.fencingEpoch,
        expiresAt: iso(updated.rows[0].lease_expires_at)
      }
    })
  }

  async transitionTask(input: TaskTransition): Promise<Task> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const locked = await this.lockTask(client, input.taskId)
      const current = taskFromRow(locked)
      assertTaskFence(current, input.fence, locked.lease_live === true)
      assertTaskTransition(current, input.from, input.to)
      const ownerAgent = input.to === 'pending' ? null : input.agent ?? current.ownerAgent
      await client.query(
        `UPDATE tasks SET status = $2, owner_agent = $3, revision = revision + 1, updated_at = clock_timestamp(),
           updated_by = $5,
           lease_expires_at = CASE WHEN $4::boolean THEN clock_timestamp() ELSE lease_expires_at END
         WHERE id = $1`,
        [input.taskId, input.to, ownerAgent, LEASE_RELEASING_STATUSES.has(input.to), this.installationId]
      )
      await this.insertTaskEvent(client, input.taskId, null, 'transition', {
        from: input.from,
        to: input.to,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.reason ? { reason: input.reason } : {})
      })
      return this.requireTask(client, input.taskId)
    })
  }

  async appendTaskStep(input: TaskStepAppend): Promise<TaskStep> {
    this.assertInitialized()
    assertStepKind(input.kind)
    return transaction(this.pool, async (client) => {
      const locked = await this.lockTask(client, input.taskId)
      assertTaskFence(taskFromRow(locked), input.fence, locked.lease_live === true)
      const id = randomUUID()
      const inserted = await client.query<{ seq: string | number }>(
        `INSERT INTO task_steps(id, task_id, seq, kind, status, agent, sdk_session_id)
         SELECT $1::text, $2::text, COALESCE(MAX(seq), 0) + 1, $3::text, 'running', $4::text, $5::text
         FROM task_steps WHERE task_id = $2::text
         RETURNING seq`,
        [id, input.taskId, input.kind, input.agent ?? null, input.sdkSessionId ?? null]
      )
      await this.insertTaskEvent(client, input.taskId, id, 'step_started', {
        kind: input.kind,
        seq: Number(inserted.rows[0].seq),
        ...(input.agent ? { agent: input.agent } : {})
      })
      return this.requireStep(client, id)
    })
  }

  async finishTaskStep(input: TaskStepFinish): Promise<TaskStep> {
    this.assertInitialized()
    assertStepFinalStatus(input.status)
    return transaction(this.pool, async (client) => {
      const stepRow = await client.query<TaskStepRow>(
        `SELECT ${STEP_COLUMNS} FROM task_steps WHERE id = $1 FOR UPDATE`,
        [input.stepId]
      )
      const step = stepRow.rows[0]
      if (!step) throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${input.stepId} não existe.`)
      const locked = await this.lockTask(client, step.task_id)
      assertTaskFence(taskFromRow(locked), input.fence, locked.lease_live === true)
      if (step.finished_at) {
        throw new StorageError('TASK_INVALID_TRANSITION', `Etapa ${input.stepId} já foi finalizada.`)
      }
      await client.query(
        `UPDATE task_steps SET status = $2, finished_at = clock_timestamp(), error_json = $3,
           revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $1`,
        [input.stepId, input.status, input.error ? encodePostgresJsonParam(normalizeJson(input.error)) : null]
      )
      await this.insertTaskEvent(client, step.task_id, input.stepId, 'step_finished', {
        kind: step.kind,
        seq: Number(step.seq),
        status: input.status,
        ...(input.error ? { error: input.error } : {})
      })
      return this.requireStep(client, input.stepId)
    })
  }

  async addTaskDeliverable(input: TaskDeliverableAdd): Promise<TaskDeliverable> {
    this.assertInitialized()
    assertDeliverableKind(input.kind)
    if (!input.summary.trim()) throw new StorageError('INVALID_PERSISTED_DATA', 'Entrega precisa de resumo.')
    return transaction(this.pool, async (client) => {
      const locked = await this.lockTask(client, input.taskId)
      assertTaskFence(taskFromRow(locked), input.fence, locked.lease_live === true)
      if (input.stepId) {
        const step = await client.query('SELECT 1 FROM task_steps WHERE id = $1 AND task_id = $2', [
          input.stepId,
          input.taskId
        ])
        if (!step.rowCount) {
          throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${input.stepId} não pertence à tarefa ${input.taskId}.`)
        }
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO task_deliverables(id, task_id, step_id, kind, summary, payload_path, payload_hash, verified, verified_by)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          input.taskId,
          input.stepId ?? null,
          input.kind,
          encodePostgresText(input.summary),
          input.payloadPath ?? null,
          input.payloadHash ?? null,
          input.verified === true,
          input.verifiedBy ?? null
        ]
      )
      await this.insertTaskEvent(client, input.taskId, input.stepId ?? null, 'deliverable_added', {
        deliverableId: id,
        kind: input.kind,
        summary: input.summary
      })
      const result = await client.query<TaskDeliverableRow>(
        `SELECT ${DELIVERABLE_COLUMNS} FROM task_deliverables WHERE id = $1`,
        [id]
      )
      return taskDeliverableFromRow(decodeDeliverableRow(result.rows[0]))
    })
  }

  async appendTaskEvent(input: TaskEventAppend): Promise<TaskEvent> {
    this.assertInitialized()
    if (!input.kind.trim()) throw new StorageError('INVALID_PERSISTED_DATA', 'Evento precisa de tipo.')
    return transaction(this.pool, async (client) => {
      await this.lockTask(client, input.taskId)
      if (input.stepId != null) {
        const step = await client.query('SELECT 1 FROM task_steps WHERE id = $1 AND task_id = $2', [
          input.stepId,
          input.taskId
        ])
        if (!step.rowCount) {
          throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${input.stepId} não pertence à tarefa ${input.taskId}.`)
        }
      }
      return this.insertTaskEvent(client, input.taskId, input.stepId ?? null, input.kind, input.data ?? {})
    })
  }

  async getTask(taskId: string): Promise<Task | null> {
    this.assertInitialized()
    const result = await this.pool.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [taskId])
    return result.rows[0] ? taskFromRow(decodeTaskRow(result.rows[0])) : null
  }

  async listTasks(query?: TaskQuery): Promise<Task[]> {
    this.assertInitialized()
    if (query?.ids && query.ids.length === 0) return []
    const clauses: string[] = []
    const params: unknown[] = []
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status]
      if (statuses.length === 0) return []
      params.push(statuses)
      clauses.push(`status = ANY($${params.length}::text[])`)
    }
    if (query?.projectCwd !== undefined) {
      params.push(query.projectCwd)
      clauses.push(`project_cwd = $${params.length}`)
    }
    if (query?.conversationId !== undefined) {
      params.push(query.conversationId)
      clauses.push(`conversation_id = $${params.length}`)
    }
    if (query?.parentTaskId !== undefined) {
      if (query.parentTaskId === null) clauses.push('parent_task_id IS NULL')
      else {
        params.push(query.parentTaskId)
        clauses.push(`parent_task_id = $${params.length}`)
      }
    }
    if (query?.ids) {
      params.push(query.ids)
      clauses.push(`id = ANY($${params.length}::text[])`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    let limit = ''
    if (query?.limit !== undefined) {
      params.push(Math.max(1, Math.floor(query.limit)))
      limit = ` LIMIT $${params.length}`
    }
    const result = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY created_at, id${limit}`,
      params
    )
    return result.rows.map((row) => taskFromRow(decodeTaskRow(row)))
  }

  async listTaskSteps(taskId: string): Promise<TaskStep[]> {
    this.assertInitialized()
    const result = await this.pool.query<TaskStepRow>(
      `SELECT ${STEP_COLUMNS} FROM task_steps WHERE task_id = $1 ORDER BY seq`,
      [taskId]
    )
    return result.rows.map((row) => taskStepFromRow(decodeStepRow(row)))
  }

  async listTaskDeliverables(taskId: string): Promise<TaskDeliverable[]> {
    this.assertInitialized()
    const result = await this.pool.query<TaskDeliverableRow>(
      `SELECT ${DELIVERABLE_COLUMNS} FROM task_deliverables WHERE task_id = $1 ORDER BY created_at, id`,
      [taskId]
    )
    return result.rows.map((row) => taskDeliverableFromRow(decodeDeliverableRow(row)))
  }

  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    this.assertInitialized()
    const result = await this.pool.query<TaskEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM task_events WHERE task_id = $1 ORDER BY ordinal`,
      [taskId]
    )
    return result.rows.map((row) => taskEventFromRow(decodeEventRow(row)))
  }

  /** Row lock + lease liveness evaluated on the server clock, so fence checks
   *  never depend on the client's wall time. */
  private async lockTask(client: PoolClient, taskId: string): Promise<LockedTaskRow> {
    const result = await client.query<LockedTaskRow>(
      `SELECT ${TASK_COLUMNS}, lease_expires_at > clock_timestamp() AS lease_live
       FROM tasks WHERE id = $1 FOR UPDATE`,
      [taskId]
    )
    const row = result.rows[0]
    if (!row) throw new StorageError('INVALID_PERSISTED_DATA', `Tarefa ${taskId} não existe.`)
    return { ...decodeTaskRow(row), lease_live: row.lease_live }
  }

  private async requireTask(client: PoolClient, taskId: string): Promise<Task> {
    const result = await client.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [taskId])
    if (!result.rows[0]) throw new StorageError('INVALID_PERSISTED_DATA', `Tarefa ${taskId} não existe.`)
    return taskFromRow(decodeTaskRow(result.rows[0]))
  }

  private async requireStep(client: PoolClient, stepId: string): Promise<TaskStep> {
    const result = await client.query<TaskStepRow>(`SELECT ${STEP_COLUMNS} FROM task_steps WHERE id = $1`, [stepId])
    if (!result.rows[0]) throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${stepId} não existe.`)
    return taskStepFromRow(decodeStepRow(result.rows[0]))
  }

  private async insertTaskEvent(
    client: PoolClient,
    taskId: string,
    stepId: string | null,
    kind: string,
    data: Record<string, unknown>
  ): Promise<TaskEvent> {
    const id = randomUUID()
    const result = await client.query<TaskEventRow>(
      `INSERT INTO task_events(id, task_id, step_id, kind, data_json, installation_id)
       VALUES($1, $2, $3, $4, $5, $6)
       RETURNING ${EVENT_COLUMNS}`,
      [id, taskId, stepId, kind, encodePostgresJsonParam(normalizeJson(data)), this.installationId]
    )
    return taskEventFromRow(decodeEventRow(result.rows[0]))
  }

  // -------------------------------------------------------------------------
  // Memory service. Same contract as SQLite; the trigger on memory_entries fans
  // every committed revision out to the other installations.
  // -------------------------------------------------------------------------

  async listMemoryEntries(query?: { status?: MemoryEntryStatus }): Promise<MemoryEntry[]> {
    this.assertInitialized()
    const result = query?.status
      ? await this.pool.query<MemoryEntryRow>(
          `SELECT ${MEMORY_ENTRY_COLUMNS} FROM memory_entries WHERE status = $1 ORDER BY rel_path`,
          [query.status]
        )
      : await this.pool.query<MemoryEntryRow>(`SELECT ${MEMORY_ENTRY_COLUMNS} FROM memory_entries ORDER BY rel_path`)
    return result.rows.map((row) => memoryEntryFromRow(decodeMemoryEntryRow(row)))
  }

  async getMemoryEntryByPath(relPath: string): Promise<MemoryEntry | null> {
    this.assertInitialized()
    const result = await this.pool.query<MemoryEntryRow>(
      `SELECT ${MEMORY_ENTRY_COLUMNS} FROM memory_entries WHERE rel_path = $1`,
      [relPath]
    )
    return result.rows[0] ? memoryEntryFromRow(decodeMemoryEntryRow(result.rows[0])) : null
  }

  async writeMemoryEntry(write: MemoryEntryWrite): Promise<MemoryEntry> {
    this.assertInitialized()
    return transaction(this.pool, (client) => this.writeMemoryEntryInTx(client, write))
  }

  async enqueueMemoryProposal(input: MemoryProposalCreate): Promise<MemoryProposal> {
    this.assertInitialized()
    const id = input.id?.trim() || newMemoryId()
    const result = await this.pool.query<MemoryProposalRow>(
      `INSERT INTO memory_proposals(id, op, rel_path, title, hook, body, scope, project_cwd, domain,
         origin_conversation_id, origin_message_id, origin_agent, status, proposed_by, expected_revision, updated_by)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $15)
       RETURNING ${MEMORY_PROPOSAL_COLUMNS}`,
      [
        id,
        input.op,
        input.relPath,
        input.title == null ? null : encodePostgresText(input.title),
        input.hook == null ? null : encodePostgresText(input.hook),
        input.body == null ? null : encodePostgresText(input.body),
        input.scope,
        input.projectCwd ?? null,
        input.domain ?? null,
        input.originConversationId ?? null,
        input.originMessageId ?? null,
        input.originAgent ?? null,
        input.proposedBy,
        input.expectedRevision ?? null,
        this.installationId
      ]
    )
    return memoryProposalFromRow(decodeMemoryProposalRow(result.rows[0]))
  }

  async claimMemoryProposal(): Promise<MemoryProposalClaim | null> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const candidate = await client.query<{ id: string }>(
        `SELECT id FROM memory_proposals
         WHERE status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
         ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
      )
      const row = candidate.rows[0]
      if (!row) return null
      const token = randomUUID()
      const updated = await client.query<MemoryProposalRow>(
        `UPDATE memory_proposals SET lease_token = $2,
           lease_expires_at = clock_timestamp() + ($3::int * interval '1 millisecond'),
           attempts = attempts + 1, updated_at = clock_timestamp(), updated_by = $4
         WHERE id = $1 RETURNING ${MEMORY_PROPOSAL_COLUMNS}`,
        [row.id, token, MEMORY_PROPOSAL_LEASE_TTL_MS, this.installationId]
      )
      const proposal = memoryProposalFromRow(decodeMemoryProposalRow(updated.rows[0]))
      return { proposal, token, expiresAt: proposal.leaseExpiresAt! }
    })
  }

  async settleMemoryProposal(input: MemoryProposalSettle): Promise<MemoryProposal> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const locked = await client.query<MemoryProposalRow & { lease_live: boolean | null }>(
        `SELECT ${MEMORY_PROPOSAL_COLUMNS}, lease_expires_at > clock_timestamp() AS lease_live
         FROM memory_proposals WHERE id = $1 FOR UPDATE`,
        [input.proposalId]
      )
      const row = locked.rows[0]
      if (!row) throw new StorageError('INVALID_PERSISTED_DATA', `Proposta de memória ${input.proposalId} não existe.`)
      const current = memoryProposalFromRow(decodeMemoryProposalRow(row))
      // Liveness comes from the server clock; assertProposalLease only compares token + status.
      assertProposalLease(
        { ...current, leaseExpiresAt: row.lease_live === true ? current.leaseExpiresAt : null },
        input.token,
        Number.NEGATIVE_INFINITY
      )
      if (input.outcome === 'applied') {
        assertMemoryProposalApplication(current, input.entry)
        const entryId = (await this.writeMemoryEntryInTx(client, input.entry)).id
        await client.query(
          `UPDATE memory_proposals SET status = 'applied', entry_id = $2, reason = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = clock_timestamp(), updated_by = $3 WHERE id = $1`,
          [input.proposalId, entryId ?? null, this.installationId]
        )
      } else if (input.outcome === 'requeue') {
        await client.query(
          `UPDATE memory_proposals SET reason = $2, lease_token = NULL, lease_expires_at = NULL,
             updated_at = clock_timestamp(), updated_by = $3 WHERE id = $1`,
          [input.proposalId, encodePostgresText(input.reason), this.installationId]
        )
      } else {
        await client.query(
          `UPDATE memory_proposals SET status = $2, reason = $3, lease_token = NULL, lease_expires_at = NULL,
             updated_at = clock_timestamp(), updated_by = $4 WHERE id = $1`,
          [input.proposalId, input.outcome, encodePostgresText(input.reason), this.installationId]
        )
      }
      const result = await client.query<MemoryProposalRow>(
        `SELECT ${MEMORY_PROPOSAL_COLUMNS} FROM memory_proposals WHERE id = $1`,
        [input.proposalId]
      )
      return memoryProposalFromRow(decodeMemoryProposalRow(result.rows[0]))
    })
  }

  async listMemoryProposals(query?: MemoryProposalQuery): Promise<MemoryProposal[]> {
    this.assertInitialized()
    const params: unknown[] = []
    let where = ''
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status]
      if (statuses.length === 0) return []
      params.push(statuses)
      where = `WHERE status = ANY($${params.length}::text[])`
    }
    let limit = ''
    if (query?.limit !== undefined) {
      params.push(Math.max(1, Math.floor(query.limit)))
      limit = ` LIMIT $${params.length}`
    }
    const result = await this.pool.query<MemoryProposalRow>(
      `SELECT ${MEMORY_PROPOSAL_COLUMNS} FROM memory_proposals ${where} ORDER BY created_at, id${limit}`,
      params
    )
    return result.rows.map((row) => memoryProposalFromRow(decodeMemoryProposalRow(row)))
  }

  async deleteMemoryProposal(id: string): Promise<boolean> {
    this.assertInitialized()
    return transaction(this.pool, async (client) => {
      const locked = await client.query<MemoryProposalRow>(
        `SELECT ${MEMORY_PROPOSAL_COLUMNS} FROM memory_proposals WHERE id = $1 FOR UPDATE`,
        [id]
      )
      const row = locked.rows[0]
      if (!row) return false
      const status = memoryProposalFromRow(decodeMemoryProposalRow(row)).status
      if (status !== 'conflict' && status !== 'rejected') {
        throw new StorageError('INVALID_PERSISTED_DATA', `Proposta de memória ${id} está em ${status}; só propostas em conflict/rejected podem ser descartadas.`)
      }
      await client.query('DELETE FROM memory_proposals WHERE id = $1', [id])
      return true
    })
  }

  private async writeMemoryEntryInTx(client: PoolClient, write: MemoryEntryWrite): Promise<MemoryEntry> {
    const next = normalizeMemoryEntryWrite(write)
    // A row lock cannot protect an absent path. Serialize inserts and updates on
    // the same path so concurrent creates deterministically fail revision CAS.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory:${next.relPath}`])
    const current = await client.query<{ revision: string | number }>(
      'SELECT revision FROM memory_entries WHERE rel_path = $1 FOR UPDATE',
      [next.relPath]
    )
    this.assertRevision(next.expectedRevision, current.rows[0]?.revision, `Memória ${next.relPath}`)
    const params = [
      next.relPath,
      encodePostgresText(next.title),
      encodePostgresText(next.hook),
      next.scope,
      next.projectCwd,
      next.domain,
      encodePostgresText(next.body),
      next.bodyHash,
      next.status,
      next.originConversationId,
      next.originMessageId,
      next.originAgent,
      next.supersedesId,
      this.installationId
    ]
    const result = current.rows[0]
      ? await client.query<MemoryEntryRow>(
          `UPDATE memory_entries SET title = $2, hook = $3, scope = $4, project_cwd = $5, domain = $6, body = $7,
             body_hash = $8, revision = revision + 1, status = $9, origin_conversation_id = $10, origin_message_id = $11,
             origin_agent = $12, supersedes_id = $13, updated_at = clock_timestamp(), updated_by = $14
           WHERE rel_path = $1 RETURNING ${MEMORY_ENTRY_COLUMNS}`,
          params
        )
      : await client.query<MemoryEntryRow>(
          `INSERT INTO memory_entries(rel_path, title, hook, scope, project_cwd, domain, body, body_hash, status,
             origin_conversation_id, origin_message_id, origin_agent, supersedes_id, updated_by, id)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING ${MEMORY_ENTRY_COLUMNS}`,
          [...params, newMemoryId()]
        )
    return memoryEntryFromRow(decodeMemoryEntryRow(result.rows[0]))
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
      [conversationId, this.installationId, encodePostgresJsonParam(normalizeJson(device))]
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
