// @vitest-environment node
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
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, 'future', 'x', ?)"
      ).run((await import('./sqliteSchema')).SQLITE_MIGRATIONS.at(-1)!.version + 1, new Date().toISOString())
    } finally {
      db.close()
    }
    await expect(new SqliteRepository(cache, dbPath, 'device-b').initialize()).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW'
    })
  })

  it('atualiza um banco v2 existente com as migrations adicionais sem perder dados', async () => {
    const { cache, dbPath } = await tempCache()
    const { SQLITE_MIGRATIONS, SQLITE_V2_SCHEMA } = await import('./sqliteSchema')
    const { hashText } = await import('./hashes')
    // A db produced by the previous release: only migration 1 recorded, no task tables.
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(SQLITE_V2_SCHEMA)
      db.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(1, 'sqlite-v2-base', ?, ?)"
      ).run(hashText(SQLITE_V2_SCHEMA), new Date().toISOString())
      db.prepare(
        `INSERT INTO conversations_v2(id, payload_json, revision, content_hash, created_at, updated_at, deleted_at)
         VALUES('c1', '{"id":"c1"}', 1, 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`
      ).run()
    } finally {
      db.close()
    }

    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    expect((await repository.loadConversations()).map((entry) => entry.id)).toEqual(['c1'])
    const created = await repository.createTask({ projectCwd: 'C:/repo', title: 'T', goal: 'G' })
    expect(created.status).toBe('pending')
    const applied = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = applied.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{
        version: number
        checksum: string
      }>
      expect(rows).toEqual(SQLITE_MIGRATIONS.map((entry) => ({ version: entry.version, checksum: entry.checksum })))
    } finally {
      applied.close()
    }
    await repository.close()
  })

  it('protege a conversa com lease local e fencing', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    const lease = await repository.acquireConversationLease('c1')
    // Re-acquiring from the SAME installation is allowed on purpose: only a
    // foreign lease fences. One session per conversation is enforced by the
    // main process (`sessions` map + releaseSessionLease), not by the lease —
    // and refusing our own lease locked the conversation out after a crash.
    const again = await repository.acquireConversationLease('c1')
    expect(again.fencingEpoch).toBe(lease.fencingEpoch + 1)
    const renewed = await repository.renewConversationLease(again)
    expect(renewed.fencingEpoch).toBe(again.fencingEpoch)
    await repository.releaseConversationLease(renewed)
    const next = await repository.acquireConversationLease('c1')
    expect(next.fencingEpoch).toBe(3)
  })
})

/** "Não consegue gravar porque tem outro writer ativo" — the lease is meant to
 * fence a REMOTE device. Treating this installation's own lease as foreign
 * locked the conversation out of its own machine. */
describe('conversation lease only fences other installations', () => {
  it('takes over an orphan lease left by a previous session of this installation', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    // Session that never released its lease (app killed mid-turn).
    const orphan = await repository.acquireConversationLease('conv-1')
    const taken = await repository.acquireConversationLease('conv-1')

    expect(taken.ownerInstallationId).toBe('device-a')
    expect(taken.fencingEpoch).toBeGreaterThan(orphan.fencingEpoch)
    await repository.close()
  })

  it('lets this installation write without a fence while it holds the lease', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()
    await repository.acquireConversationLease('conv-1')

    // A plain renderer save (draft/title/streaming) carries no lease.
    const stored = await repository.upsertConversation({
      id: 'conv-1',
      payload: { id: 'conv-1', title: 'Sem fence' }
    })

    expect(stored.revision).toBeGreaterThan(0)
    await repository.close()
  })

  it('still refuses a write when another installation holds the lease', async () => {
    const { cache, dbPath } = await tempCache()
    const mine = new SqliteRepository(cache, dbPath, 'device-a')
    await mine.initialize()
    const theirs = new SqliteRepository(cache, dbPath, 'device-b')
    await theirs.initialize()
    await theirs.acquireConversationLease('conv-1')
    // The in-memory lease map belongs to each instance, so mirror the foreign
    // lease into the instance under test the same way a shared store would.
    const foreign = await theirs.acquireConversationLease('conv-1')
    ;(mine as unknown as { leases: Map<string, unknown> }).leases.set('conv-1', foreign)

    await expect(mine.acquireConversationLease('conv-1')).rejects.toBeInstanceOf(StorageError)
    await expect(
      mine.upsertConversation({ id: 'conv-1', payload: { id: 'conv-1', title: 'x' } })
    ).rejects.toBeInstanceOf(StorageError)
    await mine.close()
    await theirs.close()
  })
})

describe('token usage — llm_calls / llm_usage_totals', () => {
  it('grava a chamada, incrementa o agregado do dia e devolve tudo por conv_id', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    const root = await repository.insertLlmCall({
      convId: 'conv-1',
      turnId: 'turn-1',
      nodeId: 'turn-1',
      parentNodeId: null,
      seq: 1,
      model: 'claude-test',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      inputPreview: 'oi',
      outputPreview: 'olá'
    })
    expect(root.convId).toBe('conv-1')
    expect(root.parentNodeId).toBeNull()
    expect(root.subagentType).toBeNull()

    const child = await repository.insertLlmCall({
      convId: 'conv-1',
      turnId: 'turn-1',
      nodeId: 'sub-1',
      parentNodeId: 'turn-1',
      subagentType: 'general-purpose',
      taskDescription: 'pesquisar X',
      seq: 1,
      model: 'claude-test',
      inputTokens: 50,
      outputTokens: 10,
      costUsd: 0.02
    })
    expect(child.parentNodeId).toBe('turn-1')
    expect(child.subagentType).toBe('general-purpose')

    // Segunda chamada no MESMO dia/modelo/subagente (raiz) — soma no lugar de duplicar.
    await repository.insertLlmCall({
      convId: 'conv-1',
      turnId: 'turn-2',
      nodeId: 'turn-2',
      seq: 1,
      model: 'claude-test',
      inputTokens: 30,
      outputTokens: 5
    })

    const calls = await repository.listLlmCalls('conv-1')
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.nodeId)).toEqual(['turn-1', 'sub-1', 'turn-2'])

    const totals = await repository.listLlmUsageTotals('conv-1')
    // Uma linha para a raiz (subagentType null → chave '') e outra para o subagente.
    expect(totals).toHaveLength(2)
    const rootTotal = totals.find((t) => t.subagentType === null)!
    expect(rootTotal.callCount).toBe(2)
    expect(rootTotal.sumInput).toBe(130)
    expect(rootTotal.sumOutput).toBe(25)
    expect(rootTotal.sumCost).toBeCloseTo(0.01)
    const subTotal = totals.find((t) => t.subagentType === 'general-purpose')!
    expect(subTotal.callCount).toBe(1)
    expect(subTotal.sumInput).toBe(50)
    expect(subTotal.sumCost).toBeCloseTo(0.02)

    expect(await repository.listLlmCalls('conv-outra')).toEqual([])
    expect(await repository.listLlmUsageTotals('conv-outra')).toEqual([])

    await repository.close()
  })

  it('cost_usd nulo não quebra o agregado (fica null quando nenhuma chamada tem preço)', async () => {
    const { cache, dbPath } = await tempCache()
    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    await repository.insertLlmCall({
      convId: 'conv-2',
      turnId: 'turn-1',
      nodeId: 'turn-1',
      seq: 1,
      model: 'modelo-sem-preco',
      inputTokens: 10,
      outputTokens: 2
    })
    const totals = await repository.listLlmUsageTotals('conv-2')
    expect(totals).toHaveLength(1)
    expect(totals[0].sumCost).toBeNull()

    await repository.close()
  })
})
