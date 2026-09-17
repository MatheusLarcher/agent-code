// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { SqliteRepository } from './sqliteRepository'
import { PostgresRepository } from './postgresRepository'
import { SQLITE_SCHEMA_FULL } from './sqliteSchema'
import * as recordTransfer from './transferRecords'
import { hashAggregate } from './hashes'
import { encodePostgresJson, encodePostgresText } from './postgresEncoding'
import { importRepositoryToPostgres, snapshotHash, writeRepositoryToSqlite } from './postgresTransfer'
import {
  emptyTransferRecords, insertSqliteTransferRecords, prepareTransferRecords,
  readPostgresTransferRecords, readSqliteTransferRecords, transferRecordItems, TRANSFER_RECORD_TABLES, type TransferRecords
} from './transferRecords'

const dirs: string[] = []
const databases: DatabaseSync[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-code-record-transfer-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const at = '2026-01-01T00:00:00.000Z'

function fixture(): TransferRecords {
  const records = emptyTransferRecords()
  const task = {
    id: 'z-parent', conversation_id: 'historical-conversation', project_cwd: 'C:/only-this-device/project',
    title: 'Task', goal: 'Keep all metadata', acceptance_json: ['verified'], status: 'review', owner_agent: 'historical-writer',
    write_scope_json: { allow: ['src/**'], deny: ['.env'] }, parent_task_id: null, attempts: 2, max_attempts: 4,
    lease_token: 'expired-task-token', lease_expires_at: at, fencing_epoch: 12, revision: 7, created_at: at, updated_at: at
  }
  records.tasks = [task, { ...task, id: 'a-child', parent_task_id: task.id, status: 'done', lease_token: null, lease_expires_at: null }]
  records.task_steps = [{
    id: 'step-1', task_id: task.id, seq: 1, kind: 'verify', status: 'failed', agent: 'writer', sdk_session_id: 'session',
    started_at: at, finished_at: at, error_json: { message: 'historical failure', nested: [1, false] }, revision: 3, created_at: at, updated_at: at
  }]
  records.task_deliverables = [{
    id: 'deliverable', task_id: task.id, step_id: 'step-1', kind: 'file', summary: 'Keep file provenance, not copy file',
    payload_path: 'C:/only-this-device/cache/tasks/result.txt', payload_hash: 'original-hash', verified: true,
    verified_by: 'reviewer', revision: 2, created_at: at, updated_at: at
  }]
  // Wall clocks and UUID ordering are NOT event history order.
  records.task_events = [
    { id: 'z-first', task_id: task.id, step_id: null, at: '2026-01-02T00:00:00.000Z', kind: 'created', data_json: { original: true } },
    { id: 'a-second', task_id: task.id, step_id: 'step-1', at, kind: 'step_finished', data_json: { status: 'failed' } }
  ]
  const entry = {
    id: 'z-retired', rel_path: 'archive/old.md', title: 'Older', hook: 'Older hook', scope: 'project', project_cwd: task.project_cwd,
    domain: null, body: '# Body\nUnicode: memória', body_hash: 'body-hash', revision: 8, status: 'retired',
    origin_conversation_id: 'origin-conv', origin_message_id: 'origin-msg', origin_agent: 'agent', supersedes_id: null,
    created_at: at, updated_at: at
  }
  records.memory_entries = [entry, { ...entry, id: 'a-current', rel_path: 'current.md', status: 'active', supersedes_id: entry.id }]
  records.memory_proposals = ['pending', 'applied', 'rejected', 'conflict'].map((status, index) => ({
    id: `proposal-${index}`, entry_id: index === 1 ? 'a-current' : null, op: 'update', rel_path: 'current.md', title: 'Proposed',
    hook: 'New hook', body: '# Proposed', scope: 'project', project_cwd: task.project_cwd, domain: null,
    origin_conversation_id: 'origin-conv', origin_message_id: 'origin-msg', origin_agent: 'agent', status,
    reason: index > 1 ? `Reason ${status}` : null, proposed_by: 'curator', expected_revision: 8, attempts: 2,
    lease_token: index === 0 ? 'expired-proposal-token' : null, lease_expires_at: index === 0 ? at : null,
    created_at: at, updated_at: at
  }))
  return records
}

async function source(records = fixture()): Promise<SqliteRepository> {
  const dir = temp()
  const repository = new SqliteRepository(dir, join(dir, 'source.db'), 'device-fixture')
  await repository.initialize()
  repository.write((db) => insertSqliteTransferRecords(db, records))
  return repository
}

/** SQL contract fixture, NOT a PostgreSQL engine/concurrency substitute. It uses
 * ONLY a temporary SQLite file, never PG env vars, config, network or user cache.
 * The production SQL still gets exercised (parameter order, columns, rollback,
 * read-back), while locking/isolation assertions are checked in the query log. */
function postgresFixture() {
  const db = new DatabaseSync(join(temp(), 'postgres-contract.db'))
  databases.push(db)
  db.exec(SQLITE_SCHEMA_FULL)
  db.exec(`
    PRAGMA foreign_keys = ON;
    ALTER TABLE tasks ADD COLUMN updated_by TEXT;
    ALTER TABLE task_events ADD COLUMN installation_id TEXT;
    ALTER TABLE memory_entries ADD COLUMN updated_by TEXT;
    ALTER TABLE memory_proposals ADD COLUMN updated_by TEXT;
    CREATE TABLE migration_runs(migration_run_id TEXT PRIMARY KEY, transition_id TEXT UNIQUE, installation_id TEXT,
      direction TEXT, status TEXT, source_hash TEXT, target_hash TEXT, watermark TEXT, committed_at TEXT);
    CREATE TABLE migration_items(migration_run_id TEXT, entity TEXT, entity_id TEXT, content_hash TEXT,
      PRIMARY KEY(migration_run_id, entity, entity_id));
  `)
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('LOCK TABLE')) return { rows: [], rowCount: 0 }
    if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now: new Date() }], rowCount: 1 }
    if (sql.startsWith('BEGIN')) { db.exec('BEGIN'); return { rows: [], rowCount: 0 } }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { db.exec(sql); return { rows: [], rowCount: 0 } }
    const params: SQLInputValue[] = []
    const translated = sql.replace(/\$(\d+)/g, (_, index: string) => {
      const value = values[Number(index) - 1]
      params.push((typeof value === 'boolean' ? Number(value) : value) as SQLInputValue)
      return '?'
    }).replace(/ORDER BY ordinal/g, 'ORDER BY rowid').replace(/clock_timestamp\(\)/g, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    if (/^\s*SELECT/i.test(translated)) {
      const rows = db.prepare(translated).all(...params)
      return { rows, rowCount: rows.length }
    }
    const result = db.prepare(translated).run(...params)
    return { rows: [], rowCount: Number(result.changes) }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const pool = { connect: vi.fn(async () => client), query } as unknown as Pool
  // Only the export method is exercised; no initialize/listener is started.
  const repository = Object.assign(Object.create(PostgresRepository.prototype), { pool, initialized: true }) as PostgresRepository
  return { db, query, release, pool, repository }
}

