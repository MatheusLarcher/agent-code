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
import { boardItemStatus } from '../../shared/ipc'
import type { BoardItem, BoardSourceItem } from './types'
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

const BOARD_PROJECT = 'proj-board'
const BOARD_CWD = 'C:/GitHub/agent-code'
const BOARD_CONVERSATION = 'conv-board'

function boardSource(
  sourceId: string,
  title: string,
  status: BoardSourceItem['status'],
  patch: Partial<BoardSourceItem> = {}
): BoardSourceItem {
  return { sourceId, title, status, activeForm: null, seq: 0, ...patch }
}

/** O snapshot que o agente reescreve inteiro a cada mudança na lista dele. */
function syncBoard(target: PostgresRepository, items: BoardSourceItem[]): Promise<BoardItem[]> {
  return target.syncBoardItems({
    projectId: BOARD_PROJECT,
    projectCwd: BOARD_CWD,
    conversationId: BOARD_CONVERSATION,
    items
  })
}

function readBoard(target: PostgresRepository): Promise<BoardItem[]> {
  return target.listBoardItems({ projectIds: [BOARD_PROJECT] })
}

describe.runIf(integration).sequential('PostgresRepository', () => {
  const opened: PostgresRepository[] = []

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('a fila do projeto é uma só para dois PCs com caminhos diferentes', async () => {
    // O ponto do registro compartilhado. Antes da identidade estável, cada
    // instalação filtrava pelo `project_cwd` DELA e só via a própria fila.
    const pcA = await repository(randomUUID())
    const pcB = await repository(randomUUID())
    opened.push(pcA, pcB)

    const cwdA = 'C:/GitHub/agent-code'
    const cwdB = '/home/matheus/dev/agent-code'
    await pcA.recordProjectIdentity({ projectCwd: cwdA, projectId: 'proj-1', signature: 'sig-1' })
    await pcB.recordProjectIdentity({ projectCwd: cwdB, projectId: 'proj-1', signature: 'sig-1' })
    // Um projeto diferente não pode vazar para dentro do recorte.
    await pcB.recordProjectIdentity({ projectCwd: '/home/matheus/outro', projectId: 'proj-2', signature: 'sig-2' })

    const cwds = await pcA.projectCwdsForIdentity('proj-1')
    expect([...cwds].sort()).toEqual([cwdA, cwdB].sort())

    // Tarefa deixada no PC B, com o caminho de lá.
    const task = await pcB.createTask({ projectCwd: cwdB, title: 'do outro PC', goal: 'g' })
    await pcA.createTask({ projectCwd: '/home/matheus/outro', title: 'de outro projeto', goal: 'g' })

    // Do PC A: pelo caminho local não aparece; pelos equivalentes, sim.
    expect(await pcA.listTasks({ projectCwd: cwdA })).toHaveLength(0)
    expect((await pcA.listTasks({ projectCwds: cwds })).map((t) => t.id)).toEqual([task.id])

    const claim = await pcA.claimTask('session:pc-a', { projectCwds: cwds })
    expect(claim?.task.id).toBe(task.id)

    // Recorte vazio é "nenhum projeto", nunca "todos".
    expect(await pcA.listTasks({ projectCwds: [] })).toEqual([])
    expect(await pcA.claimTask('session:pc-a', { projectCwds: [] })).toBeNull()

    // Upsert: o mesmo caminho reapontado não duplica linha.
    await pcA.recordProjectIdentity({ projectCwd: cwdA, projectId: 'proj-1', signature: 'sig-nova' })
    expect(await pcA.projectCwdsForIdentity('proj-1')).toHaveLength(2)
  })

  it('fila de espera da conversa (conversation_outbox) sobrevive a reabrir e troca por conversa', async () => {
    const installation = randomUUID()
    const first = await repository(installation)
    opened.push(first)
    await first.replaceConversationOutbox('conv-a', [
      { id: 'q1', payload: { text: 'um' } },
      { id: 'q2', payload: { text: 'dois' } }
    ])
    await first.replaceConversationOutbox('conv-b', [{ id: 'q9', payload: { text: 'manager' } }])
    await first.replaceConversationOutbox('conv-a', [{ id: 'q2', payload: { text: 'dois' } }])
    const again = await repository(installation)
    opened.push(again)
    expect((await again.listConversationOutbox()).map((i) => [i.conversationId, i.id, i.payload])).toEqual([
      ['conv-a', 'q2', { text: 'dois' }],
      ['conv-b', 'q9', { text: 'manager' }]
    ])
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

  it('grava chamada de LLM, incrementa o agregado e consulta por conv_id', async () => {
    const repo = await repository(randomUUID())
    opened.push(repo)

    const root = await repo.insertLlmCall({
      convId: 'conv-pg-1',
      turnId: 'turn-1',
      nodeId: 'turn-1',
      seq: 1,
      model: 'claude-test',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      costUsd: 0.01,
      inputPreview: 'oi',
      outputPreview: 'olá'
    })
    expect(root.convId).toBe('conv-pg-1')
    expect(root.subagentType).toBeNull()

    await repo.insertLlmCall({
      convId: 'conv-pg-1',
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
    // Segunda chamada da raiz no mesmo dia/modelo — soma no agregado, não duplica.
    await repo.insertLlmCall({
      convId: 'conv-pg-1',
      turnId: 'turn-2',
      nodeId: 'turn-2',
      seq: 1,
      model: 'claude-test',
      inputTokens: 30,
      outputTokens: 5
    })

    const calls = await repo.listLlmCalls('conv-pg-1')
    expect(calls.map((c) => c.nodeId)).toEqual(['turn-1', 'sub-1', 'turn-2'])
    expect(calls[0].inputPreview).toBe('oi')

    const totals = await repo.listLlmUsageTotals('conv-pg-1')
    expect(totals).toHaveLength(2)
    const rootTotal = totals.find((t) => t.subagentType === null)!
    expect(rootTotal.callCount).toBe(2)
    expect(rootTotal.sumInput).toBe(130)
    expect(rootTotal.sumCost).toBeCloseTo(0.01)
    const subTotal = totals.find((t) => t.subagentType === 'general-purpose')!
    expect(subTotal.sumInput).toBe(50)
    expect(subTotal.sumCost).toBeCloseTo(0.02)

    expect(await repo.listLlmCalls('conv-outra')).toEqual([])
  })

  it('vincula uma tarefa a um cartão do quadro e devolve o mapa numa query só', async () => {
    const left = await repository(randomUUID())
    opened.push(left)
    await left.createTask({ projectCwd: 'C:/proj', id: 'task-linked', title: 'T', goal: 'meta' })
    const [card] = await syncBoard(left, [boardSource('1', 'uma', 'pending')])

    await left.linkTaskToBoardItem({ taskId: 'task-linked', boardItemId: card.id, linkedBy: 'agent' })

    const map = await left.boardItemIdsForTasks(['task-linked', 'task-sem-vinculo'])
    expect(map.get('task-linked')).toBe(card.id)
    expect(map.has('task-sem-vinculo')).toBe(false)

    // Vincular de novo é upsert — reaponta em vez de rejeitar.
    const [, cardB] = await syncBoard(left, [boardSource('1', 'uma', 'pending'), boardSource('2', 'duas', 'pending')])
    await left.linkTaskToBoardItem({ taskId: 'task-linked', boardItemId: cardB.id, linkedBy: 'po' })
    expect((await left.boardItemIdsForTasks(['task-linked'])).get('task-linked')).toBe(cardB.id)
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

  // ---------------------------------------------------------------------
  // Quadro de tarefas. A REGRA da ingestão é uma só e mora em
  // `planBoardSourceSync`; o que existe em duas versões é o SQL que a aplica, e
  // o do PostgreSQL nunca tinha sido executado por teste nenhum. O risco é
  // silencioso: o BoardService degrada sem erro visível, então um SQL quebrado
  // faria o quadro simplesmente parar de gravar para quem usa PostgreSQL.
  // ---------------------------------------------------------------------

  it('grava o snapshot do agente e devolve o cartão inteiro na releitura', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const synced = await syncBoard(target, [
      boardSource('1', 'primeira', 'completed'),
      boardSource('2', 'segunda', 'in_progress', { seq: 1, activeForm: 'fazendo a segunda' }),
      boardSource('3', 'terceira', 'pending', { seq: 2 })
    ])

    expect(synced.map((entry) => entry.sourceTitle)).toEqual(['segunda', 'terceira', 'primeira'])
    // A releitura devolve exatamente o mesmo objeto: é aqui que uma coluna
    // esquecida no INSERT apareceria — `seq` perdido reordena o quadro,
    // `active_form` perdido apaga o "fazendo isto" da tela.
    expect(await readBoard(target)).toEqual(synced)
    expect(synced.find((entry) => entry.sourceId === '2')).toMatchObject({
      origin: 'agent',
      sourceStatus: 'in_progress',
      activeForm: 'fazendo a segunda',
      seq: 1,
      poStatus: null,
      revision: 1
    })
    expect(synced.every((entry) => entry.origin === 'agent')).toBe(true)
  })

  it('reemitir o mesmo snapshot não toca no cartão que não mudou', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const snapshot = () => [boardSource('1', 'uma', 'pending'), boardSource('2', 'duas', 'pending', { seq: 1 })]
    const first = await syncBoard(target, snapshot())
    expect(await syncBoard(target, snapshot())).toEqual(first)

    // Agora só o segundo cartão anda. Sem o `unchanged` do plano, o UPDATE
    // rodaria para os dois: `revision` e `updated_at` do primeiro subiriam por
    // nada e o change feed acordaria a tela a cada leitura do mesmo plano.
    const moved = await syncBoard(target, [
      boardSource('1', 'uma', 'pending'),
      boardSource('2', 'duas', 'in_progress', { seq: 1 })
    ])
    const untouched = moved.find((entry) => entry.sourceId === '1')
    expect(untouched).toEqual(first.find((entry) => entry.sourceId === '1'))
    expect(untouched?.revision).toBe(1)
    expect(moved.find((entry) => entry.sourceId === '2')).toMatchObject({
      sourceStatus: 'in_progress',
      revision: 2
    })
  })

  it('snapshot vazio NÃO apaga o quadro', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const before = await syncBoard(target, [boardSource('1', 'uma', 'pending')])
    // "Esta sessão nunca usou tarefas" e "o plano ficou vazio" são
    // indistinguíveis na leitura; tratar o primeiro como o segundo torraria o
    // quadro inteiro da conversa por causa de uma leitura sem sorte.
    expect(await syncBoard(target, [])).toEqual(before)
  })

  it('cartão que sumiu do snapshot é apagado, e o cartão do PO sobrevive', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    await syncBoard(target, [boardSource('1', 'uma', 'pending'), boardSource('2', 'duas', 'pending', { seq: 1 })])
    const poCard = await target.createBoardPoItem({
      projectId: BOARD_PROJECT,
      projectCwd: BOARD_CWD,
      conversationId: BOARD_CONVERSATION,
      title: 'testar com duas conversas',
      status: 'pending',
      reason: 'surgiu no meio do trabalho'
    })

    const after = await syncBoard(target, [boardSource('1', 'uma', 'pending')])

    // O DELETE limpa o que saiu do snapshot desta conversa; sem o
    // `origin = 'agent'` ele levaria junto o cartão que o agente nunca declarou.
    expect(after.map((entry) => entry.sourceTitle).sort()).toEqual(['testar com duas conversas', 'uma'])
    expect(after.find((entry) => entry.origin === 'po')).toEqual(poCard)
  })

  it('o status novo do agente limpa a correção do PO e preserva o título reescrito', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'add board table 5/7', 'pending')])
    await target.applyBoardPo({
      id: card.id,
      poTitle: 'Criar a tabela do quadro',
      poNote: 'inclui a migration',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar'
    })

    const after = await syncBoard(target, [boardSource('1', 'add board table 5/7', 'in_progress')])

    expect(after[0]).toMatchObject({
      sourceStatus: 'in_progress',
      poStatus: null,
      poReason: null,
      // Título não é estado: ele não envelhece quando o trabalho anda.
      poTitle: 'Criar a tabela do quadro',
      poNote: 'inclui a migration'
    })
  })

  it('o "concluído" do PO sobrevive à reemissão do mesmo snapshot', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'add board table + migration 5/7', 'pending')])
    await target.applyBoardPo({
      id: card.id,
      poTitle: 'Criar a tabela do quadro e a migration',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar'
    })

    // O agente reescreve a lista inteira a cada mudança — é exatamente aqui que
    // uma ingestão descuidada apagaria a correção. Snapshot velho reemitido não
    // refuta uma afirmação sobre o TRABALHO.
    const after = await syncBoard(target, [boardSource('1', 'add board table + migration 5/7', 'pending')])

    expect(after[0]).toMatchObject({
      poTitle: 'Criar a tabela do quadro e a migration',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar',
      sourceStatus: 'pending'
    })
  })

  it('o ciclo completo do cartão reaberto: fazendo → a fazer → fazendo', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'uma', 'in_progress')])
    expect(boardItemStatus(card)).toBe('in_progress')

    // O turno acaba sem concluir: a reabertura devolve o cartão para "a fazer".
    await target.applyBoardPo({
      id: card.id,
      poStatus: 'pending',
      poReason: 'o turno terminou sem concluir esta tarefa'
    })
    const reopened = (await readBoard(target))[0]
    expect(boardItemStatus(reopened)).toBe('pending')
    expect(reopened.sourceStatus).toBe('in_progress')

    // O agente retoma e reemite o MESMO `in_progress`: o `source_status` nem
    // mudou de valor, então quem solta a camada do PO é só a segunda metade de
    // `planBoardSourceSync` (a reabertura expirou). Sem ela o cartão ficaria
    // travado em "a fazer" com o agente trabalhando nele.
    const after = await syncBoard(target, [boardSource('1', 'uma', 'in_progress')])

    expect(after[0]).toMatchObject({ sourceStatus: 'in_progress', poStatus: null, poReason: null })
    expect(boardItemStatus(after[0])).toBe('in_progress')
  })

  it('grava e relê a camada do PO, inclusive o cartão que só o PO conhece', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'uma', 'pending')])

    const written = await target.applyBoardPo({
      id: card.id,
      poTitle: 'Título legível',
      poNote: 'nota do PO',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar'
    })
    expect(written).toMatchObject({
      poTitle: 'Título legível',
      poNote: 'nota do PO',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar',
      revision: 2
    })
    expect(written.poAt).not.toBeNull()

    const created = await target.createBoardPoItem({
      projectId: BOARD_PROJECT,
      projectCwd: BOARD_CWD,
      conversationId: BOARD_CONVERSATION,
      title: 'cartão que o agente não declarou',
      status: 'in_progress',
      reason: 'surgiu no meio do trabalho'
    })
    // O `seq` do cartão do PO sai do MAX da conversa: ele entra DEPOIS do que o
    // agente já numerou, em vez de disputar posição com o cartão de `seq` 0.
    expect(created).toMatchObject({ origin: 'po', sourceId: null, seq: 1, sourceStatus: 'in_progress' })

    // Releitura pelo caminho da tela, não pelo retorno da escrita.
    const board = await readBoard(target)
    expect(board.map((entry) => entry.sourceTitle)).toEqual(['cartão que o agente não declarou', 'uma'])
    expect(board.find((entry) => entry.id === created.id)).toEqual(created)
    expect(board.find((entry) => entry.id === card.id)).toEqual(written)

    await expect(target.applyBoardPo({ id: card.id, poStatus: 'pending' })).rejects.toThrow(/motivo/i)
    await expect(target.applyBoardPo({ id: 'bi-nao-existe', poTitle: 'x' })).rejects.toThrow(/inexistente/i)
  })

  it('o cartão nasce com um evento "created", e o agente mudando de status vira outro', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'uma', 'pending')])
    await syncBoard(target, [boardSource('1', 'uma', 'pending')]) // reingestão idêntica: sem evento novo
    await syncBoard(target, [boardSource('1', 'uma', 'completed')])

    const events = await target.listBoardItemEvents(card.id)
    expect(events.map((e) => e.kind)).toEqual(['created', 'status_changed'])
    expect(events[0]).toMatchObject({ actor: 'agent', toStatus: 'pending' })
    expect(events[1]).toMatchObject({ actor: 'agent', fromStatus: 'pending', toStatus: 'completed' })
  })

  it('o PO concluindo o cartão vira um evento com o motivo, e retitular sem status vira "retitled"', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'add board table 5/7', 'in_progress')])
    await target.applyBoardPo({ id: card.id, poStatus: 'completed', poReason: 'o agente esqueceu de marcar' })
    await target.applyBoardPo({ id: card.id, poTitle: 'Criar a tabela do quadro' })

    const events = await target.listBoardItemEvents(card.id)
    expect(events[1]).toMatchObject({
      kind: 'status_changed',
      actor: 'po',
      fromStatus: 'in_progress',
      toStatus: 'completed',
      note: 'o agente esqueceu de marcar'
    })
    expect(events[2]).toMatchObject({ kind: 'retitled', actor: 'po', note: 'Criar a tabela do quadro' })
  })

  it('dispensar e restaurar viram eventos próprios, e o cartão do PO nasce com "created"', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'uma', 'pending')])
    await target.dismissBoardItem(card.id, true)
    await target.dismissBoardItem(card.id, false)

    const events = await target.listBoardItemEvents(card.id)
    expect(events.map((e) => e.kind)).toEqual(['created', 'dismissed', 'restored'])

    const poCard = await target.createBoardPoItem({
      projectId: BOARD_PROJECT,
      projectCwd: BOARD_CWD,
      conversationId: BOARD_CONVERSATION,
      title: 'surgiu no meio do trabalho',
      status: 'pending',
      reason: 'o agente disse que ia fazer depois'
    })
    const poEvents = await target.listBoardItemEvents(poCard.id)
    expect(poEvents).toEqual([
      expect.objectContaining({ kind: 'created', actor: 'po', toStatus: 'pending', note: 'o agente disse que ia fazer depois' })
    ])
  })

  it('escrita com actor "user" (drag-and-drop) vira evento distinto do PO — migration 9 aditiva', async () => {
    const target = await repository(randomUUID())
    opened.push(target)
    const [card] = await syncBoard(target, [boardSource('1', 'uma', 'in_progress')])
    await target.applyBoardPo({
      id: card.id,
      poStatus: 'pending',
      poReason: 'o usuário moveu o cartão para "a fazer" pelo quadro',
      actor: 'user'
    })

    const events = await target.listBoardItemEvents(card.id)
    expect(events[events.length - 1]).toMatchObject({
      kind: 'status_changed',
      actor: 'user',
      fromStatus: 'in_progress',
      toStatus: 'pending'
    })
  })
})
