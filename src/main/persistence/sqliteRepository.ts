import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { SessionKey, SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { hashAggregate, hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import { parseStoredAppConfig } from './configData'
import { decodeSqliteRecordRow, prepareTransferRecords, readSqliteTransferRecords, sqliteRecordSelectColumns, type TransferRecords } from './transferRecords'
import { initializeSqliteV2, SQLITE_SCHEMA } from './sqliteSchema'
import { createSqliteSessionStore, type SqliteStoreIo } from './sqliteSessionStore'
import { writeDbAtomically } from '../atomicDb'
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
  assertPoCreate,
  assertPoWrite,
  BOARD_COLUMNS,
  boardItemFromRow,
  boardItemId,
  compareBoardItems,
  normalizeSourceItems,
  type BoardItemRow
} from '../board/boardModel'
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
  type BoardItem,
  type BoardPoCreate,
  type BoardPoWrite,
  type BoardQuery,
  type BoardSyncInput,
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

// Keep SELECT expressions separate from INSERT column lists. Decoding the BLOB
// aliases before row mapping preserves embedded NUL without changing DB bytes.
const TASK_SELECT_COLUMNS = sqliteRecordSelectColumns('tasks')
const STEP_SELECT_COLUMNS = sqliteRecordSelectColumns('task_steps')
const DELIVERABLE_SELECT_COLUMNS = sqliteRecordSelectColumns('task_deliverables')
const EVENT_SELECT_COLUMNS = sqliteRecordSelectColumns('task_events')
const MEMORY_ENTRY_SELECT_COLUMNS = sqliteRecordSelectColumns('memory_entries')
const MEMORY_PROPOSAL_SELECT_COLUMNS = sqliteRecordSelectColumns('memory_proposals')

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
        db.exec(SQLITE_SCHEMA)
        result = fn(db)
      },
      { seed: true }
    )
    return result as T
  }

  async loadTransferRecords(): Promise<TransferRecords> {
    return this.read((db) => {
      db.exec('BEGIN')
      try {
        const records = readSqliteTransferRecords(db)
        const clock = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as { now: string }
        const snapshot = prepareTransferRecords(records, Date.parse(clock.now))
        db.exec('COMMIT')
        return snapshot
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    })
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

  async verifyReadable(): Promise<void> {
    this.read((db) => {
      db.prepare('SELECT 1 FROM persistent_kv_v2 LIMIT 1').get()
      db.prepare('SELECT 1 FROM conversations_v2 LIMIT 1').get()
      return null
    })
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

  async getKvMany(scope: KvScope, keys: string[]): Promise<VersionedKv[]> {
    if (!keys.length) return []
    return this.read((db) => {
      const placeholders = keys.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT scope, key, value_text, revision, content_hash, updated_at
           FROM persistent_kv_v2 WHERE scope = ? AND key IN (${placeholders})`
        )
        .all(scope, ...keys) as unknown as KvRow[]
      return rows.map(kvFromRow)
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

  async loadConversations(options?: ConversationQuery): Promise<VersionedConversation[]> {
    return this.read((db) => {
      if (options?.ids && options.ids.length === 0) return []
      if (options?.cwds && options.cwds.length === 0) return []
      // The per-project page and the "whole project" fetch only make sense over
      // live rows: a tombstone in one of the N slots would hide a real chat.
      const liveOnly =
        !options?.includeDeleted ||
        options.perProject !== undefined ||
        options.cwd !== undefined ||
        options.cwds !== undefined
      const clauses: string[] = []
      const params: unknown[] = []
      if (liveOnly) clauses.push('deleted_at IS NULL')
      if (options?.cwd !== undefined) {
        clauses.push("COALESCE(json_extract(payload_json, '$.cwd'), '') = ?")
        params.push(options.cwd)
      }
      if (options?.cwds !== undefined) {
        clauses.push(
          `COALESCE(json_extract(payload_json, '$.cwd'), '') IN (${options.cwds.map(() => '?').join(', ')})`
        )
        params.push(...options.cwds)
      }
      if (options?.ids) {
        clauses.push(`id IN (${options.ids.map(() => '?').join(', ')})`)
        params.push(...options.ids)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const columns = 'id, payload_json, revision, content_hash, created_at, updated_at, deleted_at'
      let sql: string
      if (options?.perProject !== undefined) {
        // Newest N of EACH project (the sidebar's first page), not newest N overall.
        sql = `SELECT ${columns} FROM (
                 SELECT ${columns},
                        ROW_NUMBER() OVER (
                          PARTITION BY COALESCE(json_extract(payload_json, '$.cwd'), '')
                          ORDER BY updated_at DESC, id
                        ) AS rn
                 FROM conversations_v2 ${where}
               ) WHERE rn <= ? ORDER BY updated_at DESC, id`
        params.push(Math.max(1, Math.floor(options.perProject)))
      } else {
        sql = `SELECT ${columns} FROM conversations_v2 ${where} ORDER BY updated_at DESC, id`
      }
      const rows = db.prepare(sql).all(...(params as never[])) as unknown as ConversationRow[]
      return rows.map(conversationFromRow)
    })
  }

  async countConversationsByProject(): Promise<ProjectConversationCount[]> {
    return this.read((db) => {
      const rows = db
        .prepare(
          `SELECT COALESCE(json_extract(payload_json, '$.cwd'), '') AS cwd, COUNT(*) AS total,
                  MAX(updated_at) AS updated_at
           FROM conversations_v2 WHERE deleted_at IS NULL GROUP BY 1`
        )
        .all() as unknown as Array<{ cwd: string; total: number | bigint; updated_at: string | null }>
      return rows.map((row) => ({
        cwd: String(row.cwd),
        total: Number(row.total),
        updatedAt: row.updated_at ?? new Date(0).toISOString()
      }))
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

  // -------------------------------------------------------------------------
  // Task ledger. Each mutation runs inside one atomic write (writeDbAtomically
  // serialises writers in-process), and every state change appends its
  // task_events row in that same write.
  // -------------------------------------------------------------------------

  async createTask(input: TaskCreate): Promise<Task> {
    const create = normalizeTaskCreate(input)
    const task = this.write((db) => {
      if (create.parentTaskId && !this.taskRow(db, create.parentTaskId)) {
        throw new StorageError('INVALID_PERSISTED_DATA', `Tarefa-mãe ${create.parentTaskId} não existe.`)
      }
      if (this.taskRow(db, create.id)) {
        throw new StorageError('REVISION_CONFLICT', `Tarefa ${create.id} já existe.`)
      }
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO tasks(${TASK_COLUMNS})
         VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, 0, ?, NULL, NULL, 0, 1, ?, ?)`
      ).run(
        create.id,
        create.conversationId,
        create.projectCwd,
        create.title,
        create.goal,
        JSON.stringify(create.acceptance),
        JSON.stringify(create.writeScope),
        create.parentTaskId,
        create.maxAttempts,
        now,
        now
      )
      this.insertTaskEvent(db, create.id, null, 'created', { title: create.title }, now)
      return taskFromRow(this.requireTaskRow(db, create.id))
    })
    this.emit('task', task.id, task.revision)
    return task
  }

  async claimTask(agentId: string, filter: TaskClaimFilter = {}): Promise<TaskClaim | null> {
    if (!agentId.trim()) throw new TypeError('agentId é obrigatório para reivindicar uma tarefa.')
    // Caminhos equivalentes vencem o caminho único (mesmo projeto, outro PC).
    const cwds = filter.projectCwds
    if (cwds !== undefined && cwds.length === 0) return null
    const projectCwd = cwds === undefined ? filter.projectCwd ?? null : null
    const taskId = filter.taskId ?? null
    const cwdClause = cwds === undefined ? '' : `AND project_cwd IN (${cwds.map(() => '?').join(', ')})`
    const claim = this.write((db) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const row = decodeSqliteRecordRow(db
        .prepare(
          `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
           WHERE status = 'pending' AND attempts < max_attempts
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             AND (? IS NULL OR project_cwd = ?)
             ${cwdClause}
             AND (? IS NULL OR id = ?)
           ORDER BY created_at, id LIMIT 1`
        )
        .get(nowIso, projectCwd, projectCwd, ...(cwds ?? []), taskId, taskId) as TaskRow | undefined)
      if (!row) return null
      const token = randomUUID()
      const fencingEpoch = Number(row.fencing_epoch) + 1
      const expiresAt = new Date(now.getTime() + TASK_LEASE_TTL_MS).toISOString()
      db.prepare(
        `UPDATE tasks SET lease_token = ?, lease_expires_at = ?, fencing_epoch = ?, owner_agent = ?,
           attempts = attempts + 1, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      ).run(token, expiresAt, fencingEpoch, agentId, nowIso, row.id)
      this.insertTaskEvent(db, row.id, null, 'claimed', { agent: agentId, fencingEpoch }, nowIso)
      return { task: taskFromRow(this.requireTaskRow(db, row.id)), token, fencingEpoch, expiresAt }
    })
    if (claim) this.emit('task', claim.task.id, claim.task.revision)
    return claim
  }

  async renewTaskLease(taskId: string, fence: LeaseFence): Promise<TaskClaim> {
    return this.write((db) => {
      const row = this.requireTaskRow(db, taskId)
      const task = taskFromRow(row)
      assertTaskFence(task, fence, this.taskLeaseLive(row))
      const now = Date.now()
      const expiresAt = new Date(now + TASK_LEASE_TTL_MS).toISOString()
      db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?').run(
        expiresAt,
        new Date(now).toISOString(),
        taskId
      )
      return { task: taskFromRow(this.requireTaskRow(db, taskId)), token: fence.token, fencingEpoch: fence.fencingEpoch, expiresAt }
    })
  }

  async transitionTask(input: TaskTransition): Promise<Task> {
    const task = this.write((db) => {
      const row = this.requireTaskRow(db, input.taskId)
      const current = taskFromRow(row)
      assertTaskFence(current, input.fence, this.taskLeaseLive(row))
      assertTaskTransition(current, input.from, input.to)
      const now = new Date().toISOString()
      const releaseLease = LEASE_RELEASING_STATUSES.has(input.to)
      const ownerAgent = input.to === 'pending' ? null : input.agent ?? current.ownerAgent
      db.prepare(
        `UPDATE tasks SET status = ?, owner_agent = ?, revision = revision + 1, updated_at = ?,
           lease_expires_at = CASE WHEN ? THEN ? ELSE lease_expires_at END
         WHERE id = ?`
      ).run(input.to, ownerAgent, now, releaseLease ? 1 : 0, now, input.taskId)
      this.insertTaskEvent(
        db,
        input.taskId,
        null,
        'transition',
        {
          from: input.from,
          to: input.to,
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.reason ? { reason: input.reason } : {})
        },
        now
      )
      return taskFromRow(this.requireTaskRow(db, input.taskId))
    })
    this.emit('task', task.id, task.revision)
    return task
  }

  async appendTaskStep(input: TaskStepAppend): Promise<TaskStep> {
    assertStepKind(input.kind)
    const step = this.write((db) => {
      const row = this.requireTaskRow(db, input.taskId)
      assertTaskFence(taskFromRow(row), input.fence, this.taskLeaseLive(row))
      const { seq } = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_steps WHERE task_id = ?')
        .get(input.taskId) as { seq: number | bigint }
      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO task_steps(${STEP_COLUMNS})
         VALUES(?, ?, ?, ?, 'running', ?, ?, ?, NULL, NULL, 1, ?, ?)`
      ).run(id, input.taskId, Number(seq), input.kind, input.agent ?? null, input.sdkSessionId ?? null, now, now, now)
      this.insertTaskEvent(
        db,
        input.taskId,
        id,
        'step_started',
        { kind: input.kind, seq: Number(seq), ...(input.agent ? { agent: input.agent } : {}) },
        now
      )
      return taskStepFromRow(this.requireStepRow(db, id))
    })
    this.emit('task', step.taskId)
    return step
  }

  async finishTaskStep(input: TaskStepFinish): Promise<TaskStep> {
    assertStepFinalStatus(input.status)
    const step = this.write((db) => {
      const stepRow = this.requireStepRow(db, input.stepId)
      const taskRow = this.requireTaskRow(db, stepRow.task_id)
      assertTaskFence(taskFromRow(taskRow), input.fence, this.taskLeaseLive(taskRow))
      if (stepRow.finished_at) {
        throw new StorageError('TASK_INVALID_TRANSITION', `Etapa ${input.stepId} já foi finalizada.`)
      }
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE task_steps SET status = ?, finished_at = ?, error_json = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      ).run(input.status, now, input.error ? JSON.stringify(input.error) : null, now, input.stepId)
      this.insertTaskEvent(
        db,
        stepRow.task_id,
        input.stepId,
        'step_finished',
        { kind: stepRow.kind, seq: Number(stepRow.seq), status: input.status, ...(input.error ? { error: input.error } : {}) },
        now
      )
      return taskStepFromRow(this.requireStepRow(db, input.stepId))
    })
    this.emit('task', step.taskId)
    return step
  }

  async addTaskDeliverable(input: TaskDeliverableAdd): Promise<TaskDeliverable> {
    assertDeliverableKind(input.kind)
    if (!input.summary.trim()) throw new StorageError('INVALID_PERSISTED_DATA', 'Entrega precisa de resumo.')
    const deliverable = this.write((db) => {
      const taskRow = this.requireTaskRow(db, input.taskId)
      assertTaskFence(taskFromRow(taskRow), input.fence, this.taskLeaseLive(taskRow))
      if (input.stepId) {
        const stepRow = this.stepRow(db, input.stepId)
        if (!stepRow || stepRow.task_id !== input.taskId) {
          throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${input.stepId} não pertence à tarefa ${input.taskId}.`)
        }
      }
      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO task_deliverables(${DELIVERABLE_COLUMNS})
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        id,
        input.taskId,
        input.stepId ?? null,
        input.kind,
        input.summary,
        input.payloadPath ?? null,
        input.payloadHash ?? null,
        input.verified ? 1 : 0,
        input.verifiedBy ?? null,
        now,
        now
      )
      this.insertTaskEvent(
        db,
        input.taskId,
        input.stepId ?? null,
        'deliverable_added',
        { deliverableId: id, kind: input.kind, summary: input.summary },
        now
      )
      const row = db
        .prepare(`SELECT ${DELIVERABLE_SELECT_COLUMNS} FROM task_deliverables WHERE id = ?`)
        .get(id) as unknown as TaskDeliverableRow
      return taskDeliverableFromRow(decodeSqliteRecordRow(row))
    })
    this.emit('task', deliverable.taskId)
    return deliverable
  }

  async appendTaskEvent(input: TaskEventAppend): Promise<TaskEvent> {
    if (!input.kind.trim()) throw new StorageError('INVALID_PERSISTED_DATA', 'Evento precisa de tipo.')
    const event = this.write((db) => {
      this.requireTaskRow(db, input.taskId)
      if (input.stepId != null) {
        const step = this.stepRow(db, input.stepId)
        if (!step || step.task_id !== input.taskId) {
          throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${input.stepId} não pertence à tarefa ${input.taskId}.`)
        }
      }
      return this.insertTaskEvent(db, input.taskId, input.stepId ?? null, input.kind, input.data ?? {}, new Date().toISOString())
    })
    this.emit('task', event.taskId)
    return event
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.read((db) => {
      const row = this.taskRow(db, taskId)
      return row ? taskFromRow(row) : null
    })
  }

  async recordProjectIdentity(row: {
    projectCwd: string
    projectId: string
    signature: string
  }): Promise<void> {
    this.write((db) => {
      db.prepare(
        `INSERT INTO task_project_identity(project_cwd, project_id, signature, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(project_cwd) DO UPDATE SET
           project_id = excluded.project_id,
           signature = excluded.signature,
           updated_at = excluded.updated_at`
      ).run(row.projectCwd, row.projectId, row.signature, new Date().toISOString())
      return null
    })
  }

  async projectCwdsForIdentity(projectId: string): Promise<string[]> {
    return this.read((db) => {
      const rows = db
        .prepare('SELECT project_cwd FROM task_project_identity WHERE project_id = ? ORDER BY project_cwd')
        .all(projectId) as unknown as Array<{ project_cwd: string }>
      return rows.map((row) => String(row.project_cwd))
    })
  }

  // -------------------------------------------------------------------------
  // Quadro de tarefas (board_items)
  // -------------------------------------------------------------------------

  async syncBoardItems(input: BoardSyncInput): Promise<BoardItem[]> {
    const items = normalizeSourceItems(input.items)
    // Snapshot vazio NÃO apaga o quadro: "esta sessão nunca usou tarefas" e "o
    // plano ficou vazio" são indistinguíveis aqui, e tratar um como o outro
    // torraria o quadro inteiro da conversa por uma leitura sem sorte.
    if (items.length === 0) {
      return this.listBoardItems({ projectIds: [input.projectId], conversationId: input.conversationId })
    }
    const changed = this.write((db) => {
      const now = new Date().toISOString()
      const touched: string[] = []
      // Statements preparados UMA vez fora do laço: o snapshot é reemitido a
      // cada avanço do plano, e recompilá-los por item multiplicava o trabalho
      // pelo tamanho do plano dentro de uma transação que segura o write lock.
      const selectOne = db.prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE id = ?`)
      const insertOne = db.prepare(
        `INSERT INTO board_items(${BOARD_COLUMNS})
         VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`
      )
      const updateOne = db.prepare(
        `UPDATE board_items SET
           project_id = ?, project_cwd = ?, source_title = ?, source_status = ?,
           active_form = ?, seq = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      )
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const item of items) {
          const id = boardItemId(input.conversationId, item.sourceId)
          const current = selectOne.get(id) as unknown as BoardItemRow | undefined
          if (!current) {
            insertOne.run(
              id,
              input.projectId,
              input.projectCwd,
              input.conversationId,
              item.sourceId,
              item.title,
              item.status,
              item.activeForm,
              item.seq,
              now,
              now
            )
            touched.push(id)
            continue
          }
          const same =
            current.source_title === item.title &&
            current.source_status === item.status &&
            (current.active_form ?? null) === item.activeForm &&
            Number(current.seq) === item.seq &&
            current.project_id === input.projectId
          if (same) continue
          // A ingestão escreve SÓ a camada do agente. Os campos `po_*` passam
          // intactos de propósito: é isso que impede a próxima leitura do
          // snapshot de desfazer, sem aviso, a correção do PO.
          updateOne.run(
            input.projectId,
            input.projectCwd,
            item.title,
            item.status,
            item.activeForm,
            item.seq,
            now,
            id
          )
          touched.push(id)
        }
        // O que sumiu do snapshot sumiu de verdade (o CLI reescreve a lista
        // toda). Só cartão de origem `agent`: o que o PO criou não tem
        // esqueleto no CLI e desapareceria a cada sincronização.
        const keep = items.map((item) => boardItemId(input.conversationId, item.sourceId))
        const placeholders = keep.map(() => '?').join(', ')
        const gone = db
          .prepare(
            `SELECT id FROM board_items
             WHERE conversation_id = ? AND origin = 'agent'
               AND id NOT IN (${placeholders})`
          )
          .all(input.conversationId, ...keep) as unknown as Array<{ id: string }>
        if (gone.length > 0) {
          db.prepare(
            `DELETE FROM board_items
             WHERE conversation_id = ? AND origin = 'agent' AND id NOT IN (${placeholders})`
          ).run(input.conversationId, ...keep)
          for (const row of gone) touched.push(String(row.id))
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return touched
    })
    // UM evento por sincronização, não um por cartão: cada `board:changed` faz
    // a tela recarregar a lista inteira, então N eventos por snapshot viravam
    // N recargas idênticas. O consumidor recarrega tudo de qualquer forma.
    if (changed.length > 0) this.emit('board', input.conversationId)
    return this.listBoardItems({ projectIds: [input.projectId], conversationId: input.conversationId })
  }

  async listBoardItems(query: BoardQuery): Promise<BoardItem[]> {
    // Lista vazia é "nenhum projeto", nunca "todos" — o contrário vazaria o
    // quadro de outro projeto, que é o que o filtro existe para impedir.
    if (!query.projectIds || query.projectIds.length === 0) return []
    return this.read((db) => {
      const clauses = [`project_id IN (${query.projectIds.map(() => '?').join(', ')})`]
      const params: string[] = [...query.projectIds]
      if (query.conversationId !== undefined) {
        clauses.push('conversation_id = ?')
        params.push(query.conversationId)
      }
      if (!query.includeDismissed) clauses.push('dismissed_at IS NULL')
      const rows = db
        .prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE ${clauses.join(' AND ')}`)
        .all(...params) as unknown as BoardItemRow[]
      return rows.map(boardItemFromRow).sort(compareBoardItems)
    })
  }

  async applyBoardPo(input: BoardPoWrite): Promise<BoardItem> {
    assertPoWrite(input)
    const item = this.write((db) => {
      const current = db
        .prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE id = ?`)
        .get(input.id) as unknown as BoardItemRow | undefined
      if (!current) throw new TypeError(`Cartão inexistente: ${input.id}`)
      const now = new Date().toISOString()
      const next = {
        poTitle: input.poTitle === undefined ? current.po_title : input.poTitle,
        poNote: input.poNote === undefined ? current.po_note : input.poNote,
        poStatus: input.poStatus === undefined ? current.po_status : input.poStatus,
        poReason: input.poReason === undefined ? current.po_reason : input.poReason
      }
      db.prepare(
        `UPDATE board_items SET
           po_title = ?, po_note = ?, po_status = ?, po_reason = ?, po_at = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ?`
      ).run(next.poTitle, next.poNote, next.poStatus, next.poReason, now, now, input.id)
      return boardItemFromRow(
        db.prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE id = ?`).get(input.id) as unknown as BoardItemRow
      )
    })
    this.emit('board', item.id, item.revision)
    return item
  }

  async createBoardPoItem(input: BoardPoCreate): Promise<BoardItem> {
    assertPoCreate(input)
    const item = this.write((db) => {
      const now = new Date().toISOString()
      const id = `bi-po-${randomUUID().slice(0, 12)}`
      const seq =
        Number(
          (
            db
              .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM board_items WHERE conversation_id = ?')
              .get(input.conversationId) as { next?: number }
          )?.next ?? 0
        ) || 0
      db.prepare(
        `INSERT INTO board_items(${BOARD_COLUMNS})
         VALUES(?, ?, ?, ?, 'po', NULL, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, NULL, 1, ?, ?)`
      ).run(
        id,
        input.projectId,
        input.projectCwd,
        input.conversationId,
        input.title,
        input.status,
        seq,
        input.reason,
        now,
        now,
        now
      )
      return boardItemFromRow(
        db.prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE id = ?`).get(id) as unknown as BoardItemRow
      )
    })
    this.emit('board', item.id, item.revision)
    return item
  }

  async dismissBoardItem(id: string, dismissed: boolean): Promise<BoardItem> {
    const item = this.write((db) => {
      const current = db.prepare('SELECT id FROM board_items WHERE id = ?').get(id)
      if (!current) throw new TypeError(`Cartão inexistente: ${id}`)
      const now = new Date().toISOString()
      db.prepare(
        'UPDATE board_items SET dismissed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?'
      ).run(dismissed ? now : null, now, id)
      return boardItemFromRow(
        db.prepare(`SELECT ${BOARD_COLUMNS} FROM board_items WHERE id = ?`).get(id) as unknown as BoardItemRow
      )
    })
    this.emit('board', item.id, item.revision)
    return item
  }

  async listTasks(query?: TaskQuery): Promise<Task[]> {
    return this.read((db) => {
      if (query?.ids && query.ids.length === 0) return []
      const clauses: string[] = []
      const params: unknown[] = []
      if (query?.status !== undefined) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status]
        if (statuses.length === 0) return []
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
        params.push(...statuses)
      }
      // A lista de caminhos equivalentes vence o caminho único: é o mesmo
      // projeto visto de PCs diferentes, e filtrar por um só esconderia metade
      // da fila. Lista vazia é "nenhum projeto", não "todos".
      if (query?.projectCwds !== undefined) {
        if (query.projectCwds.length === 0) return []
        clauses.push(`project_cwd IN (${query.projectCwds.map(() => '?').join(', ')})`)
        params.push(...query.projectCwds)
      } else if (query?.projectCwd !== undefined) {
        clauses.push('project_cwd = ?')
        params.push(query.projectCwd)
      }
      if (query?.conversationId !== undefined) {
        clauses.push('conversation_id = ?')
        params.push(query.conversationId)
      }
      if (query?.parentTaskId !== undefined) {
        if (query.parentTaskId === null) clauses.push('parent_task_id IS NULL')
        else {
          clauses.push('parent_task_id = ?')
          params.push(query.parentTaskId)
        }
      }
      if (query?.ids) {
        clauses.push(`id IN (${query.ids.map(() => '?').join(', ')})`)
        params.push(...query.ids)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = query?.limit !== undefined ? ` LIMIT ${Math.max(1, Math.floor(query.limit))}` : ''
      const rows = db
        .prepare(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks ${where} ORDER BY created_at, id${limit}`)
        .all(...(params as never[])) as unknown as TaskRow[]
      return rows.map((row) => taskFromRow(decodeSqliteRecordRow(row)))
    })
  }

  async listTaskSteps(taskId: string): Promise<TaskStep[]> {
    return this.read((db) => {
      const rows = db
        .prepare(`SELECT ${STEP_SELECT_COLUMNS} FROM task_steps WHERE task_id = ? ORDER BY seq`)
        .all(taskId) as unknown as TaskStepRow[]
      return rows.map((row) => taskStepFromRow(decodeSqliteRecordRow(row)))
    })
  }

  async listTaskDeliverables(taskId: string): Promise<TaskDeliverable[]> {
    return this.read((db) => {
      const rows = db
        .prepare(`SELECT ${DELIVERABLE_SELECT_COLUMNS} FROM task_deliverables WHERE task_id = ? ORDER BY created_at, rowid`)
        .all(taskId) as unknown as TaskDeliverableRow[]
      return rows.map((row) => taskDeliverableFromRow(decodeSqliteRecordRow(row)))
    })
  }

  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.read((db) => {
      const rows = db
        .prepare(`SELECT ${EVENT_SELECT_COLUMNS} FROM task_events WHERE task_id = ? ORDER BY rowid`)
        .all(taskId) as unknown as TaskEventRow[]
      return rows.map((row) => taskEventFromRow(decodeSqliteRecordRow(row)))
    })
  }

  private taskRow(db: DatabaseSync, id: string): TaskRow | undefined {
    return decodeSqliteRecordRow(db.prepare(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined)
  }

  private requireTaskRow(db: DatabaseSync, id: string): TaskRow {
    const row = this.taskRow(db, id)
    if (!row) throw new StorageError('INVALID_PERSISTED_DATA', `Tarefa ${id} não existe.`)
    return row
  }

  private stepRow(db: DatabaseSync, id: string): TaskStepRow | undefined {
    return decodeSqliteRecordRow(db.prepare(`SELECT ${STEP_SELECT_COLUMNS} FROM task_steps WHERE id = ?`).get(id) as TaskStepRow | undefined)
  }

  private requireStepRow(db: DatabaseSync, id: string): TaskStepRow {
    const row = this.stepRow(db, id)
    if (!row) throw new StorageError('INVALID_PERSISTED_DATA', `Etapa ${id} não existe.`)
    return row
  }

  private taskLeaseLive(row: TaskRow): boolean {
    return row.lease_expires_at !== null && Date.parse(String(row.lease_expires_at)) > Date.now()
  }

  private insertTaskEvent(
    db: DatabaseSync,
    taskId: string,
    stepId: string | null,
    kind: string,
    data: Record<string, unknown>,
    at: string
  ): TaskEvent {
    const id = randomUUID()
    const dataJson = JSON.stringify(normalizeJson(data))
    db.prepare(`INSERT INTO task_events(${EVENT_COLUMNS}) VALUES(?, ?, ?, ?, ?, ?)`).run(
      id,
      taskId,
      stepId,
      at,
      kind,
      dataJson
    )
    return { id, taskId, stepId, at, kind, data: JSON.parse(dataJson) as Record<string, unknown> }
  }

  // -------------------------------------------------------------------------
  // Memory service. `memory_entries` is keyed by rel_path with revision CAS;
  // `memory_proposals` is the queue the worker claims with a lease.
  // -------------------------------------------------------------------------

  async listMemoryEntries(query?: { status?: MemoryEntryStatus }): Promise<MemoryEntry[]> {
    return this.read((db) => {
      const where = query?.status ? 'WHERE status = ?' : ''
      const params = query?.status ? [query.status] : []
      const rows = db
        .prepare(`SELECT ${MEMORY_ENTRY_SELECT_COLUMNS} FROM memory_entries ${where} ORDER BY rel_path`)
        .all(...(params as never[])) as unknown as MemoryEntryRow[]
      return rows.map((row) => memoryEntryFromRow(decodeSqliteRecordRow(row)))
    })
  }

  async getMemoryEntryByPath(relPath: string): Promise<MemoryEntry | null> {
    return this.read((db) => {
      const row = this.memoryEntryRow(db, relPath)
      return row ? memoryEntryFromRow(row) : null
    })
  }

  async writeMemoryEntry(write: MemoryEntryWrite): Promise<MemoryEntry> {
    const entry = this.write((db) => this.writeMemoryEntryInDb(db, write))
    this.emit('memory', entry.relPath, entry.revision)
    return entry
  }

  async enqueueMemoryProposal(input: MemoryProposalCreate): Promise<MemoryProposal> {
    return this.write((db) => {
      const id = input.id?.trim() || newMemoryId()
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO memory_proposals(${MEMORY_PROPOSAL_COLUMNS})
         VALUES(?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, 0, NULL, NULL, ?, ?)`
      ).run(
        id,
        input.op,
        input.relPath,
        input.title ?? null,
        input.hook ?? null,
        input.body ?? null,
        input.scope,
        input.projectCwd ?? null,
        input.domain ?? null,
        input.originConversationId ?? null,
        input.originMessageId ?? null,
        input.originAgent ?? null,
        input.proposedBy,
        input.expectedRevision ?? null,
        now,
        now
      )
      return memoryProposalFromRow(this.requireMemoryProposalRow(db, id))
    })
  }

  async claimMemoryProposal(): Promise<MemoryProposalClaim | null> {
    return this.write((db) => {
      const now = new Date()
      const nowIso = now.toISOString()
      const row = decodeSqliteRecordRow(db
        .prepare(
          `SELECT ${MEMORY_PROPOSAL_SELECT_COLUMNS} FROM memory_proposals
           WHERE status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY created_at, id LIMIT 1`
        )
        .get(nowIso) as MemoryProposalRow | undefined)
      if (!row) return null
      const token = randomUUID()
      const expiresAt = new Date(now.getTime() + MEMORY_PROPOSAL_LEASE_TTL_MS).toISOString()
      db.prepare(
        `UPDATE memory_proposals SET lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ?`
      ).run(token, expiresAt, nowIso, row.id)
      return { proposal: memoryProposalFromRow(this.requireMemoryProposalRow(db, row.id)), token, expiresAt }
    })
  }

  async settleMemoryProposal(input: MemoryProposalSettle): Promise<MemoryProposal> {
    let written: MemoryEntry | null = null
    const proposal = this.write((db) => {
      const current = memoryProposalFromRow(this.requireMemoryProposalRow(db, input.proposalId))
      assertProposalLease(current, input.token, Date.now())
      const now = new Date().toISOString()
      if (input.outcome === 'applied') {
        assertMemoryProposalApplication(current, input.entry)
        written = this.writeMemoryEntryInDb(db, input.entry)
        const entryId = written.id
        db.prepare(
          `UPDATE memory_proposals SET status = 'applied', entry_id = ?, reason = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = ? WHERE id = ?`
        ).run(entryId ?? null, now, input.proposalId)
      } else if (input.outcome === 'requeue') {
        db.prepare(
          `UPDATE memory_proposals SET reason = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`
        ).run(input.reason, now, input.proposalId)
      } else {
        db.prepare(
          `UPDATE memory_proposals SET status = ?, reason = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`
        ).run(input.outcome, input.reason, now, input.proposalId)
      }
      return memoryProposalFromRow(this.requireMemoryProposalRow(db, input.proposalId))
    })
    if (written) this.emit('memory', (written as MemoryEntry).relPath, (written as MemoryEntry).revision)
    return proposal
  }

  async listMemoryProposals(query?: MemoryProposalQuery): Promise<MemoryProposal[]> {
    return this.read((db) => {
      const params: unknown[] = []
      let where = ''
      if (query?.status !== undefined) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status]
        if (statuses.length === 0) return []
        where = `WHERE status IN (${statuses.map(() => '?').join(', ')})`
        params.push(...statuses)
      }
      const limit = query?.limit !== undefined ? ` LIMIT ${Math.max(1, Math.floor(query.limit))}` : ''
      const rows = db
        .prepare(`SELECT ${MEMORY_PROPOSAL_SELECT_COLUMNS} FROM memory_proposals ${where} ORDER BY created_at, id${limit}`)
        .all(...(params as never[])) as unknown as MemoryProposalRow[]
      return rows.map((row) => memoryProposalFromRow(decodeSqliteRecordRow(row)))
    })
  }

  async deleteMemoryProposal(id: string): Promise<boolean> {
    return this.write((db) => {
      const row = decodeSqliteRecordRow(db.prepare(`SELECT ${MEMORY_PROPOSAL_SELECT_COLUMNS} FROM memory_proposals WHERE id = ?`).get(id) as MemoryProposalRow | undefined)
      if (!row) return false
      const status = memoryProposalFromRow(row).status
      if (status !== 'conflict' && status !== 'rejected') {
        throw new StorageError('INVALID_PERSISTED_DATA', `Proposta de memória ${id} está em ${status}; só propostas em conflict/rejected podem ser descartadas.`)
      }
      db.prepare('DELETE FROM memory_proposals WHERE id = ?').run(id)
      return true
    })
  }

  private memoryEntryRow(db: DatabaseSync, relPath: string): MemoryEntryRow | undefined {
    return decodeSqliteRecordRow(db.prepare(`SELECT ${MEMORY_ENTRY_SELECT_COLUMNS} FROM memory_entries WHERE rel_path = ?`).get(relPath) as MemoryEntryRow | undefined)
  }

  private requireMemoryProposalRow(db: DatabaseSync, id: string): MemoryProposalRow {
    const row = decodeSqliteRecordRow(db.prepare(`SELECT ${MEMORY_PROPOSAL_SELECT_COLUMNS} FROM memory_proposals WHERE id = ?`).get(id) as MemoryProposalRow | undefined)
    if (!row) throw new StorageError('INVALID_PERSISTED_DATA', `Proposta de memória ${id} não existe.`)
    return row
  }

  private writeMemoryEntryInDb(db: DatabaseSync, write: MemoryEntryWrite): MemoryEntry {
    const next = normalizeMemoryEntryWrite(write)
    const current = this.memoryEntryRow(db, next.relPath)
    this.assertExpectedRevision(next.expectedRevision, current ? Number(current.revision) : undefined, `Memória ${next.relPath}`)
    const now = new Date().toISOString()
    if (!current) {
      const id = newMemoryId()
      db.prepare(
        `INSERT INTO memory_entries(${MEMORY_ENTRY_COLUMNS})
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        next.relPath,
        next.title,
        next.hook,
        next.scope,
        next.projectCwd,
        next.domain,
        next.body,
        next.bodyHash,
        next.status,
        next.originConversationId,
        next.originMessageId,
        next.originAgent,
        next.supersedesId,
        now,
        now
      )
    } else {
      db.prepare(
        `UPDATE memory_entries SET title = ?, hook = ?, scope = ?, project_cwd = ?, domain = ?, body = ?, body_hash = ?,
           revision = revision + 1, status = ?, origin_conversation_id = ?, origin_message_id = ?, origin_agent = ?,
           supersedes_id = ?, updated_at = ?
         WHERE rel_path = ?`
      ).run(
        next.title,
        next.hook,
        next.scope,
        next.projectCwd,
        next.domain,
        next.body,
        next.bodyHash,
        next.status,
        next.originConversationId,
        next.originMessageId,
        next.originAgent,
        next.supersedesId,
        now,
        next.relPath
      )
    }
    return memoryEntryFromRow(this.memoryEntryRow(db, next.relPath)!)
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
