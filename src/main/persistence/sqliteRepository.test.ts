import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'
import { StorageError } from './types'

const tempDirs: string[] = []

async function tempCache(): Promise<{ cache: string; dbPath: string }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-sqlite-v2-'))
  tempDirs.push(cache)
  return { cache, dbPath: join(cache, 'agent-code.db') }
}

function seedKvDb(path: string, rows: Record<string, string>): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)')
    for (const [key, value] of Object.entries(rows)) insert.run(key, value)
  } finally {
    db.close()
  }
}

async function seedProjectDb(cache: string, file: string, value: string): Promise<string> {
  const data = join(cache, 'data')
  await mkdir(data, { recursive: true })
  const path = join(data, file)
  seedKvDb(path, { conversations: value })
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteRepository', () => {
  it('migra KV e conversas legadas sem alterar as fontes', async () => {
    const { cache, dbPath } = await tempCache()
    seedKvDb(dbPath, {
      config: JSON.stringify({ skipPermissions: true, openai: { apiKey: 'x' } }),
      'chave-desconhecida': 'preservar',
      'agentcode.conversations.v1': JSON.stringify([
        { id: 'c1', cwd: 'C:/um', title: 'Legada', createdAt: 10, updatedAt: 20, messages: [] }
      ])
    })
    const projectPath = await seedProjectDb(
      cache,
      'dois.db',
      JSON.stringify([{ id: 'c2', cwd: 'C:/dois', title: 'Projeto', messages: [{ kind: 'user' }] }])
    )
    const globalBefore = await readFile(dbPath)
    const projectBefore = await readFile(projectPath)

    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()
    const snapshot = await repository.loadSnapshot()

    expect(snapshot.config.skipPermissions).toBe(true)
    expect(snapshot.config.openai.apiKey).toBe('x')
    expect(snapshot.conversations.map((entry) => entry.id).sort()).toEqual(['c1', 'c2'])
    expect(snapshot.kv.find((entry) => entry.key === 'chave-desconhecida')).toMatchObject({
      scope: 'device',
      value: 'preservar'
    })
    expect(await readFile(`${dbPath}.pre-v2.bak`)).toEqual(globalBefore)
    expect(await readFile(projectPath)).toEqual(projectBefore)

    await repository.close()
  })

  it('aborta a migração quando um projeto contém JSON inválido', async () => {
    const { cache, dbPath } = await tempCache()
    seedKvDb(dbPath, { config: '{}' })
    await seedProjectDb(cache, 'quebrado.db', '{')

    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await expect(repository.initialize()).rejects.toMatchObject({
      code: 'INVALID_PERSISTED_DATA'
    } satisfies Partial<StorageError>)

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('aplica CAS em KV e em conversas e mantém tombstones', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    const firstKv = await repository.setKv({ scope: 'device', key: 'agentcode.ui.v1', value: '{}' })
    expect(firstKv.revision).toBe(1)
    const secondKv = await repository.setKv({
      scope: 'device',
      key: 'agentcode.ui.v1',
      value: '{"collapsed":true}',
      expectedRevision: 1
    })
    expect(secondKv.revision).toBe(2)
    await expect(
      repository.setKv({
        scope: 'device',
        key: 'agentcode.ui.v1',
        value: 'stale',
        expectedRevision: 1
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    const created = await repository.upsertConversation({ id: 'c1', payload: { id: 'c1', title: 'A' } })
    const updated = await repository.upsertConversation({
      id: 'c1',
      payload: { id: 'c1', title: 'B' },
      expectedRevision: created.revision
    })
    await expect(
      repository.upsertConversation({
        id: 'c1',
        payload: { id: 'c1', title: 'C' },
        expectedRevision: created.revision
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    const deleted = await repository.deleteConversation({ id: 'c1', expectedRevision: updated.revision })
    expect(deleted.deletedAt).toBeDefined()
    expect(await repository.loadConversations()).toEqual([])
    expect(await repository.loadConversations({ includeDeleted: true })).toHaveLength(1)
  })

  it('converte o contrato legado de lista completa em mutações por conversa', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    await repository.replaceAllConversations([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ])
    await repository.replaceAllConversations([{ id: 'b', title: 'B2' }])

    expect((await repository.loadConversations()).map((entry) => entry.id)).toEqual(['b'])
    const all = await repository.loadConversations({ includeDeleted: true })
    expect(all.find((entry) => entry.id === 'a')?.deletedAt).toBeDefined()
    expect(all.find((entry) => entry.id === 'b')?.payload.title).toBe('B2')
  })

  it('implementa SessionStore com UUID idempotente e subpaths', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()
    const store = repository.createSessionStore('conversation-1')
    const mainKey = { projectKey: 'ignored', sessionId: 'session-1' }
    const timestamp = new Date().toISOString()
    const uuidEntry = {
      type: 'user',
      uuid: 'entry-1',
      timestamp,
      cwd: 'C:/repo',
      message: { role: 'user', content: 'oi' }
    }
    const marker = { type: 'custom-title', timestamp, customTitle: 'Teste' }

    await store.append(mainKey, [uuidEntry, marker])
    await store.append(mainKey, [uuidEntry, marker])
    await store.append({ ...mainKey, subpath: 'subagents/a.jsonl' }, [
      { type: 'assistant', uuid: 'entry-sub', timestamp, message: { role: 'assistant', content: 'feito' } }
    ])

    const loaded = await store.load(mainKey)
    expect(loaded?.filter((entry) => entry.uuid === 'entry-1')).toHaveLength(1)
    expect(loaded?.filter((entry) => entry.type === 'custom-title')).toHaveLength(2)
    expect(await store.listSubkeys?.(mainKey)).toEqual(['subagents/a.jsonl'])
    expect(await store.listSessions?.('ignored')).toEqual([
      expect.objectContaining({ sessionId: 'session-1' })
    ])
    expect(await store.listSessionSummaries?.('ignored')).toHaveLength(1)

    await store.delete?.(mainKey)
    expect(await store.load(mainKey)).toBeNull()
    expect(await store.load({ ...mainKey, subpath: 'subagents/a.jsonl' })).toBeNull()
    expect(await store.listSessions?.('ignored')).toEqual([])
    expect(await store.listSessionSummaries?.('ignored')).toEqual([])
  })

  it('invalida stores antigos depois que o repositório é fechado', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()
    const store = repository.createSessionStore('conversation-1')
    await repository.close()

    await expect(store.load({ projectKey: 'ignored', sessionId: 'closed' })).rejects.toMatchObject({
      code: 'STORAGE_OFFLINE'
    })
  })

  it('bloqueia checksum alterado e schema mais novo', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    let db = new DatabaseSync(dbPath)
    try {
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('alterado')
    } finally {
      db.close()
    }
    await expect(new SqliteRepository(cache, dbPath, 'device-b').initialize()).rejects.toMatchObject({
      code: 'SCHEMA_CHECKSUM_MISMATCH'
    })

    db = new DatabaseSync(dbPath)
    try {
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(
        (await import('./hashes')).hashText((await import('./sqliteSchema')).SQLITE_V2_SCHEMA)
      )
      db.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(2, 'future', 'x', ?)"
      ).run(new Date().toISOString())
    } finally {
      db.close()
    }
    await expect(new SqliteRepository(cache, dbPath, 'device-b').initialize()).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW'
    })
  })

  it('protege a conversa com lease local e fencing', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    const lease = await repository.acquireConversationLease('c1')
    await expect(repository.acquireConversationLease('c1')).rejects.toMatchObject({
      code: 'LEASE_HELD_BY_OTHER_DEVICE'
    })
    const renewed = await repository.renewConversationLease(lease)
    expect(renewed.fencingEpoch).toBe(lease.fencingEpoch)
    await repository.releaseConversationLease(renewed)
    const next = await repository.acquireConversationLease('c1')
    expect(next.fencingEpoch).toBe(2)
  })
})