function recordHash(records: TransferRecords): string { return hashAggregate(transferRecordItems(records)) }

// Independent declaration of PostgresRepository's selective codec contract. Do
// not derive this from transfer metadata: that would mask over/under-encoding.
const expectedCodecs: Record<keyof TransferRecords, Record<string, 'text' | 'json'>> = {
  tasks: { title: 'text', goal: 'text', acceptance_json: 'json', write_scope_json: 'json' },
  task_steps: { error_json: 'json' },
  task_deliverables: { summary: 'text' },
  task_events: { data_json: 'json' },
  memory_entries: { title: 'text', hook: 'text', body: 'text' },
  memory_proposals: { title: 'text', hook: 'text', body: 'text', reason: 'text' }
}
const literalMarker = 'agent-code-pg-escape:0literal-agent-code-pg-escape:e'
function codecFixture(text: string): TransferRecords {
  const records = prepareTransferRecords(fixture(), Date.now())
  for (const table of TRANSFER_RECORD_TABLES) {
    for (const row of records[table.name]) {
      for (const [column, codec] of Object.entries(expectedCodecs[table.name])) {
        if (row[column] === null) continue
        row[column] = codec === 'text' ? text : column === 'acceptance_json' ? [text] : { [text]: [text, { nested: text }] }
      }
      // These are NOT encoded by PostgresRepository, even for literal reserved
      // marker sequences. They must not get decoded or escaped during transfer.
      for (const column of ['project_cwd', 'payload_path', 'origin_agent', 'agent', 'owner_agent', 'proposed_by']) {
        if (column in row && row[column] !== null) row[column] = `opaque/${literalMarker}`
      }
    }
  }
  return records
}

