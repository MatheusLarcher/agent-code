// @vitest-environment node
// Rascunho com anexos (draftMedia) é estado do DISPOSITIVO, como o draft.
// A parte "unit" roda sempre; a parte com PostgreSQL real liga com
// AGENT_CODE_PG_INTEGRATION=1 (ver postgresRepository.test.ts), e usa o mesmo
// banco 'agent-code': rode sem paralelismo com os outros postgres*.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { mergeDeviceState, splitDeviceFields } from './conversationScope'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { SqliteRepository } from './sqliteRepository'
import { importRepositoryToPostgres } from './postgresTransfer'

const MEDIA_A = [{ kind: 'image', name: 'a.png', mediaType: 'image/png', path: 'C:\\A\\attachments\\c1\\1-1-a.png', size: 10 }]

describe('conversationScope (unit)', () => {
  it('cwd, draft e draftMedia vão para o dispositivo; o compartilhado não leva nenhum', () => {
    const { shared, device } = splitDeviceFields({ id: 'c1', title: 't', cwd: 'C:\\p', draft: 'ver {{midia:1}}', draftMedia: MEDIA_A })
    expect(shared).toEqual({ id: 'c1', title: 't' })
    expect(device).toEqual({ cwd: 'C:\\p', draft: 'ver {{midia:1}}', draftMedia: MEDIA_A })
  })

  it('leitura: B não herda o draftMedia legado de A que ficou no compartilhado', () => {
    const legacyShared = { id: 'c1', title: 't', draftMedia: MEDIA_A }
    expect(mergeDeviceState(legacyShared, { draft: 'texto de B' })).toEqual({ id: 'c1', title: 't', draft: 'texto de B' })
    expect(mergeDeviceState(legacyShared, {})).toEqual({ id: 'c1', title: 't' })
    // O dono do rascunho legado (marcador no PRÓPRIO draft, sem lista própria) continua lendo o dele.
    expect(mergeDeviceState(legacyShared, { draft: 'ver {{midia:1}}' }).draftMedia).toEqual(MEDIA_A)
    // Com lista própria, vale a do dispositivo.
    const own = [{ ...MEDIA_A[0], path: 'D:\\B\\x.png' }]
    expect(mergeDeviceState(legacyShared, { draft: 'ver {{midia:1}}', draftMedia: own }).draftMedia).toEqual(own)
  })
})

describe('caminho SQLite (um dispositivo só)', () => {
  it('draftMedia faz ida e volta inteiro no SQLite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-sqlite-'))
    const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), randomUUID())
    await repo.initialize()
    try {
      await repo.upsertConversation({ id: 'c1', payload: { id: 'c1', title: 't', draft: 'ver {{midia:1}}', draftMedia: MEDIA_A } })
      const [loaded] = await repo.loadConversations()
      expect(loaded.payload.draft).toBe('ver {{midia:1}}')
      expect(loaded.payload.draftMedia).toEqual(MEDIA_A)
    } finally {
      await repo.close()
    }
  })
})

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const pg: PostgresConnectionDraft = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  user: 'postgres',
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

async function dropTarget(): Promise<void> {
  const client = new Client(postgresClientConfig(pg, pg.maintenanceDatabase))
  await client.connect()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

describe.runIf(integration).sequential('draftMedia no PostgreSQL: estado do dispositivo', () => {
  const opened: PostgresRepository[] = []
  const repository = async (installationId: string): Promise<PostgresRepository> => {
    const provisioned = await provisionPostgres(pg, installationId, 'test')
    const repo = new PostgresRepository(provisioned.pool, postgresClientConfig(pg, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    opened.push(repo)
    return repo
  }

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((r) => r.close().catch(() => undefined)))
  })

  it('a máquina B não herda nem apaga o draftMedia da A', async () => {
    const a = await repository(randomUUID())
    const b = await repository(randomUUID())
    const created = await a.upsertConversation({
      id: 'c1',
      payload: { id: 'c1', title: 'Conversa', draft: 'ver {{midia:1}}', draftMedia: MEDIA_A }
    })
    expect(created.payload.draftMedia).toEqual(MEDIA_A)

    // B lê: nem o rascunho nem os anexos de A.
    const seenByB = (await b.loadConversations())[0].payload
    expect(seenByB.draft).toBeUndefined()
    expect(seenByB.draftMedia).toBeUndefined()

    // B grava a conversa (o blur de B: rascunho só texto, sem lista) ...
    await b.upsertConversation({
      id: 'c1',
      expectedRevision: created.revision,
      payload: { ...seenByB, draft: 'texto de B', title: 'Renomeada em B' }
    })
    // ... e A continua com o rascunho e os anexos dela; o título, compartilhado, mudou.
    const seenByA = (await a.loadConversations())[0].payload
    expect(seenByA.title).toBe('Renomeada em B')
    expect(seenByA.draft).toBe('ver {{midia:1}}')
    expect(seenByA.draftMedia).toEqual(MEDIA_A)
    expect((await b.loadConversations())[0].payload.draftMedia).toBeUndefined()

    // O payload COMPARTILHADO no banco não tem draftMedia nenhum.
    const client = new Client(postgresClientConfig(pg, POSTGRES_DATABASE))
    await client.connect()
    try {
      const row = await client.query<{ payload: Record<string, unknown> }>('SELECT payload FROM conversations WHERE conversation_id = $1', ['c1'])
      expect(row.rows[0].payload).not.toHaveProperty('draftMedia')
      expect(row.rows[0].payload).not.toHaveProperty('draft')
    } finally {
      await client.end()
    }
  })

  it('migração SQLite -> PostgreSQL leva o draftMedia para o estado do dispositivo', async () => {
    const installation = randomUUID()
    const dir = await mkdtemp(join(tmpdir(), 'scope-transfer-'))
    const source = new SqliteRepository(dir, join(dir, 'agent-code.db'), installation)
    await source.initialize()
    await source.upsertConversation({ id: 'c9', payload: { id: 'c9', title: 't', draft: 'ver {{midia:1}}', draftMedia: MEDIA_A } })
    const provisioned = await provisionPostgres(pg, installation, 'test')
    await importRepositoryToPostgres(provisioned.pool, source, installation, randomUUID())
    await provisioned.pool.end()
    await source.close()

    const same = await repository(installation)
    const other = await repository(randomUUID())
    expect((await same.loadConversations())[0].payload.draftMedia).toEqual(MEDIA_A)
    expect((await other.loadConversations())[0].payload.draftMedia).toBeUndefined()
  })
})
