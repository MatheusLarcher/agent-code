// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from '../persistence/bootstrapStore'
import { postgresClientConfig, provisionPostgres } from '../persistence/postgresProvisioning'
import { PostgresRepository } from '../persistence/postgresRepository'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { StorageError, type LeaseFence, type TaskStatus } from '../persistence/types'
import { TaskLedger, TASK_LEASE_TTL_MS } from './taskLedger'

const tempDirs: string[] = []

async function openLedger(installationId = 'device-a'): Promise<{ ledger: TaskLedger; repository: SqliteRepository }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-task-ledger-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), installationId)
  await repository.initialize()
  return { ledger: new TaskLedger(repository), repository }
}

function newTask(ledger: TaskLedger, title = 'Tarefa') {
  return ledger.createTask({ projectCwd: 'C:/repo', title, goal: 'fazer algo', acceptance: ['testes passam'] })
}

/** Claim + pending→running in one go; returns the fence the writer must carry. */
async function startTask(ledger: TaskLedger, agent = 'agent-1'): Promise<{ id: string; fence: LeaseFence }> {
  const claim = await ledger.claimTask(agent)
  if (!claim) throw new Error('nada para reivindicar')
  const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }
  await ledger.transitionTask(claim.task.id, 'pending', 'running', fence)
  return { id: claim.task.id, fence }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('TaskLedger (SQLite)', () => {
  it('mantém a ordem de inserção dos eventos quando o relógio retrocede', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
    const { ledger } = await openLedger()
    const task = await newTask(ledger)
    const first = await ledger.appendEvent({ taskId: task.id, kind: 'first' })
    vi.setSystemTime(new Date('2026-09-10T11:00:00.000Z'))
    const second = await ledger.appendEvent({ taskId: task.id, kind: 'second' })
    const events = await ledger.listEvents(task.id)
    expect(events.map((event) => event.kind)).toEqual(['created', 'first', 'second'])
    expect(events.slice(1).map((event) => event.id)).toEqual([first.id, second.id])
  })

  it('não reivindica novamente uma pending cujo orçamento expirou', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
    const { ledger } = await openLedger()
    const exhausted = await ledger.createTask({ projectCwd: 'C:/repo', title: 'uma tentativa', goal: 'testar', maxAttempts: 1 })
    await ledger.claimTask('agent-1')
    vi.setSystemTime(Date.now() + TASK_LEASE_TTL_MS + 1)
    expect(await ledger.claimTask('agent-2')).toBeNull()
    expect((await ledger.getTask(exhausted.id))?.attempts).toBe(1)
    expect((await ledger.listEvents(exhausted.id)).map((event) => event.kind)).toEqual(['created', 'claimed'])
    const next = await newTask(ledger, 'ainda elegível')
    expect((await ledger.claimTask('agent-2'))?.task.id).toBe(next.id)
  })

  it('eventos só aceitam etapas existentes da própria tarefa', async () => {
    const { ledger } = await openLedger()
    const first = await newTask(ledger, 'primeira')
    const second = await newTask(ledger, 'segunda')
    const step = await ledger.appendStep({ taskId: first.id, kind: 'verify' })
    const before = await ledger.listEvents(second.id)
    for (const stepId of [step.id, 'missing', '']) {
      await expect(ledger.appendEvent({ taskId: second.id, stepId, kind: 'note' }))
        .rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    }
    expect(await ledger.listEvents(second.id)).toEqual(before)
    const valid = await ledger.appendEvent({ taskId: first.id, stepId: step.id, kind: 'note' })
    expect(valid.stepId).toBe(step.id)
  })

  it('cria a tarefa como pending com defaults e evento created', async () => {
    const { ledger } = await openLedger()
    const task = await newTask(ledger)

    expect(task).toMatchObject({
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      ownerAgent: null,
      leaseToken: null,
      fencingEpoch: 0,
      revision: 1,
      acceptance: ['testes passam'],
      writeScope: { allow: [], deny: [] }
    })
    expect(await ledger.getTask(task.id)).toEqual(task)
    expect((await ledger.listEvents(task.id)).map((event) => event.kind)).toEqual(['created'])
    await expect(newTask(ledger, '   ')).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
  })

  it('claim pega a pending mais antiga, grava lease e fence, e devolve null quando não há nada', async () => {
    const { ledger } = await openLedger()
    expect(await ledger.claimTask('agent-1')).toBeNull()

    const first = await newTask(ledger, 'primeira')
    const second = await newTask(ledger, 'segunda')

    const claimA = await ledger.claimTask('agent-1')
    expect(claimA?.task.id).toBe(first.id)
    expect(claimA?.task).toMatchObject({ status: 'pending', ownerAgent: 'agent-1', attempts: 1, fencingEpoch: 1 })
    expect(claimA?.task.leaseToken).toBe(claimA?.token)
    expect(Date.parse(claimA!.expiresAt)).toBeGreaterThan(Date.now())

    const claimB = await ledger.claimTask('agent-2')
    expect(claimB?.task.id).toBe(second.id)
    // Both tasks leased: nothing left, and never the same task twice.
    expect(await ledger.claimTask('agent-3')).toBeNull()
    expect((await ledger.listEvents(first.id)).map((event) => event.kind)).toEqual(['created', 'claimed'])
  })

  it('renova o lease apenas com o fence vigente e torna a tarefa reivindicável quando expira', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
    const { ledger } = await openLedger()
    const task = await newTask(ledger)
    const claim = (await ledger.claimTask('agent-1'))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }

    vi.setSystemTime(Date.now() + TASK_LEASE_TTL_MS / 2)
    const renewed = await ledger.renewTaskLease(task.id, fence)
    expect(Date.parse(renewed.expiresAt)).toBe(Date.now() + TASK_LEASE_TTL_MS)
    await expect(ledger.renewTaskLease(task.id, { token: 'other', fencingEpoch: 1 })).rejects.toMatchObject({
      code: 'TASK_FENCE_STALE'
    })
    // Still leased: nobody else can take it.
    expect(await ledger.claimTask('agent-2')).toBeNull()

    vi.setSystemTime(Date.now() + TASK_LEASE_TTL_MS + 1)
    await expect(ledger.renewTaskLease(task.id, fence)).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    const reclaimed = await ledger.claimTask('agent-2')
    expect(reclaimed?.task.id).toBe(task.id)
    expect(reclaimed?.task).toMatchObject({ ownerAgent: 'agent-2', attempts: 2, fencingEpoch: 2 })
    // The old holder's fence is now behind the epoch.
    await expect(ledger.transitionTask(task.id, 'pending', 'running', fence)).rejects.toMatchObject({
      code: 'TASK_FENCE_STALE'
    })
  })

  it('aceita as transições da máquina de estados e gera um evento por transição', async () => {
    const { ledger } = await openLedger()
    await newTask(ledger)
    const { id, fence } = await startTask(ledger)

    const path: Array<[TaskStatus, TaskStatus]> = [
      ['running', 'blocked'],
      ['blocked', 'running'],
      ['running', 'review'],
      ['review', 'running'],
      ['running', 'review'],
      ['review', 'done']
    ]
    for (const [from, to] of path) {
      const task = await ledger.transitionTask(id, from, to, fence, { agent: 'agent-1' })
      expect(task.status).toBe(to)
    }
    const events = await ledger.listEvents(id)
    const transitions = events.filter((event) => event.kind === 'transition')
    expect(transitions.map((event) => [event.data.from, event.data.to])).toEqual([['pending', 'running'], ...path])
    expect(events.map((event) => event.kind).slice(0, 3)).toEqual(['created', 'claimed', 'transition'])
    // Terminal state released the lease: a plain (unfenced) read-model write is
    // no longer blocked, but done has no outgoing transitions.
    await expect(ledger.transitionTask(id, 'done', 'running')).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
  })

  it('rejeita transição fora da máquina, "from" divergente e estados desconhecidos', async () => {
    const { ledger } = await openLedger()
    const created = await newTask(ledger)
    const invalid = async (from: TaskStatus, to: TaskStatus, fence?: LeaseFence) =>
      expect(ledger.transitionTask(created.id, from, to, fence)).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION'
      } satisfies Partial<StorageError>)

    await invalid('pending', 'done')
    await invalid('pending', 'review')
    await invalid('running', 'done') // task is pending, not running
    await invalid('pending', 'weird' as TaskStatus)

    const { id, fence } = await startTask(ledger)
    expect(id).toBe(created.id)
    await invalid('running', 'pending', fence)
    await invalid('running', 'done', fence)
    await ledger.transitionTask(id, 'running', 'cancelled', fence)
    await invalid('cancelled', 'pending')
    await invalid('cancelled', 'running')
    expect((await ledger.getTask(id))?.status).toBe('cancelled')
  })

  it('rejeita fence antigo e escrita sem fence enquanto há lease vivo', async () => {
    const { ledger } = await openLedger()
    const task = await newTask(ledger)
    const claim = (await ledger.claimTask('agent-1'))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }

    await expect(ledger.transitionTask(task.id, 'pending', 'running')).rejects.toMatchObject({
      code: 'TASK_FENCE_STALE'
    })
    await expect(
      ledger.transitionTask(task.id, 'pending', 'running', { token: fence.token, fencingEpoch: fence.fencingEpoch - 1 })
    ).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    await expect(
      ledger.transitionTask(task.id, 'pending', 'running', { token: 'forged', fencingEpoch: fence.fencingEpoch })
    ).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    await expect(ledger.appendStep({ taskId: task.id, kind: 'implement' })).rejects.toMatchObject({
      code: 'TASK_FENCE_STALE'
    })
    // Nothing leaked into the ledger from the rejected writes.
    expect((await ledger.getTask(task.id))?.status).toBe('pending')
    expect((await ledger.listEvents(task.id)).map((event) => event.kind)).toEqual(['created', 'claimed'])

    expect((await ledger.transitionTask(task.id, 'pending', 'running', fence)).status).toBe('running')
  })

  it('conta tentativas no claim e só permite failed→pending enquanto attempts < max_attempts', async () => {
    const { ledger } = await openLedger()
    const created = await ledger.createTask({ projectCwd: 'C:/repo', title: 'T', goal: 'G', maxAttempts: 2 })

    const first = await startTask(ledger)
    await ledger.transitionTask(first.id, 'running', 'failed', first.fence, { reason: 'boom' })
    let task = (await ledger.getTask(created.id))!
    expect(task).toMatchObject({ status: 'failed', attempts: 1 })
    // Failure released the lease, so the explicit resume needs no fence.
    task = await ledger.transitionTask(created.id, 'failed', 'pending')
    expect(task).toMatchObject({ status: 'pending', ownerAgent: null })

    const second = await startTask(ledger, 'agent-2')
    expect(second.id).toBe(created.id)
    expect((await ledger.getTask(created.id))?.attempts).toBe(2)
    await ledger.transitionTask(second.id, 'running', 'failed', second.fence)
    await expect(ledger.transitionTask(created.id, 'failed', 'pending')).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
    expect(await ledger.claimTask('agent-3')).toBeNull()
    expect((await ledger.listTasks({ status: 'failed' })).map((entry) => entry.id)).toEqual([created.id])
  })

  it('registra etapas, entregas e eventos livres com fence e ordem estável', async () => {
    const { ledger } = await openLedger()
    await newTask(ledger)
    const { id, fence } = await startTask(ledger)

    const analyze = await ledger.appendStep({ taskId: id, kind: 'analyze', agent: 'agent-1', fence })
    const implement = await ledger.appendStep({ taskId: id, kind: 'implement', agent: 'agent-1', fence, sdkSessionId: 'sdk-1' })
    expect([analyze.seq, implement.seq]).toEqual([1, 2])
    expect(analyze).toMatchObject({ status: 'running', finishedAt: null, error: null })

    const finished = await ledger.finishStep({ stepId: analyze.id, status: 'done', fence })
    expect(finished.finishedAt).not.toBeNull()
    await expect(ledger.finishStep({ stepId: analyze.id, status: 'done', fence })).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
    await expect(ledger.finishStep({ stepId: implement.id, status: 'running' as 'done', fence })).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
    const failed = await ledger.finishStep({
      stepId: implement.id,
      status: 'failed',
      error: { message: 'tsc', exitCode: 1 },
      fence
    })
    expect(failed.error).toEqual({ message: 'tsc', exitCode: 1 })

    const deliverable = await ledger.addDeliverable({
      taskId: id,
      stepId: implement.id,
      kind: 'test_run',
      summary: 'vitest: 3 passed',
      verified: true,
      verifiedBy: 'runner',
      fence
    })
    expect(deliverable).toMatchObject({ kind: 'test_run', verified: true, verifiedBy: 'runner', stepId: implement.id })
    await expect(
      ledger.addDeliverable({ taskId: id, stepId: 'nope', kind: 'note', summary: 'x', fence })
    ).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    await expect(ledger.appendStep({ taskId: id, kind: 'bogus' as 'verify', fence })).rejects.toMatchObject({
      code: 'INVALID_PERSISTED_DATA'
    })

    const note = await ledger.appendEvent({ taskId: id, kind: 'note', data: { text: 'olá' } })
    expect(note.data).toEqual({ text: 'olá' })

    expect((await ledger.listSteps(id)).map((step) => [step.seq, step.status])).toEqual([
      [1, 'done'],
      [2, 'failed']
    ])
    expect(await ledger.listDeliverables(id)).toEqual([deliverable])
    expect((await ledger.listEvents(id)).map((event) => event.kind)).toEqual([
      'created',
      'claimed',
      'transition',
      'step_started',
      'step_started',
      'step_finished',
      'step_finished',
      'deliverable_added',
      'note'
    ])
  })

  it('lista tarefas por status, projeto, conversa e pai', async () => {
    const { ledger } = await openLedger()
    const parent = await ledger.createTask({ projectCwd: 'C:/a', title: 'pai', goal: 'g', conversationId: 'conv-1' })
    const child = await ledger.createTask({ projectCwd: 'C:/a', title: 'filha', goal: 'g', parentTaskId: parent.id })
    const other = await ledger.createTask({ projectCwd: 'C:/b', title: 'outra', goal: 'g' })
    await expect(
      ledger.createTask({ projectCwd: 'C:/a', title: 'órfã', goal: 'g', parentTaskId: 'missing' })
    ).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })

    const ids = (tasks: Awaited<ReturnType<TaskLedger['listTasks']>>) => tasks.map((task) => task.id)
    expect(ids(await ledger.listTasks())).toEqual([parent.id, child.id, other.id])
    expect(ids(await ledger.listTasks({ projectCwd: 'C:/a' }))).toEqual([parent.id, child.id])
    expect(ids(await ledger.listTasks({ conversationId: 'conv-1' }))).toEqual([parent.id])
    expect(ids(await ledger.listTasks({ parentTaskId: parent.id }))).toEqual([child.id])
    expect(ids(await ledger.listTasks({ parentTaskId: null }))).toEqual([parent.id, other.id])
    expect(ids(await ledger.listTasks({ status: ['pending'], limit: 1 }))).toEqual([parent.id])
    expect(await ledger.listTasks({ ids: [] })).toEqual([])
    expect(ids(await ledger.listTasks({ ids: [other.id] }))).toEqual([other.id])
  })

  it('emite mudanças "task" para os assinantes do repositório', async () => {
    const { ledger, repository } = await openLedger()
    const seen: string[] = []
    repository.subscribe((changes) => {
      for (const change of changes) if (change.entity === 'task') seen.push(change.entityId)
    })
    const task = await newTask(ledger)
    await ledger.claimTask('agent-1')
    expect(seen).toEqual([task.id, task.id])
  })
})