describe('selective PostgreSQL record codecs', () => {
  it('matches the repository codec contract rather than encoding every text column', () => {
    expect(Object.fromEntries(TRANSFER_RECORD_TABLES.map((table) => [table.name, table.postgresCodecs]))).toEqual(expectedCodecs)
  })

  it.each(['nul\0content', literalMarker])('decodes synthetic PG wire rows and round trips %j without double encoding', async (text) => {
    const expected = codecFixture(text)
    const wire = structuredClone(expected)
    for (const table of TRANSFER_RECORD_TABLES) {
      for (const row of wire[table.name]) {
        for (const [column, codec] of Object.entries(expectedCodecs[table.name])) {
          const value = row[column]
          if (value !== null) row[column] = codec === 'text' ? encodePostgresText(value as string) : encodePostgresJson(value)
        }
      }
    }
    // Real pg returns parsed jsonb objects, not SQLite's JSON text. These rows
    // are encoded independently of the transfer implementation and SQL adapter.
    const wireClient = { query: vi.fn(async (sql: string) => {
      const table = TRANSFER_RECORD_TABLES.find((entry) => sql.includes(` FROM ${entry.name} ORDER BY `))!
      return { rows: structuredClone(wire[table.name]) }
    }) } as unknown as PoolClient
    const decoded = await readPostgresTransferRecords(wireClient)
    expect(decoded).toEqual(expected)
    expect(recordHash(decoded)).toBe(recordHash(expected))

    const repository = await source(expected)
    const exportSource = Object.create(repository) as SqliteRepository
    exportSource.loadTransferRecords = async () => prepareTransferRecords(await readPostgresTransferRecords(wireClient), Date.now())
    const targetDir = temp()
    const target = join(targetDir, 'decoded.db')
    const exported = await writeRepositoryToSqlite(exportSource, target)
    expect(exported.sourceHash).toBe(exported.targetHash)
    const db = new DatabaseSync(target, { readOnly: true })
    databases.push(db)
    expect(recordHash(readSqliteTransferRecords(db))).toBe(recordHash(expected))
    const runtime = new SqliteRepository(targetDir, target, 'runtime-fixture')
    await runtime.initialize()
    try {
      expect((await runtime.getTask(String(expected.tasks[0].id)))?.title).toBe(text)
      expect((await runtime.listTaskDeliverables(String(expected.tasks[0].id)))[0].summary).toBe(text)
      expect((await runtime.getMemoryEntryByPath(String(expected.memory_entries[0].rel_path)))?.body).toBe(text)
      expect((await runtime.listMemoryProposals())[0].body).toBe(text)
    } finally { await runtime.close() }

    const pg = postgresFixture()
    const imported = await importRepositoryToPostgres(pg.pool, repository, 'installation', 'codec-1')
    expect(imported.sourceHash).toBe(imported.targetHash)
    // Assert wire parameters, not just adapter round trips (SQLite accepts NUL,
    // so an unencoded insert would otherwise appear to work).
    for (const table of TRANSFER_RECORD_TABLES) {
      const inserts = pg.query.mock.calls.filter(([sql]) => sql.startsWith(`INSERT INTO ${table.name}(`))
      expect(inserts).toHaveLength(expected[table.name].length)
      for (const [, values] of inserts) {
        const original = expected[table.name].find((row) => row.id === values![0])!
        Object.entries(table.columns).forEach(([column, kind], index) => {
          const raw = original[column]
          const codec = expectedCodecs[table.name][column]
          const encoded = raw === null ? null : codec === 'text' ? encodePostgresText(raw as string) : codec === 'json' ? encodePostgresJson(raw) : raw
          expect(values![index], `${table.name}.${column}`).toEqual(kind === 'json' && encoded !== null ? JSON.stringify(encoded) : encoded)
        })
      }
    }
    expect(recordHash(await pg.repository.loadTransferRecords())).toBe(recordHash(expected))
    const repeated = await importRepositoryToPostgres(pg.pool, repository, 'installation', 'codec-2')
    expect(repeated.targetHash).toBe(imported.targetHash)
  })
})

