import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { foldSessionSummary, type SessionStoreEntry, type SessionSummaryEntry } from '@anthropic-ai/claude-agent-sdk'
import type { Pool, PoolClient } from 'pg'
import { hashAggregate, hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import { writeDbAtomically } from '../atomicDb'
import { SQLITE_V2_SCHEMA } from './sqliteSchema'
import { importSessions, readSessions, type SessionBundle } from './postgresSessionTransfer'
import { attachProjectIdentityForMigration } from './projectIdentity'
import { decodePostgresJson, encodePostgresJson, encodePostgresText } from './postgresEncoding'
import type {
  ApplicationSnapshot,
  PersistenceRepository,
  VersionedConversation,
  VersionedKv
} from './types'
import { StorageError } from './types'

interface ImportedItem {
  entity: string
  id: string
  contentHash: string
}

function scopedConversationPayload(payload: Record<string, unknown>): {
  shared: Record<string, unknown>
  device: Record<string, unknown>
} {
  const shared = { ...payload }
  const device: Record<string, unknown> = {}
  if (typeof shared.cwd === 'string') device.cwd = shared.cwd
  if (typeof shared.draft === 'string') device.draft = shared.draft
  delete shared.cwd
  delete shared.draft
  return { shared, device }
}

function messageArray(payload: Record<string, unknown>): unknown[] | null {
  return Array.isArray(payload.messages) ? payload.messages : null
}

function isPrefix(left: unknown[], right: unknown[]): boolean {
  if (left.length > right.length) return false
  return left.every((entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]))
}

function conflictPayload(source: VersionedConversation): { id: string; payload: Record<string, unknown> } {
  const id = `${source.id}-conflict-${source.contentHash.slice(0, 8)}`
  const title = typeof source.payload.title === 'string' && source.payload.title.trim() ? source.payload.title : 'Conversa'
  return {
    id,
    payload: {
      ...source.payload,
      id,
      title: `${title} (conflito importado)`,
      legacyConflictOf: source.id
    }
  }
}

async function importKv(
  client: PoolClient,
  entries: VersionedKv[],
  installationId: string,
  items: ImportedItem[]
): Promise<void> {
  for (const entry of entries) {
    if (entry.scope === 'global') {
      const existing = await client.query<{ content_hash: string }>(
        'SELECT content_hash FROM global_kv WHERE key = $1 FOR UPDATE',
        [entry.key]
      )
      if (!existing.rowCount) {
        await client.query(
          `INSERT INTO global_kv(key, value_text, revision, content_hash, updated_by)
           VALUES($1, $2, $3, $4, $5)`,
          [entry.key, encodePostgresText(entry.value), entry.revision, entry.contentHash, installationId]
        )
        items.push({ entity: 'global-kv', id: entry.key, contentHash: entry.contentHash })
      } else {
        items.push({ entity: 'global-kv', id: entry.key, contentHash: existing.rows[0].content_hash })
      }
      continue
    }
    await client.query(
      `INSERT INTO device_kv(installation_id, key, value_text, revision, content_hash)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT(installation_id, key) DO UPDATE SET value_text = EXCLUDED.value_text,
         revision = GREATEST(device_kv.revision + 1, EXCLUDED.revision),
         content_hash = EXCLUDED.content_hash, updated_at = clock_timestamp()`,
      [installationId, entry.key, encodePostgresText(entry.value), entry.revision, entry.contentHash]
    )
    items.push({ entity: 'device-kv', id: entry.key, contentHash: entry.contentHash })
  }
}

async function insertConversation(
  client: PoolClient,
  id: string,
  payload: Record<string, unknown>,
  contentHash: string,
  installationId: string,
  deletedAt?: string,
  deviceState: Record<string, unknown> = {}
): Promise<void> {
  const projectId = await writeProjectMapping(client, payload, deviceState, installationId)
  await client.query(
    `INSERT INTO conversations(
       conversation_id, project_id, payload, revision, content_hash, deleted_at, updated_by
     ) VALUES($1, $2, $3, 1, $4, $5, $6)
     ON CONFLICT(conversation_id) DO UPDATE SET payload = EXCLUDED.payload,
       project_id = EXCLUDED.project_id,
       revision = conversations.revision + 1, content_hash = EXCLUDED.content_hash,
       deleted_at = EXCLUDED.deleted_at, updated_at = clock_timestamp(), updated_by = EXCLUDED.updated_by`,
    [id, projectId, encodePostgresJson(normalizeJson(payload)), contentHash, deletedAt ?? null, installationId]
  )
  await writeDeviceState(client, id, installationId, deviceState)
}

