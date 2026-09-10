import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { PoolClient } from 'pg'
import { hashJson, normalizeJson, type JsonValue } from './hashes'
import { StorageError } from './types'
import { decodePostgresJson, decodePostgresText, encodePostgresJson, encodePostgresText } from './postgresEncoding'

/** Portable database records, NOT a cross-device filesystem export. project_cwd
 * and payload_path remain opaque provenance; no files, vault or local projection
 * journal are copied, and these paths must not authorize work on another device. */
export type TransferRecordTable = 'tasks' | 'task_steps' | 'task_deliverables' | 'task_events' | 'memory_entries' | 'memory_proposals'
export type TransferRecord = Record<string, JsonValue>
export type TransferRecords = Record<TransferRecordTable, TransferRecord[]>
export interface TransferRecordItem { entity: string; id: string; contentHash: string }

type ColumnKind = 'text' | 'json' | 'integer' | 'time' | 'boolean'
interface RecordTable {
  name: TransferRecordTable
  columns: Record<string, ColumnKind>
  /** Exactly the selective codecs used by PostgresRepository. IDs, paths and
   * other raw text MUST NOT be escaped/decoded merely because they are text. */
  postgresCodecs: Record<string, 'text' | 'json'>
  parent?: string
}

// Explicit portable columns prevent PostgreSQL infrastructure fields (ordinal,
// updated_by, installation_id) leaking into SQLite. Event order is preserved by
// insertion order and included in hashes, rather than copying global ordinals.
export const TRANSFER_RECORD_TABLES: readonly RecordTable[] = [
  { name: 'tasks', parent: 'parent_task_id', postgresCodecs: { title: 'text', goal: 'text', acceptance_json: 'json', write_scope_json: 'json' }, columns: {
    id: 'text', conversation_id: 'text', project_cwd: 'text', title: 'text', goal: 'text',
    acceptance_json: 'json', status: 'text', owner_agent: 'text', write_scope_json: 'json', parent_task_id: 'text',
    attempts: 'integer', max_attempts: 'integer', lease_token: 'text', lease_expires_at: 'time', fencing_epoch: 'integer',
    revision: 'integer', created_at: 'time', updated_at: 'time'
  } },
  { name: 'task_steps', postgresCodecs: { error_json: 'json' }, columns: {
    id: 'text', task_id: 'text', seq: 'integer', kind: 'text', status: 'text', agent: 'text', sdk_session_id: 'text',
    started_at: 'time', finished_at: 'time', error_json: 'json', revision: 'integer', created_at: 'time', updated_at: 'time'
  } },
  { name: 'task_deliverables', postgresCodecs: { summary: 'text' }, columns: {
    id: 'text', task_id: 'text', step_id: 'text', kind: 'text', summary: 'text', payload_path: 'text', payload_hash: 'text',
    verified: 'boolean', verified_by: 'text', revision: 'integer', created_at: 'time', updated_at: 'time'
  } },
  { name: 'task_events', postgresCodecs: { data_json: 'json' }, columns: {
    id: 'text', task_id: 'text', step_id: 'text', at: 'time', kind: 'text', data_json: 'json'
  } },
  { name: 'memory_entries', parent: 'supersedes_id', postgresCodecs: { title: 'text', hook: 'text', body: 'text' }, columns: {
    id: 'text', rel_path: 'text', title: 'text', hook: 'text', scope: 'text', project_cwd: 'text', domain: 'text',
    body: 'text', body_hash: 'text', revision: 'integer', status: 'text', origin_conversation_id: 'text',
    origin_message_id: 'text', origin_agent: 'text', supersedes_id: 'text', created_at: 'time', updated_at: 'time'
  } },
  { name: 'memory_proposals', postgresCodecs: { title: 'text', hook: 'text', body: 'text', reason: 'text' }, columns: {
    id: 'text', entry_id: 'text', op: 'text', rel_path: 'text', title: 'text', hook: 'text', body: 'text',
    scope: 'text', project_cwd: 'text', domain: 'text', origin_conversation_id: 'text', origin_message_id: 'text',
    origin_agent: 'text', status: 'text', reason: 'text', proposed_by: 'text', expected_revision: 'integer',
    attempts: 'integer', lease_token: 'text', lease_expires_at: 'time', created_at: 'time', updated_at: 'time'
  } }
]