describe('complete task/memory transfer snapshots', () => {
  it('exports all rows including retired entries, proposal history and ordered task history', async () => {
    const repository = await source()
    const records = await repository.loadTransferRecords()
    const expected = prepareTransferRecords(fixture(), Date.now())
    expect(recordHash(records)).toBe(recordHash(expected))
    expect(records.tasks.map((row) => row.id)).toEqual(['a-child', 'z-parent'])
    expect(records.task_events.map((row) => row.id)).toEqual(['z-first', 'a-second'])
    expect(records.memory_entries.some((row) => row.status === 'retired')).toBe(true)
    expect(records.memory_proposals.map((row) => row.status)).toEqual(['pending', 'applied', 'rejected', 'conflict'])
    expect(records.tasks.find((row) => row.id === 'z-parent')).toMatchObject({ fencing_epoch: 12, owner_agent: 'historical-writer', status: 'review', lease_token: null })
    expect(recordHash(prepareTransferRecords(records, Date.now()))).toBe(recordHash(records))
    // Export does not modify ownership or history in the source DB.
    expect((await repository.getTask('z-parent'))?.leaseToken).toBe('expired-task-token')
    const snapshot = await repository.loadSnapshot()
    expect(snapshotHash(snapshot, records)).not.toBe(snapshotHash(snapshot, emptyTransferRecords()))
  })

  it('does not inherit list limits for tasks or proposals', async () => {
    const records = fixture()
    for (let i = 0; i < 250; i++) {
      records.tasks.push({ ...records.tasks[0], id: `bulk-task-${i}`, parent_task_id: null })
      records.memory_proposals.push({ ...records.memory_proposals[0], id: `bulk-proposal-${i}` })
    }
    const snapshot = await (await source(records)).loadTransferRecords()
    expect(snapshot.tasks).toHaveLength(252)
    expect(snapshot.memory_proposals).toHaveLength(254)
  })

  it.each(['tasks', 'memory_proposals'] as const)('refuses live %s leases before replacing any SQLite target', async (table) => {
    const records = fixture()
    records[table][0].lease_expires_at = '2999-01-01T00:00:00.000Z'
    const repository = await source(records)
    const target = join(temp(), 'keep.db')
    const db = new DatabaseSync(target)
    db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'keep\')')
    db.close()
    const before = readFileSync(target)
    await expect(writeRepositoryToSqlite(repository, target)).rejects.toMatchObject({ code: 'TRANSITION_IN_PROGRESS' })
    expect(readFileSync(target)).toEqual(before)
    const pg = postgresFixture()
    await expect(importRepositoryToPostgres(pg.pool, repository, 'installation', 'transition')).rejects.toMatchObject({ code: 'TRANSITION_IN_PROGRESS' })
    expect(pg.query).not.toHaveBeenCalled()
  })

  it('rejects malformed leases, absent references and cycles instead of losing rows', () => {
    const malformed = fixture()
    malformed.tasks[0].lease_expires_at = null
    expect(() => prepareTransferRecords(malformed, Date.now())).toThrow(/Lease incompleto/)
    const absent = fixture()
    absent.memory_proposals[0].entry_id = 'missing'
    expect(() => prepareTransferRecords(absent, Date.now())).toThrow(/Referência ausente/)
    const cycle = fixture()
    cycle.tasks[0].parent_task_id = 'a-child'
    expect(() => prepareTransferRecords(cycle, Date.now())).toThrow(/Ciclo/)
    const unsafe = fixture()
    unsafe.tasks[0].fencing_epoch = '9007199254740993'
    expect(() => prepareTransferRecords(unsafe, Date.now())).toThrow(/Inteiro inválido/)
  })

  it('writes all records to SQLite with equal content hashes, dependencies and opaque paths intact', async () => {
    const repository = await source()
    const target = join(temp(), 'target.db')
    const hashes = await writeRepositoryToSqlite(repository, target)
    expect(hashes.sourceHash).toBe(hashes.targetHash)
    const db = new DatabaseSync(target, { readOnly: true })
    databases.push(db)
    const written = readSqliteTransferRecords(db)
    expect(recordHash(written)).toBe(recordHash(await repository.loadTransferRecords()))
    expect(written.task_deliverables[0].payload_path).toBe('C:/only-this-device/cache/tasks/result.txt')
    expect(written.memory_entries[0].project_cwd).toBe('C:/only-this-device/project')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(written.memory_proposals.every((row) => row.lease_token === null && row.lease_expires_at === null)).toBe(true)
  })

  it('verifies SQLite contents before publication and preserves an existing target on corruption', async () => {
    const repository = await source()
    const target = join(temp(), 'keep.db')
    const db = new DatabaseSync(target)
    db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')")
    db.close()
    const before = readFileSync(target)
    const originalInsert = recordTransfer.insertSqliteTransferRecords
    vi.spyOn(recordTransfer, 'insertSqliteTransferRecords').mockImplementation((writtenDb, records) => {
      originalInsert(writtenDb, records)
      writtenDb.prepare("UPDATE memory_entries SET body = 'corruption' WHERE id = 'a-current'").run()
    })
    await expect(writeRepositoryToSqlite(repository, target)).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED' })
    expect(readFileSync(target)).toEqual(before)
  })

  it('hashes every field, missing records and per-task event order, independently of table row order', () => {
    const records = prepareTransferRecords(fixture(), Date.now())
    const original = recordHash(records)
    for (const table of TRANSFER_RECORD_TABLES) {
      for (const column of Object.keys(table.columns)) {
        const changed = structuredClone(records)
        changed[table.name][0][column] = 'tampered'
        expect(recordHash(changed), `${table.name}.${column}`).not.toBe(original)
      }
      const missing = structuredClone(records)
      missing[table.name].pop()
      expect(recordHash(missing), table.name).not.toBe(original)
    }
    const reordered = structuredClone(records)
    reordered.task_events.reverse()
    expect(recordHash(reordered)).not.toBe(original)
    const unordered = structuredClone(records)
    unordered.tasks.reverse()
    unordered.memory_entries.reverse()
    expect(recordHash(unordered)).toBe(original)
  })
})