// ---------------------------------------------------------------------------
// PostgreSQL: same contract, gated like postgresRepository.test.ts.
// ---------------------------------------------------------------------------

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

async function postgresRepository(installationId: string): Promise<PostgresRepository> {
  const provisioned = await provisionPostgres(draft, installationId, 'test')
  const result = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
  await result.initialize()
  return result
}

describe.runIf(integration).sequential('TaskLedger (PostgreSQL)', () => {
  const opened: PostgresRepository[] = []

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('claim exclusivo entre instalações, fence, máquina de estados e eventos', async () => {
    const left = await postgresRepository(randomUUID())
    const right = await postgresRepository(randomUUID())
    opened.push(left, right)
    const ledgerA = new TaskLedger(left)
    const ledgerB = new TaskLedger(right)

    const task = await ledgerA.createTask({
      projectCwd: 'C:/repo',
      title: 'NUL\0título',
      goal: 'g',
      acceptance: ['a'],
      writeScope: { allow: ['src/**'] }
    })
    expect(task).toMatchObject({ status: 'pending', title: 'NUL\0título', writeScope: { allow: ['src/**'], deny: [] } })

    const [claimA, claimB] = await Promise.all([ledgerA.claimTask('agent-a'), ledgerB.claimTask('agent-b')])
    const winner = claimA ?? claimB
    expect([claimA, claimB].filter(Boolean)).toHaveLength(1)
    expect(winner?.task).toMatchObject({ id: task.id, attempts: 1, fencingEpoch: 1 })
    const fence = { token: winner!.token, fencingEpoch: winner!.fencingEpoch }

    // The loser sees a live lease: no unfenced writes, no forged fence.
    await expect(ledgerB.transitionTask(task.id, 'pending', 'running')).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })
    await expect(
      ledgerB.transitionTask(task.id, 'pending', 'running', { token: 'forged', fencingEpoch: 1 })
    ).rejects.toMatchObject({ code: 'TASK_FENCE_STALE' })

    await ledgerA.transitionTask(task.id, 'pending', 'running', fence)
    await expect(ledgerA.transitionTask(task.id, 'running', 'done', fence)).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
    const renewed = await ledgerA.renewTaskLease(task.id, fence)
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now() - 5_000)

    const step = await ledgerA.appendStep({ taskId: task.id, kind: 'implement', agent: 'agent-a', fence })
    await ledgerA.finishStep({ stepId: step.id, status: 'done', error: null, fence })
    await ledgerA.addDeliverable({ taskId: task.id, stepId: step.id, kind: 'note', summary: 'ok\0nul', fence })
    await ledgerA.transitionTask(task.id, 'running', 'review', fence)
    const done = await ledgerA.transitionTask(task.id, 'review', 'done', fence)
    expect(done.status).toBe('done')

    // Terminal state released the lease; other installation reads the same ledger.
    expect((await ledgerB.getTask(task.id))?.status).toBe('done')
    expect((await ledgerB.listDeliverables(task.id))[0]?.summary).toBe('ok\0nul')
    expect((await ledgerB.listEvents(task.id)).map((event) => event.kind)).toEqual([
      'created',
      'claimed',
      'transition',
      'step_started',
      'step_finished',
      'deliverable_added',
      'transition',
      'transition'
    ])
    expect(await ledgerB.claimTask('agent-b')).toBeNull()
  })

  it('failed→pending respeita max_attempts e o change feed publica a entidade task', async () => {
    const left = await postgresRepository(randomUUID())
    const right = await postgresRepository(randomUUID())
    opened.push(left, right)
    const ledger = new TaskLedger(left)
    const seen = new Promise<void>((resolve) => {
      const off = right.subscribe((changes) => {
        if (changes.some((change) => change.entity === 'task')) {
          off()
          resolve()
        }
      })
    })

    const task = await ledger.createTask({ projectCwd: 'C:/repo', title: 'retry', goal: 'g', maxAttempts: 1 })
    await expect(
      Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000))])
    ).resolves.toBeUndefined()

    const claim = (await ledger.claimTask('agent-a'))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }
    await ledger.transitionTask(task.id, 'pending', 'running', fence)
    await ledger.transitionTask(task.id, 'running', 'failed', fence, { reason: 'boom' })
    await expect(ledger.transitionTask(task.id, 'failed', 'pending')).rejects.toMatchObject({
      code: 'TASK_INVALID_TRANSITION'
    })
  })
})