export function emptyTransferRecords(): TransferRecords {
  return { tasks: [], task_steps: [], task_deliverables: [], task_events: [], memory_entries: [], memory_proposals: [] }
}

function invalid(message: string): never {
  throw new StorageError('INVALID_PERSISTED_DATA', message)
}

function portableRow(table: RecordTable, raw: Record<string, unknown>): TransferRecord {
  const row: TransferRecord = {}
  for (const [column, kind] of Object.entries(table.columns)) {
    const value = raw[column]
    if (value === undefined) invalid(`Coluna ausente: ${table.name}.${column}.`)
    if (value === null) { row[column] = null; continue }
    switch (kind) {
      case 'text':
        if (typeof value !== 'string') invalid(`Texto inválido: ${table.name}.${column}.`)
        row[column] = value
        break
      case 'json':
        row[column] = normalizeJson(typeof value === 'string' ? JSON.parse(value) : value)
        break
      case 'integer': {
        const number = Number(value)
        if (!Number.isSafeInteger(number)) invalid(`Inteiro inválido: ${table.name}.${column}.`)
        row[column] = number
        break
      }
      case 'boolean':
        if (![true, false, 0, 1].includes(value as boolean | number)) invalid(`Booleano inválido: ${table.name}.${column}.`)
        row[column] = value === true || value === 1
        break
      case 'time': {
        const date = value instanceof Date ? value : new Date(String(value))
        if (!Number.isFinite(date.valueOf())) invalid(`Data inválida: ${table.name}.${column}.`)
        row[column] = date.toISOString()
        break
      }
    }
  }
  if (typeof row.id !== 'string' || !row.id) invalid(`ID inválido: ${table.name}.`)
  return row
}

/** Called inside the source snapshot transaction, against its database clock.
 * Never steal live ownership. Expired tokens are removed without changing state,
 * attempts, revision or epoch: this is idempotent, and the old token cannot pass
 * any fence on the target. The next legitimate claim increments the epoch. */
export function prepareTransferRecords(records: TransferRecords, now: number): TransferRecords {
  if (!Number.isFinite(now)) invalid('Relógio inválido durante a transferência.')
  const result = emptyTransferRecords()
  for (const table of TRANSFER_RECORD_TABLES) {
    if (!Array.isArray(records[table.name])) invalid(`Snapshot incompleto: ${table.name}.`)
    result[table.name] = records[table.name].map((raw) => portableRow(table, raw))
  }
  for (const table of ['tasks', 'memory_proposals'] as const) {
    for (const row of result[table]) {
      const token = row.lease_token
      const expires = row.lease_expires_at
      if ((token === null) !== (expires === null) || token === '') {
        invalid(`Lease incompleto em ${table}:${row.id}.`)
      }
      if (token !== null && Date.parse(String(expires)) > now) {
        throw new StorageError('TRANSITION_IN_PROGRESS', `Transição bloqueada por lease ativo em ${table}:${row.id}. Aguarde o writer terminar.`, true)
      }
      row.lease_token = null
      row.lease_expires_at = null
    }
  }
  validateReferences(result)
  return result
}

function validateReferences(records: TransferRecords): void {
  const ids = new Map(TRANSFER_RECORD_TABLES.map((table) => {
    const set = new Set(records[table.name].map((row) => String(row.id)))
    if (set.size !== records[table.name].length) invalid(`IDs duplicados em ${table.name}.`)
    return [table.name, set]
  }))
  const requireRef = (value: JsonValue, target: TransferRecordTable): void => {
    if (value !== null && (typeof value !== 'string' || !ids.get(target)!.has(value))) {
      invalid(`Referência ausente em ${target}: ${String(value)}.`)
    }
  }
  for (const row of records.tasks) requireRef(row.parent_task_id, 'tasks')
  for (const row of records.memory_entries) requireRef(row.supersedes_id, 'memory_entries')
  for (const row of records.memory_proposals) requireRef(row.entry_id, 'memory_entries')
  const steps = new Map(records.task_steps.map((row) => [row.id, row]))
  for (const table of ['task_steps', 'task_deliverables', 'task_events'] as const) {
    for (const row of records[table]) {
      if (row.task_id === null) invalid(`Tarefa ausente em ${table}:${row.id}.`)
      requireRef(row.task_id, 'tasks')
      if (table !== 'task_steps' && row.step_id !== null) {
        requireRef(row.step_id, 'task_steps')
        if (steps.get(row.step_id)?.task_id !== row.task_id) invalid(`Etapa pertence a outra tarefa: ${row.id}.`)
      }
    }
  }
  for (const table of TRANSFER_RECORD_TABLES) if (table.parent) dependencyOrder(records[table.name], table.parent)
}