describe('PostgreSQL transfer SQL contract (temporary SQLite adapter, no server)', () => {
  it('locks six tables before the first SERIALIZABLE snapshot SELECT and retains the helper lock', async () => {
    const pg = postgresFixture()
    await importRepositoryToPostgres(pg.pool, await source(), 'installation', 'lock-order')
    const sql = pg.query.mock.calls.map(([query]) => query)
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE')
    expect(sql[1]).toBe('LOCK TABLE tasks, task_steps, task_deliverables, task_events, memory_entries, memory_proposals IN SHARE ROW EXCLUSIVE MODE')
    expect(sql[2]).toMatch(/SELECT migration_run_id, source_hash, target_hash FROM migration_runs/)
    expect(sql.findIndex((query) => /^\s*SELECT/.test(query))).toBe(2)
    // The record-only helper still acquires its own lock for standalone callers.
    expect(sql.filter((query) => query === sql[1])).toHaveLength(2)
  })

  it('round trips all six tables, logs their verified hashes, and repeats without duplicate history', async () => {
    const repository = await source()
    const pg = postgresFixture()
    const first = await importRepositoryToPostgres(pg.pool, repository, 'installation', 'transition-1')
    expect(first.sourceHash).toBe(first.targetHash)
    const snapshot = await pg.repository.loadTransferRecords()
    expect(recordHash(snapshot)).toBe(recordHash(await repository.loadTransferRecords()))
    const items = pg.db.prepare('SELECT entity, count(*) AS count FROM migration_items GROUP BY entity').all()
    expect(items).toHaveLength(6)
    for (const table of TRANSFER_RECORD_TABLES) {
      expect(items.find((item) => item.entity === table.name)?.count).toBe(snapshot[table.name].length)
    }
    const replay = await importRepositoryToPostgres(pg.pool, repository, 'installation', 'transition-1')
    expect(replay).toEqual(first)
    const repeat = await importRepositoryToPostgres(pg.pool, repository, 'installation', 'transition-2')
    expect(repeat.sourceHash).toBe(first.sourceHash)
    expect(repeat.targetHash).toBe(first.targetHash)
    expect(pg.db.prepare('SELECT count(*) AS count FROM task_events').get()?.count).toBe(2)
    const target = join(temp(), 'roundtrip.db')
    // Keep old app snapshot/session behavior out of this records-only SQL fixture.
    const exportSource = Object.create(repository) as SqliteRepository
    exportSource.loadTransferRecords = () => pg.repository.loadTransferRecords()
    const exported = await writeRepositoryToSqlite(exportSource, target)
    expect(exported.sourceHash).toBe(exported.targetHash)
    const db = new DatabaseSync(target, { readOnly: true })
    databases.push(db)
    expect(recordHash(readSqliteTransferRecords(db))).toBe(recordHash(snapshot))
    const sql = pg.query.mock.calls.map(([query]) => query)
    const exportBegin = sql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ')
    expect(sql[exportBegin + 1]).toMatch(/^LOCK TABLE .* IN SHARE ROW EXCLUSIVE MODE$/)
    const clock = sql.indexOf('SELECT clock_timestamp() AS now', exportBegin)
    expect(sql.slice(exportBegin, clock).filter((query) => /^SELECT .* FROM (tasks|task_steps|task_deliverables|task_events|memory_entries|memory_proposals) ORDER/.test(query))).toHaveLength(6)
    expect(sql[clock + 1]).toBe('COMMIT')
  })

  it.each(['tasks', 'memory_proposals'] as const)('checks %s source leases inside the locked PG snapshot transaction', async (table) => {
    const pg = postgresFixture()
    insertSqliteTransferRecords(pg.db, fixture())
    pg.db.prepare(`UPDATE ${table} SET lease_expires_at = ? WHERE lease_token IS NOT NULL`).run('2999-01-01T00:00:00.000Z')
    await expect(pg.repository.loadTransferRecords()).rejects.toMatchObject({ code: 'TRANSITION_IN_PROGRESS' })
    expect(pg.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ')
    expect(pg.query.mock.calls[1][0]).toMatch(/^LOCK TABLE/)
    expect(pg.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
    expect(pg.release).toHaveBeenCalledOnce()
  })

  it.each(['tasks', 'memory_entries', 'memory_proposals', 'task_events'] as const)('aborts divergent %s rows without replacing target data', async (table) => {
    const pg = postgresFixture()
    const repository = await source()
    await importRepositoryToPostgres(pg.pool, repository, 'installation', 'initial')
    const column = table === 'task_events' ? 'kind' : table === 'memory_proposals' ? 'reason' : 'title'
    pg.db.prepare(`UPDATE ${table} SET ${column} = ?`).run('remote-divergence')
    await expect(importRepositoryToPostgres(pg.pool, repository, 'installation', 'conflict')).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED' })
    expect(pg.db.prepare("SELECT count(*) AS count FROM migration_runs WHERE transition_id = 'conflict'").get()?.count).toBe(0)
    expect(pg.db.prepare(`SELECT ${column} AS value FROM ${table} LIMIT 1`).get()?.value).toBe('remote-divergence')
  })

  it('rolls back additions on a unique memory-path collision', async () => {
    const pg = postgresFixture()
    const target = prepareTransferRecords(fixture(), Date.now())
    target.memory_entries = [{ ...target.memory_entries[1], id: 'other-memory-id', supersedes_id: null }]
    target.memory_proposals = []
    target.tasks = []; target.task_steps = []; target.task_events = []; target.task_deliverables = []
    insertSqliteTransferRecords(pg.db, target)
    await expect(importRepositoryToPostgres(pg.pool, await source(), 'installation', 'collision')).rejects.toThrow(/UNIQUE/)
    expect(pg.db.prepare('SELECT count(*) AS count FROM tasks').get()?.count).toBe(0)
    expect(pg.db.prepare('SELECT count(*) AS count FROM migration_runs').get()?.count).toBe(0)
    expect(pg.db.prepare('SELECT id FROM memory_entries').all()).toEqual([{ id: 'other-memory-id' }])
  })

  it('refuses live target ownership and changed-source replay', async () => {
    const pg = postgresFixture()
    const repository = await source()
    await importRepositoryToPostgres(pg.pool, repository, 'installation', 'initial')
    pg.db.prepare("UPDATE tasks SET lease_token = 'remote-owner', lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = 'z-parent'").run()
    await expect(importRepositoryToPostgres(pg.pool, repository, 'installation', 'live')).rejects.toMatchObject({ code: 'TRANSITION_IN_PROGRESS' })
    expect(pg.db.prepare("SELECT lease_token FROM tasks WHERE id = 'z-parent'").get()?.lease_token).toBe('remote-owner')
    repository.write((db) => db.prepare("UPDATE memory_entries SET body = 'new local body' WHERE id = 'a-current'").run())
    await expect(importRepositoryToPostgres(pg.pool, repository, 'installation', 'initial')).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED' })
  })

  it('detects read-back corruption and rolls back the complete activation', async () => {
    const pg = postgresFixture()
    // Represents a trigger/adapter bug changing content while leaving body_hash intact.
    pg.db.exec("CREATE TRIGGER corrupt AFTER INSERT ON memory_entries BEGIN UPDATE memory_entries SET body = 'corrupt' WHERE id = NEW.id; END")
    await expect(importRepositoryToPostgres(pg.pool, await source(), 'installation', 'corrupt')).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED' })
    expect(pg.db.prepare('SELECT count(*) AS count FROM memory_entries').get()?.count).toBe(0)
    expect(pg.db.prepare('SELECT count(*) AS count FROM tasks').get()?.count).toBe(0)
    expect(pg.db.prepare('SELECT count(*) AS count FROM migration_runs').get()?.count).toBe(0)
  })
})
