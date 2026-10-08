// @vitest-environment node
// PostgreSQL real descartável, opt-in como os outros testes live:
// AGENT_CODE_PG_INTEGRATION=1 AGENT_CODE_PG_PORT=55433 npx vitest run --no-file-parallelism src/main/persistence/writeQueue/conversationWriteQueue.live.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { POSTGRES_DATABASE } from '../bootstrapStore'
import { postgresClientConfig, provisionPostgres } from '../postgresProvisioning'
import { PostgresRepository } from '../postgresRepository'
import type { ConversationRecord } from '../types'
import { prepareConversation } from './conversationPrepare'
import { ConversationJournal } from './conversationJournal'
import { ConversationWriteQueue } from './conversationWriteQueue'
import { inlinePreparer } from './preparer'
import { full } from './queueTestKit'

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

const PROJECT_ID = randomUUID()
const CREATED_AT = Date.now()
const doc = (messages: string[], extra: Record<string, unknown> = {}): ConversationRecord => ({
  id: 'c1', title: 'Teste', cwd: 'C:/proj', createdAt: CREATED_AT, updatedAt: 1,
  messages: messages.map((text, i) => ({ kind: 'user', id: `m${i}`, text })), ...extra
})

describe.runIf(integration).sequential('ConversationWriteQueue com PostgreSQL de verdade', () => {
  let repo: PostgresRepository
  let other: PostgresRepository
  let dir: string
  const queues: ConversationWriteQueue[] = []

  const queueFor = (installationId: string): ConversationWriteQueue => {
    const queue = new ConversationWriteQueue({
      repository: () => repo,
      preparer: inlinePreparer,
      journal: new ConversationJournal(join(dir, 'fila')),
      lease: () => undefined,
      identity: async () => ({ projectId: PROJECT_ID, signature: 'sig-1', remoteGit: '' }),
      installationId: () => installationId,
      onStatus: () => undefined,
      onResync: () => undefined,
      onCentralRemote: () => undefined,
      log: (line) => console.warn(line)
    })
    queues.push(queue)
    return queue
  }
  const stored = async () => (await repo.loadConversations({ ids: ['c1'], includeDeleted: true }))[0]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-code-fila-live-'))
    const admin = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
    await admin.connect()
    try {
      await admin.query('DROP DATABASE IF EXISTS "agent-code"')
    } finally {
      await admin.end()
    }
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    repo = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    const otherId = randomUUID()
    const second = await provisionPostgres(draft, otherId, 'test')
    other = new PostgresRepository(second.pool, postgresClientConfig(draft, POSTGRES_DATABASE), otherId, 'test')
    await other.initialize()
  })

  afterEach(async () => {
    for (const queue of queues.splice(0)) queue.dispose()
    await repo?.close()
    await other?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('grava; o mesmo conteúdo (outra ordem de chaves) não vira revisão; mudar só o rascunho não muda a revisão', async () => {
    const queue = queueFor('pc-a')
    const base = doc(['oi'], { draft: '' })
    queue.apply([full(base, true)])
    await expect(queue.flush(['c1'], 5_000)).resolves.toBe(true)
    const first = await stored()
    expect(first).toMatchObject({ revision: 1, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(first.payload).toMatchObject({ title: 'Teste', effortSplit: true })

    const { messages, ...top } = base
    queue.apply([full({ messages, ...Object.fromEntries(Object.entries(top).reverse()) }, true)])
    await expect(queue.flush(['c1'], 5_000)).resolves.toBe(true)
    expect((await stored()).revision).toBe(1)

    queue.apply([{ id: 'c1', top: { ...top, draft: 'rascunho daqui' }, urgent: true }])
    await expect(queue.flush(['c1'], 5_000)).resolves.toBe(true)
    const afterDraft = await stored()
    expect(afterDraft.revision).toBe(1)
    expect(afterDraft.payload).toMatchObject({ draft: 'rascunho daqui' })
  })

  it('outro writer avançou a linha: relê e grava por cima; apagar vira tombstone; o diário reaplicado não duplica', async () => {
    const queue = queueFor('pc-a')
    queue.apply([full(doc(['minha']), true)])
    await queue.flush(['c1'], 5_000)
    queue.remember([await stored()])
    // O outro PC grava a rev 2 por fora da fila daqui.
    await other.writeConversation({ id: 'c1', prepared: prepareConversation(doc(['deles'], { title: 'Do outro PC', projectId: PROJECT_ID, projectSignature: 'sig-1' }), 'shared'), expectedRevision: 1 })
    queue.apply([full(doc(['minha', 'nova']), true)])
    await expect(queue.flush(['c1'], 5_000)).resolves.toBe(true)
    const rebased = await stored()
    expect(rebased.revision).toBe(3)
    expect((rebased.payload.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['minha', 'nova'])

    // Uma abertura nova reaplica o diário com o mesmo conteúdo: nada muda.
    const restored = queueFor('pc-a')
    restored.restore([{ id: 'c1', deleted: false, doc: doc(['minha', 'nova']), since: Date.now() }])
    await expect(restored.flush(['c1'], 5_000)).resolves.toBe(true)
    expect((await stored()).revision).toBe(3)

    queue.apply([{ id: 'c1', deleted: true, urgent: true }])
    await expect(queue.flush(['c1'], 5_000)).resolves.toBe(true)
    expect(await stored()).toMatchObject({ revision: 4, deletedAt: expect.any(String) })
  })

  it('muitas conversas novas no MESMO projeto novo, gravadas em paralelo: todas entram (sem estourar a assinatura do projeto)', async () => {
    const queue = queueFor('pc-a')
    const ids = Array.from({ length: 24 }, (_, i) => `nova-${i}`)
    queue.apply(ids.map((id) => full({ ...doc([`oi ${id}`]), id }, true)))
    await expect(queue.flush(ids, 15_000)).resolves.toBe(true)
    const rows = await repo.loadConversations({ ids })
    expect(rows.map((row) => row.revision)).toEqual(ids.map(() => 1))
    expect(queue.status()).toMatchObject({ state: 'saved', pending: 0 })
  })
})