function dependencyOrder(rows: TransferRecord[], parent: string): TransferRecord[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const visited = new Set<JsonValue>()
  const visiting = new Set<JsonValue>()
  const result: TransferRecord[] = []
  const visit = (row: TransferRecord): void => {
    if (visited.has(row.id)) return
    if (visiting.has(row.id)) invalid(`Ciclo de referências em ${parent}:${row.id}.`)
    visiting.add(row.id)
    const dependency = byId.get(row[parent])
    if (dependency) visit(dependency)
    visiting.delete(row.id)
    visited.add(row.id)
    result.push(row)
  }
  for (const row of rows) visit(row)
  return result
}

export function transferRecordItems(records: TransferRecords): TransferRecordItem[] {
  const items: TransferRecordItem[] = []
  const eventPositions = new Map<JsonValue, number>()
  for (const table of TRANSFER_RECORD_TABLES) {
    for (const row of records[table.name]) {
      let payload: JsonValue = row
      if (table.name === 'task_events') {
        const position = (eventPositions.get(row.task_id) ?? 0) + 1
        eventPositions.set(row.task_id, position)
        payload = { row, position }
      }
      items.push({ entity: table.name, id: String(row.id), contentHash: hashJson(payload) })
    }
  }
  return items
}

/** SELECT-only expressions shared with the runtime task/memory readers. Never
 * use as an INSERT column list. node:sqlite truncates TEXT at embedded NUL even
 * though SQLite retains every byte; BLOB results preserve the original UTF-8. */
export function sqliteRecordSelectColumns(name: TransferRecordTable): string {
  const table = TRANSFER_RECORD_TABLES.find((entry) => entry.name === name)!
  return Object.entries(table.columns).map(([column, kind]) => kind === 'text' ? `CAST(${column} AS BLOB) AS ${column}` : column).join(', ')
}

/** Only for rows selected with sqliteRecordSelectColumns; these tables contain
 * no native BLOB fields. JSON text and numeric/time columns are left unchanged. */
export function decodeSqliteRecordRow<T extends object | undefined>(raw: T): T {
  if (!raw) return raw
  return Object.fromEntries(Object.entries(raw).map(([column, value]) => [
    column, value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value
  ])) as T
}

export function readSqliteTransferRecords(db: DatabaseSync): TransferRecords {
  const records = emptyTransferRecords()
  for (const table of TRANSFER_RECORD_TABLES) {
    const order = table.name === 'task_events' ? 'rowid' : 'id'
    const rows = db.prepare(`SELECT ${sqliteRecordSelectColumns(table.name)} FROM ${table.name} ORDER BY ${order}`).all()
    records[table.name] = rows.map((row) => portableRow(table, decodeSqliteRecordRow(row)))
  }
  return records
}

export async function readPostgresTransferRecords(client: PoolClient): Promise<TransferRecords> {
  const records = emptyTransferRecords()
  for (const table of TRANSFER_RECORD_TABLES) {
    const order = table.name === 'task_events' ? 'ordinal' : 'id'
    const rows = await client.query(`SELECT ${Object.keys(table.columns).join(', ')} FROM ${table.name} ORDER BY ${order}`)
    records[table.name] = rows.rows.map((raw) => {
      const row = portableRow(table, raw)
      for (const [column, codec] of Object.entries(table.postgresCodecs)) {
        const value = row[column]
        if (value !== null) row[column] = codec === 'text' ? decodePostgresText(value as string) : decodePostgresJson(value)
      }
      return row
    })
  }
  return records
}