async function writeProjectMapping(
  client: PoolClient,
  shared: Record<string, unknown>,
  device: Record<string, unknown>,
  installationId: string
): Promise<string | null> {
  const projectId = typeof shared.projectId === 'string' ? shared.projectId : ''
  const signature = typeof shared.projectSignature === 'string' ? shared.projectSignature : ''
  if (!projectId || !signature) return null
  await client.query(
    `INSERT INTO projects(project_id, remote_git, signature)
     VALUES($1, $2, $3)
     ON CONFLICT(project_id) DO UPDATE SET remote_git = COALESCE(projects.remote_git, EXCLUDED.remote_git),
       updated_at = clock_timestamp()`,
    [projectId, typeof shared.projectRemoteGit === 'string' ? shared.projectRemoteGit : null, signature]
  )
  if (typeof device.cwd === 'string' && device.cwd) {
    await client.query(
      `INSERT INTO project_devices(project_id, installation_id, local_path, signature)
       VALUES($1, $2, $3, $4)
       ON CONFLICT(project_id, installation_id) DO UPDATE SET local_path = EXCLUDED.local_path,
         signature = EXCLUDED.signature, updated_at = clock_timestamp()`,
      [projectId, installationId, device.cwd, signature]
    )
  }
  return projectId
}

async function writeDeviceState(
  client: PoolClient,
  id: string,
  installationId: string,
  deviceState: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_device_state(conversation_id, installation_id, state, revision)
     VALUES($1, $2, $3, 1)
     ON CONFLICT(conversation_id, installation_id) DO UPDATE SET state = EXCLUDED.state,
       revision = conversation_device_state.revision + 1, updated_at = clock_timestamp()`,
    [id, installationId, encodePostgresJson(normalizeJson(deviceState))]
  )
}

async function importConversations(
  client: PoolClient,
  source: VersionedConversation[],
  installationId: string,
  items: ImportedItem[]
): Promise<void> {
  for (const entry of source) {
    const scoped = scopedConversationPayload(entry.payload)
    const sourceHash = hashJson(normalizeJson(scoped.shared))
    const existing = await client.query<{ payload: Record<string, unknown>; content_hash: string; deleted_at: Date | null }>(
      'SELECT payload, content_hash, deleted_at FROM conversations WHERE conversation_id = $1 FOR UPDATE',
      [entry.id]
    )
    const current = existing.rows[0]
    if (!current) {
      await insertConversation(client, entry.id, scoped.shared, sourceHash, installationId, entry.deletedAt, scoped.device)
      items.push({ entity: 'conversation', id: entry.id, contentHash: sourceHash })
      continue
    }
    const targetPayload = decodePostgresJson(normalizeJson(current.payload)) as Record<string, unknown>
    if (current.content_hash === sourceHash) {
      await writeProjectMapping(client, targetPayload, scoped.device, installationId)
      await writeDeviceState(client, entry.id, installationId, scoped.device)
      items.push({ entity: 'conversation', id: entry.id, contentHash: current.content_hash })
      continue
    }
    const sourceMessages = messageArray(scoped.shared)
    const targetMessages = messageArray(targetPayload)
    if (sourceMessages && targetMessages && isPrefix(sourceMessages, targetMessages)) {
      await writeProjectMapping(client, targetPayload, scoped.device, installationId)
      await writeDeviceState(client, entry.id, installationId, scoped.device)
      items.push({ entity: 'conversation', id: entry.id, contentHash: current.content_hash })
      continue
    }
    if (sourceMessages && targetMessages && isPrefix(targetMessages, sourceMessages)) {
      await insertConversation(client, entry.id, scoped.shared, sourceHash, installationId, entry.deletedAt, scoped.device)
      items.push({ entity: 'conversation', id: entry.id, contentHash: sourceHash })
      continue
    }
    const conflict = conflictPayload(entry)
    const conflictScoped = scopedConversationPayload(conflict.payload)
    const normalized = normalizeJson(conflictScoped.shared)
    const conflictHash = hashJson(normalized as JsonValue)
    await insertConversation(client, conflict.id, conflictScoped.shared, conflictHash, installationId, entry.deletedAt, conflictScoped.device)
    items.push({ entity: 'conversation', id: conflict.id, contentHash: conflictHash })
  }
}

async function verifyItems(client: PoolClient, items: ImportedItem[], installationId: string): Promise<void> {
  for (const item of items) {
    if (item.entity === 'sdk-session') {
      const [conversationId, sessionId] = item.id.split(':', 2)
      const rows = await client.query<{ subpath: string; entry: SessionStoreEntry }>(
        `SELECT subpath, entry FROM sdk_session_entries
         WHERE conversation_id = $1 AND session_id = $2 ORDER BY subpath, sequence`,
        [conversationId, sessionId]
      )
      const paths: SessionBundle['paths'] = []
      for (const row of rows.rows) {
        let path = paths.find((entry) => (entry.subpath ?? '') === row.subpath)
        if (!path) { path = row.subpath ? { subpath: row.subpath, entries: [] } : { entries: [] }; paths.push(path) }
        path.entries.push(decodePostgresJson(normalizeJson(row.entry)) as SessionStoreEntry)
      }
      if (hashJson(normalizeJson(paths)) !== item.contentHash) {
        throw new StorageError('MIGRATION_VERIFICATION_FAILED', `Falha ao verificar ${item.entity}:${item.id}.`)
      }
      continue
    }
    const result =
      item.entity === 'global-kv'
        ? await client.query<{ content_hash: string }>('SELECT content_hash FROM global_kv WHERE key = $1', [item.id])
        : item.entity === 'device-kv'
          ? await client.query<{ content_hash: string }>(
              'SELECT content_hash FROM device_kv WHERE installation_id = $1 AND key = $2',
              [installationId, item.id]
            )
          : await client.query<{ content_hash: string }>(
              'SELECT content_hash FROM conversations WHERE conversation_id = $1',
              [item.id]
            )
    if (result.rows[0]?.content_hash !== item.contentHash) {
      throw new StorageError('MIGRATION_VERIFICATION_FAILED', `Falha ao verificar ${item.entity}:${item.id}.`)
    }
  }
}

export async function importRepositoryToPostgres(
  pool: Pool,
  source: PersistenceRepository,
  installationId: string,
  transitionId: string
): Promise<{ migrationRunId: string; sourceHash: string; targetHash: string }> {
  const [snapshot, rawConversations] = await Promise.all([
    source.loadSnapshot(),
    source.loadConversations({ includeDeleted: true })
  ])
  const conversations = await Promise.all(rawConversations.map(async (entry) => ({
    ...entry,
    payload: await attachProjectIdentityForMigration(entry.payload)
  })))
  const sessions = await readSessions(source, conversations)
  // The legacy monolithic config may contain plaintext provider secrets. The
  // field-scoped keys have already been migrated (and sensitive values wrapped
  // by safeStorage), so this obsolete blob must never cross into PostgreSQL.
  const transferableKv = snapshot.kv.filter((entry) => entry.key !== 'config')
  const sourceItems: ImportedItem[] = [
    ...transferableKv.map((entry) => ({ entity: `${entry.scope}-kv`, id: entry.key, contentHash: entry.contentHash })),
    ...conversations.map((entry) => ({ entity: 'conversation', id: entry.id, contentHash: entry.contentHash })),
    ...sessions.map((session) => ({
      entity: 'sdk-session',
      id: `${session.conversationId}:${session.sessionId}`,
      contentHash: hashJson(normalizeJson(session.paths))
    }))
  ]
  const sourceHash = hashAggregate(sourceItems)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const prior = await client.query<{ migration_run_id: string; source_hash: string; target_hash: string }>(
      `SELECT migration_run_id, source_hash, target_hash FROM migration_runs
       WHERE transition_id = $1 AND direction = 'sqlite-to-postgres' AND status = 'committed'`,
      [transitionId]
    )
    if (prior.rows[0]) {
      await client.query('ROLLBACK')
      return {
        migrationRunId: prior.rows[0].migration_run_id,
        sourceHash: prior.rows[0].source_hash,
        targetHash: prior.rows[0].target_hash
      }
    }
    const migrationRunId = randomUUID()
    await client.query(
      `INSERT INTO migration_runs(migration_run_id, transition_id, installation_id, direction, status, source_hash)
       VALUES($1, $2, $3, 'sqlite-to-postgres', 'running', $4)`,
      [migrationRunId, transitionId, installationId, sourceHash]
    )
    const imported: ImportedItem[] = []
    await importKv(client, transferableKv, installationId, imported)
    await importConversations(client, conversations, installationId, imported)
    imported.push(...await importSessions(client, sessions, installationId))
    await verifyItems(client, imported, installationId)
    for (const item of imported) {
      await client.query(
        `INSERT INTO migration_items(migration_run_id, entity, entity_id, content_hash)
         VALUES($1, $2, $3, $4)`,
        [migrationRunId, item.entity, item.id, item.contentHash]
      )
    }
    const targetHash = hashAggregate(imported)
    await client.query(
      `UPDATE migration_runs SET status = 'committed', target_hash = $2,
         watermark = $2, committed_at = clock_timestamp() WHERE migration_run_id = $1`,
      [migrationRunId, targetHash]
    )
    await client.query('COMMIT')
    return { migrationRunId, sourceHash, targetHash }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function hasCommittedActivation(pool: Pool, transitionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM migration_runs
     WHERE transition_id = $1 AND direction = 'sqlite-to-postgres' AND status = 'committed'`,
    [transitionId]
  )
  return Boolean(result.rowCount)
}

