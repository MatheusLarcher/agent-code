import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { SqliteRepository } from './sqliteRepository'
import { importRepositoryToPostgres } from './postgresTransfer'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const draft: PostgresConnectionDraft = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  user: 'postgres',
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

async function dropTarget(): Promise<void> {
  const client = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
  await client.connect()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

async function repository(installationId: string): Promise<PostgresRepository> {
  const provisioned = await provisionPostgres(draft, installationId, 'test')
  const result = new PostgresRepository(
    provisioned.pool,
    postgresClientConfig(draft, POSTGRES_DATABASE),
    installationId,
    'test'
  )
  await result.initialize()
  return result
}

describe.runIf(integration).sequential('PostgresRepository', () => {
  const opened: PostgresRepository[] = []

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('isola KV device, compartilha KV global e aplica CAS/tombstone', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)

    await left.setKv({ scope: 'device', key: 'device-only', value: 'A' })
    expect(await right.getKv({ scope: 'device', key: 'device-only' })).toBeNull()
    await left.setKv({ scope: 'global', key: 'shared', value: 'global' })
    expect(await right.getKv({ scope: 'global', key: 'shared' })).toMatchObject({ value: 'global' })

    const created = await left.upsertConversation({ id: 'c1', payload: { id: 'c1', title: 'A' } })
    const updated = await right.upsertConversation({
      id: 'c1',
      payload: { id: 'c1', title: 'B' },
      expectedRevision: created.revision
    })
    await expect(
      left.upsertConversation({
        id: 'c1',
        payload: { id: 'c1', title: 'stale' },
        expectedRevision: created.revision
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await right.deleteConversation({ id: 'c1', expectedRevision: updated.revision })
    expect(await left.loadConversations()).toEqual([])
    expect((await left.loadConversations({ includeDeleted: true }))[0]?.deletedAt).toBeDefined()
  })

  it('propaga change_log por LISTEN e recupera pelo cursor durável', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    const seen = new Promise<void>((resolve) => {
      const off = right.subscribe((changes) => {
        if (changes.some((change) => change.entity === 'conversation' && change.entityId === 'sync')) {
          off()
          resolve()
        }
      })
    })
    await left.upsertConversation({ id: 'sync', payload: { id: 'sync', title: 'Sincronizada' } })
    await expect(Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000))])).resolves.toBeUndefined()
    expect((await right.loadConversations())[0]?.payload.title).toBe('Sincronizada')
  })

  it('preserva NUL de KV, JSONB e SessionStore por codificação reversível', async () => {
    const left = await repository(randomUUID())
    opened.push(left)
    await left.setKv({ scope: 'device', key: 'nul-kv', value: 'antes\0depois' })
    expect((await left.getKv({ scope: 'device', key: 'nul-kv' }))?.value).toBe('antes\0depois')

    const payload = { id: 'nul-conversation', title: 'NUL', nested: { 'key\0': 'value\0' } }
    await left.upsertConversation({ id: 'nul-conversation', payload })
    expect((await left.loadConversations()).find((item) => item.id === 'nul-conversation')?.payload).toMatchObject(payload)

    const store = left.createSessionStore('nul-conversation')
    const key = { projectKey: 'ignored', sessionId: randomUUID() }
    await store.append(key, [{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'NUL\0entry' } }])
    expect(JSON.stringify(await store.load(key))).toContain('NUL\\u0000entry')
  })

  it('compartilha identidade do projeto sem vazar o caminho local entre instalações', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    const projectId = randomUUID()
    const shared = { projectId, projectSignature: 'stable-signature', projectRemoteGit: 'github.com/org/repo' }
    const created = await left.upsertConversation({
      id: 'mapped',
      payload: { id: 'mapped', title: 'Projeto', cwd: 'C:\\work\\repo', ...shared }
    })

    expect((await right.loadConversations())[0]?.payload.cwd).toBe('')
    await right.upsertConversation({
      id: 'mapped',
      expectedRevision: created.revision,
      payload: { ...(await right.loadConversations())[0].payload, cwd: 'D:\\clone\\repo' }
    })

    expect((await right.loadConversations())[0]?.payload.cwd).toBe('D:\\clone\\repo')
    expect((await left.loadConversations())[0]?.payload.cwd).toBe('C:\\work\\repo')
  })

  it('usa relógio PostgreSQL, lease e fencing para impedir writer antigo', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    const created = await left.upsertConversation({ id: 'lease', payload: { id: 'lease', title: 'A' } })
    const first = await left.acquireConversationLease('lease')
    await expect(right.acquireConversationLease('lease')).rejects.toMatchObject({
      code: 'LEASE_HELD_BY_OTHER_DEVICE'
    })
    await left.releaseConversationLease(first)
    const second = await right.acquireConversationLease('lease')
    expect(second.fencingEpoch).toBeGreaterThan(first.fencingEpoch)
    await expect(
      left.upsertConversation({
        id: 'lease',
        payload: { id: 'lease', title: 'writer antigo' },
        expectedRevision: created.revision,
        lease: first
      })
    ).rejects.toMatchObject({ code: 'LEASE_HELD_BY_OTHER_DEVICE' })
    const renewed = await right.renewConversationLease(second)
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('preserva SessionStore opaco, UUID idempotente, ordem sem UUID e subagentes', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    await left.upsertConversation({ id: 'session', payload: { id: 'session', title: 'Sessão' } })
    const store = left.createSessionStore('session')
    const key = { projectKey: 'ignored-a', sessionId: 'sdk-1' }
    const timestamp = new Date().toISOString()
    const withUuid = { type: 'user', uuid: 'uuid-1', timestamp, message: { role: 'user', content: 'fato' } }
    const withoutUuid = { type: 'custom-title', timestamp, customTitle: 'Título' }
    await store.append(key, [withUuid, withoutUuid])
    await store.append(key, [withUuid, withoutUuid])
    await store.append({ ...key, subpath: 'subagents/a.jsonl' }, [
      { type: 'assistant', uuid: 'sub-1', timestamp, message: { role: 'assistant', content: 'ok' } }
    ])

    const remote = right.createSessionStore('session')
    const loaded = await remote.load({ projectKey: 'ignored-b', sessionId: 'sdk-1' })
    expect(loaded?.filter((entry) => entry.uuid === 'uuid-1')).toHaveLength(1)
    expect(loaded?.filter((entry) => entry.type === 'custom-title')).toHaveLength(2)
    expect(await remote.listSubkeys?.(key)).toEqual(['subagents/a.jsonl'])
    expect(await remote.listSessionSummaries?.('ignored')).toHaveLength(1)

    await remote.delete?.(key)
    expect(await remote.load(key)).toBeNull()
    expect(await remote.load({ ...key, subpath: 'subagents/a.jsonl' })).toBeNull()
    expect(await remote.listSessions?.('ignored')).toEqual([])
    expect(await remote.listSessionSummaries?.('ignored')).toEqual([])
  })

  it('preserva transcript divergente como fork público em conversa de conflito retomável', async () => {
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    const target = new PostgresRepository(
      provisioned.pool,
      postgresClientConfig(draft, POSTGRES_DATABASE),
      installationId,
      'test'
    )
    await target.initialize()
    opened.push(target)
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-session-fork-'))
    const source = new SqliteRepository(dir, join(dir, 'agent-code.db'), installationId)
    await source.initialize()
    const conversationId = 'divergent-session'
    const sessionId = randomUUID()
    const payload = { id: conversationId, title: 'Sessão divergente', sdkSessionId: sessionId }
    await source.upsertConversation({ id: conversationId, payload })
    await target.upsertConversation({ id: conversationId, payload })
    const entry = (content: string) => ({
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      message: { role: 'user', content }
    })
    await source.createSessionStore(conversationId).append(
      { projectKey: conversationId, sessionId },
      [entry('fonte SQLite')]
    )
    await target.createSessionStore(conversationId).append(
      { projectKey: conversationId, sessionId },
      [entry('destino PostgreSQL')]
    )

    await importRepositoryToPostgres(provisioned.pool, source, installationId, randomUUID())
    const conversations = await target.loadConversations()
    const conflict = conversations.find((item) => item.payload.legacyConflictOf === conversationId)
    expect(conflict).toBeDefined()
    const forkedSessionId = conflict?.payload.sdkSessionId as string
    expect(forkedSessionId).not.toBe(sessionId)
    expect(await target.sessionResumeReady(conflict!.id, forkedSessionId)).toBe(true)
    const messages = await getSessionMessages(forkedSessionId, {
      sessionStore: target.createSessionStore(conflict!.id)
    })
    expect(messages.some((message) => JSON.stringify(message.message).includes('fonte SQLite'))).toBe(true)
    await source.close()
  })
})
