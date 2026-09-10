// @vitest-environment node
// Integração real com PostgreSQL. Ligada por AGENT_CODE_PG_INTEGRATION=1; sem
// a variável, os casos são pulados e a suíte normal roda sem precisar de banco.
//
// Suba o servidor e rode SEM paralelismo entre arquivos: este arquivo e
// postgresProvisioning.test.ts recriam o MESMO banco 'agent-code', então em
// paralelo um derruba as conexões do outro (FATAL 57P01) e a falha parece um
// bug do código.
//
//   docker run -d --name agent-code-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=agent-code-test-password postgres:16-alpine
//   AGENT_CODE_PG_INTEGRATION=1 npx vitest run --no-file-parallelism src/main/persistence/postgres*.test.ts
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

  it('invalida lease órfão da própria instalação ao reiniciar sem tocar em outro dispositivo', async () => {
    const installationId = randomUUID()
    const owner = await repository(installationId)
    const other = await repository(randomUUID())
    opened.push(owner, other)
    await owner.upsertConversation({ id: 'orphan', payload: { id: 'orphan', title: 'A' } })
    await owner.acquireConversationLease('orphan')

    await owner.close()
    opened.splice(opened.indexOf(owner), 1)
    const restarted = await repository(installationId)
    opened.push(restarted)
    const acquired = await other.acquireConversationLease('orphan')

    expect(acquired.ownerInstallationId).not.toBe(installationId)
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
  // ---------------------------------------------------------------------
  // Task ledger and memory service. SQLite already covers the state machine
  // and the CAS rules; what only a real PostgreSQL can prove is what happens
  // when two installations hit the same row at the same instant, and that the
  // server clock — not the caller's — decides whether a lease is still alive.
  // ---------------------------------------------------------------------

  it('entrega tarefas distintas a duas instalações que reivindicam ao mesmo tempo', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)

    const base = { projectCwd: 'C:/proj', goal: 'meta' }
    // acceptance é uma LISTA: passada crua a uma coluna jsonb, o driver a
    // renderiza como array do Postgres — `[]` chega como `{}` e uma lista com
    // itens estoura em "invalid input syntax for type json".
    await left.createTask({ ...base, id: 'task-a', title: 'A', acceptance: ['typecheck', 'testes'] })
    await left.createTask({ ...base, id: 'task-b', title: 'B' })
    expect((await right.getTask('task-a'))?.acceptance).toEqual(['typecheck', 'testes'])
    expect((await right.getTask('task-b'))?.acceptance).toEqual([])

    // Sem SKIP LOCKED, uma das duas ficaria bloqueada esperando a outra e no
    // fim as duas pegariam a MESMA tarefa — dois agentes no mesmo trabalho.
    const [first, second] = await Promise.all([left.claimTask('agente-1'), right.claimTask('agente-2')])
    expect(first?.task.id).toBeDefined()
    expect(second?.task.id).toBeDefined()
    expect(first!.task.id).not.toBe(second!.task.id)
    expect(new Set([first!.task.id, second!.task.id])).toEqual(new Set(['task-a', 'task-b']))
    expect(await left.claimTask('agente-3')).toBeNull()

    // A tarefa reivindicada por uma instalação é visível na outra: o registro
    // é global, não estado local de quem reivindicou.
    const seenByRight = await right.getTask('task-a')
    expect(seenByRight?.ownerAgent).toBe(first!.task.id === 'task-a' ? 'agente-1' : 'agente-2')
  })

  it('rejeita escrita com fence velho depois que a tarefa foi reivindicada de novo', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    await left.createTask({ projectCwd: 'C:/proj', id: 'fence', title: 'F', goal: 'meta' })

    const original = await left.claimTask('agente-1')
    expect(original).not.toBeNull()
    // Único caminho de volta ao pool: running → failed (terminal, libera o
    // lease) → pending. A próxima reivindicação sobe o fencing epoch.
    await left.transitionTask({ taskId: 'fence', from: 'pending', to: 'running', fence: original! })
    await left.transitionTask({ taskId: 'fence', from: 'running', to: 'failed', fence: original! })
    await left.transitionTask({ taskId: 'fence', from: 'failed', to: 'pending' })
    const renewed = await right.claimTask('agente-2')
    expect(renewed!.fencingEpoch).toBeGreaterThan(original!.fencingEpoch)

    // O dono antigo pode não saber que perdeu; a barreira é do banco.
    await expect(
      left.appendTaskStep({ taskId: 'fence', kind: 'implement', fence: original! })
    ).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    await expect(left.renewTaskLease('fence', original!)).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    await expect(
      right.appendTaskStep({ taskId: 'fence', kind: 'implement', fence: renewed! })
    ).resolves.toMatchObject({ seq: 1 })
  })

  it('propaga evento de tarefa por change_log entre instalações', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    const seen = new Promise<void>((resolve) => {
      const off = right.subscribe((changes) => {
        if (changes.some((change) => change.entity === 'task' && change.entityId === 'feed')) {
          off()
          resolve()
        }
      })
    })
    await left.createTask({ projectCwd: 'C:/proj', id: 'feed', title: 'Feed', goal: 'meta' })
    await expect(
      Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000))])
    ).resolves.toBeUndefined()
    expect((await right.listTaskEvents('feed'))[0]?.kind).toBe('created')
  })

  it('serializa criação concorrente da mesma memória: uma vence, a outra é conflito', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)

    const write = (title: string) => ({
      relPath: 'disputada.md',
      title,
      hook: 'gancho',
      scope: 'user' as const,
      body: `corpo ${title}`,
      status: 'active' as const,
      // 0 = "não existe ainda". Duas criações simultâneas mandam o mesmo valor.
      expectedRevision: 0
    })
    // Sem o advisory lock por rel_path, um FOR UPDATE não protege uma linha
    // AUSENTE: as duas transações leem "não existe" e as duas inserem.
    const results = await Promise.allSettled([
      left.writeMemoryEntry(write('esquerda')),
      right.writeMemoryEntry(write('direita'))
    ])
    const ok = results.filter((item) => item.status === 'fulfilled')
    const failed = results.filter((item) => item.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await left.listMemoryEntries()).toHaveLength(1)
  })

  it('entrega propostas distintas a dois curadores e aplica a entrada uma vez só', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)

    const proposal = (relPath: string) => ({
      op: 'create' as const,
      relPath,
      title: relPath,
      hook: 'gancho',
      body: 'corpo',
      scope: 'user' as const,
      proposedBy: 'curator'
    })
    await left.enqueueMemoryProposal(proposal('uma.md'))
    await left.enqueueMemoryProposal(proposal('outra.md'))

    const [a, b] = await Promise.all([left.claimMemoryProposal(), right.claimMemoryProposal()])
    expect(a!.proposal.relPath).not.toBe(b!.proposal.relPath)
    expect(await left.claimMemoryProposal()).toBeNull()

    const settled = await left.settleMemoryProposal({
      proposalId: a!.proposal.id,
      token: a!.token,
      outcome: 'applied',
      entry: {
        relPath: a!.proposal.relPath,
        title: 'Aplicada',
        hook: 'gancho',
        scope: 'user',
        body: 'corpo aplicado',
        status: 'active',
        expectedRevision: 0
      }
    })
    expect(settled.status).toBe('applied')
    expect(settled.entryId).toBeTruthy()
    // Token consumido: reaplicar com o mesmo lease não pode gravar de novo.
    await expect(
      left.settleMemoryProposal({
        proposalId: a!.proposal.id,
        token: a!.token,
        outcome: 'rejected',
        reason: 'tarde demais'
      })
    ).rejects.toBeDefined()
    expect(await right.getMemoryEntryByPath(a!.proposal.relPath)).toMatchObject({ title: 'Aplicada' })
  })

  it('propaga memória aplicada por change_log e só descarta proposta liquidada', async () => {
    const left = await repository(randomUUID())
    const right = await repository(randomUUID())
    opened.push(left, right)
    const seen = new Promise<void>((resolve) => {
      const off = right.subscribe((changes) => {
        if (changes.some((change) => change.entity === 'memory' && change.entityId === 'propagada.md')) {
          off()
          resolve()
        }
      })
    })
    await left.writeMemoryEntry({
      relPath: 'propagada.md',
      title: 'Propagada',
      hook: 'gancho',
      scope: 'user',
      body: 'corpo',
      status: 'active',
      expectedRevision: 0
    })
    await expect(
      Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000))])
    ).resolves.toBeUndefined()

    const pending = await left.enqueueMemoryProposal({
      op: 'create',
      relPath: 'pendente.md',
      title: 'Pendente',
      hook: 'gancho',
      body: 'corpo',
      scope: 'user',
      proposedBy: 'curator'
    })
    // Descartar é para a lista de conflitos da tela; uma proposta viva não pode
    // sumir por baixo do curador que ainda vai processá-la.
    await expect(right.deleteMemoryProposal(pending.id)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    const claim = await left.claimMemoryProposal()
    await left.settleMemoryProposal({
      proposalId: claim!.proposal.id,
      token: claim!.token,
      outcome: 'conflict',
      reason: 'revisão mudou'
    })
    expect(await right.deleteMemoryProposal(pending.id)).toBe(true)
    expect(await right.deleteMemoryProposal(pending.id)).toBe(false)
  })
})