export async function lockPostgresTransferRecords(client: PoolClient): Promise<void> {
  // Covers inserts too (row locks alone cannot lock absent keys or new events).
  // Same order in both source export and target import avoids lock-order cycles.
  await client.query(`LOCK TABLE ${TRANSFER_RECORD_TABLES.map((table) => table.name).join(', ')} IN SHARE ROW EXCLUSIVE MODE`)
}

export async function postgresTransferClock(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  return new Date(result.rows[0].now).valueOf()
}

function rowValues(table: RecordTable, row: TransferRecord, sqlite: true): SQLInputValue[]
function rowValues(table: RecordTable, row: TransferRecord, sqlite: false): unknown[]
function rowValues(table: RecordTable, row: TransferRecord, sqlite: boolean): unknown[] {
  return Object.entries(table.columns).map(([name, kind]) => {
    let value = row[name]
    if (value === null) return null
    if (!sqlite) {
      const codec = table.postgresCodecs[name]
      if (codec === 'text') value = encodePostgresText(value as string)
      else if (codec === 'json') value = encodePostgresJson(value)
    }
    if (kind === 'json') return JSON.stringify(value)
    if (kind === 'boolean') return sqlite ? (value ? 1 : 0) : value
    return value
  })
}

export function insertSqliteTransferRecords(db: DatabaseSync, records: TransferRecords): void {
  for (const table of TRANSFER_RECORD_TABLES) {
    const columns = Object.keys(table.columns)
    const statement = db.prepare(`INSERT INTO ${table.name}(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`)
    const rows = table.parent ? dependencyOrder(records[table.name], table.parent) : records[table.name]
    for (const row of rows) statement.run(...rowValues(table, row, true))
  }
}

/** Additive only. A divergent ID, unique path or step sequence aborts the WHOLE
 * activation instead of silently discarding either side or rewriting history.
 * Caller owns the transaction; locks remain held through read-back verification. */
export async function importPostgresTransferRecords(client: PoolClient, records: TransferRecords, installationId: string): Promise<TransferRecordItem[]> {
  await lockPostgresTransferRecords(client)
  const existing = prepareTransferRecords(await readPostgresTransferRecords(client), await postgresTransferClock(client))
  for (const table of TRANSFER_RECORD_TABLES) {
    const byId = new Map(existing[table.name].map((row) => [row.id, row]))
    const columns = Object.keys(table.columns)
    const author = table.name === 'task_events' ? 'installation_id' : ['tasks', 'memory_entries', 'memory_proposals'].includes(table.name) ? 'updated_by' : null
    const insertColumns = author ? [...columns, author] : columns
    const rows = table.parent ? dependencyOrder(records[table.name], table.parent) : records[table.name]
    for (const row of rows) {
      const current = byId.get(row.id)
      if (current) {
        if (hashJson(current) !== hashJson(row)) {
          throw new StorageError('MIGRATION_VERIFICATION_FAILED', `Conflito de transferência em ${table.name}:${row.id}; nenhum registro foi substituído.`)
        }
        continue
      }
      const values = rowValues(table, row, false)
      if (author) values.push(installationId)
      await client.query(`INSERT INTO ${table.name}(${insertColumns.join(', ')}) VALUES(${insertColumns.map((_, index) => `$${index + 1}`).join(', ')})`, values)
    }
  }
  const actual = prepareTransferRecords(await readPostgresTransferRecords(client), await postgresTransferClock(client))
  const imported = emptyTransferRecords()
  for (const table of TRANSFER_RECORD_TABLES) {
    const ids = new Set(records[table.name].map((row) => row.id))
    imported[table.name] = actual[table.name].filter((row) => ids.has(row.id))
  }
  const expectedItems = transferRecordItems(records)
  const actualItems = new Map(transferRecordItems(imported).map((item) => [`${item.entity}:${item.id}`, item.contentHash]))
  for (const item of expectedItems) {
    if (actualItems.get(`${item.entity}:${item.id}`) !== item.contentHash) {
      throw new StorageError('MIGRATION_VERIFICATION_FAILED', `Falha ao verificar ${item.entity}:${item.id}.`)
    }
  }
  return expectedItems
}