export function snapshotHash(snapshot: ApplicationSnapshot): string {
  return hashAggregate([
    ...snapshot.kv.map((entry) => ({ entity: `${entry.scope}-kv`, id: entry.key, contentHash: entry.contentHash })),
    ...snapshot.conversations.map((entry) => ({
      entity: 'conversation',
      id: entry.id,
      contentHash: entry.contentHash
    }))
  ])
}

export async function writeRepositoryToSqlite(
  source: PersistenceRepository,
  dbPath: string
): Promise<{ sourceHash: string; targetHash: string }> {
  const [snapshot, conversations] = await Promise.all([
    source.loadSnapshot(),
    source.loadConversations({ includeDeleted: true })
  ])
  const sessions = await readSessions(source, conversations)
  const sqliteConversations = conversations.map((entry) => ({
    ...entry,
    contentHash: hashJson(normalizeJson(entry.payload))
  }))
  const sourceItems = [
    ...snapshot.kv.map((entry) => ({ entity: `${entry.scope}-kv`, id: entry.key, contentHash: entry.contentHash })),
    ...sqliteConversations.map((entry) => ({ entity: 'conversation', id: entry.id, contentHash: entry.contentHash })),
    ...sessions.map((session) => ({
      entity: 'sdk-session',
      id: `${session.conversationId}:${session.sessionId}`,
      contentHash: hashJson(normalizeJson(session.paths))
    }))
  ]
  const sourceHash = hashAggregate(sourceItems)
  writeDbAtomically(dbPath, (db) => {
    db.exec(SQLITE_V2_SCHEMA)
    db.exec('BEGIN IMMEDIATE')
    try {
      const migration = db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES(1, 'sqlite-v2-base', ?, ?)`
      )
      migration.run(hashText(SQLITE_V2_SCHEMA), new Date().toISOString())
      const insertKv = db.prepare(
        `INSERT INTO persistent_kv_v2(scope, key, value_text, revision, content_hash, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      )
      for (const entry of snapshot.kv) {
        insertKv.run(entry.scope, entry.key, entry.value, entry.revision, entry.contentHash, entry.updatedAt)
      }
      const insertConversation = db.prepare(
        `INSERT INTO conversations_v2(
           id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      )
      for (const entry of sqliteConversations) {
        insertConversation.run(
          entry.id,
          JSON.stringify(entry.payload),
          entry.revision,
          entry.contentHash,
          entry.createdAt,
          entry.updatedAt,
          entry.deletedAt ?? null
        )
      }
      const insertSession = db.prepare(
        `INSERT INTO sdk_sessions_v2(project_key, session_id, mtime_ms) VALUES(?, ?, ?)`
      )
      const insertEntry = db.prepare(
        `INSERT INTO sdk_session_entries_v2(project_key, session_id, subpath, sequence, entry_uuid, entry_json, committed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`
      )
      const insertSummary = db.prepare(
        `INSERT INTO sdk_session_summaries_v2(project_key, session_id, mtime_ms, data_json) VALUES(?, ?, ?, ?)`
      )
      for (const session of sessions) {
        insertSession.run(session.conversationId, session.sessionId, session.mtime)
        let summary: SessionSummaryEntry | undefined
        for (const path of session.paths) {
          path.entries.forEach((entry, index) => {
            insertEntry.run(
              session.conversationId,
              session.sessionId,
              path.subpath ?? '',
              index + 1,
              entry.uuid ?? null,
              JSON.stringify(entry),
              new Date().toISOString()
            )
          })
          summary = foldSessionSummary(
            summary,
            { projectKey: session.conversationId, sessionId: session.sessionId, ...(path.subpath ? { subpath: path.subpath } : {}) },
            path.entries,
            { mtime: session.mtime }
          )
        }
        if (summary) insertSummary.run(session.conversationId, session.sessionId, summary.mtime, JSON.stringify(summary.data))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  const verifyDb = new DatabaseSync(dbPath, { readOnly: true })
  let targetHash: string
  try {
    const kvRows = verifyDb.prepare(
      'SELECT scope, key, content_hash FROM persistent_kv_v2 ORDER BY scope, key'
    ).all() as unknown as Array<{ scope: string; key: string; content_hash: string }>
    const conversationRows = verifyDb.prepare(
      'SELECT id, content_hash FROM conversations_v2 ORDER BY id'
    ).all() as unknown as Array<{ id: string; content_hash: string }>
    const sessionRows = verifyDb.prepare(
      `SELECT project_key, session_id, subpath, entry_json FROM sdk_session_entries_v2
       ORDER BY project_key, session_id, subpath, sequence`
    ).all() as unknown as Array<{ project_key: string; session_id: string; subpath: string; entry_json: string }>
    const grouped = new Map<string, Array<{ subpath?: string; entries: SessionStoreEntry[] }>>()
    for (const row of sessionRows) {
      const id = `${row.project_key}:${row.session_id}`
      let paths = grouped.get(id)
      if (!paths) { paths = []; grouped.set(id, paths) }
      let path = paths.find((entry) => (entry.subpath ?? '') === row.subpath)
      if (!path) { path = row.subpath ? { subpath: row.subpath, entries: [] } : { entries: [] }; paths.push(path) }
      path.entries.push(JSON.parse(row.entry_json) as SessionStoreEntry)
    }
    targetHash = hashAggregate([
      ...kvRows.map((row) => ({ entity: `${row.scope}-kv`, id: row.key, contentHash: row.content_hash })),
      ...conversationRows.map((row) => ({ entity: 'conversation', id: row.id, contentHash: row.content_hash })),
      ...[...grouped].map(([id, paths]) => ({ entity: 'sdk-session', id, contentHash: hashJson(normalizeJson(paths)) }))
    ])
  } finally {
    verifyDb.close()
  }
  if (targetHash !== sourceHash) {
    throw new StorageError('MIGRATION_VERIFICATION_FAILED', 'O snapshot SQLite não corresponde ao PostgreSQL.')
  }
  return { sourceHash, targetHash }
}
