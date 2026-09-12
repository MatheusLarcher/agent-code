// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { TaskLedger } from './taskLedger'
import { isAbandoned, reapAbandonedTasks, REAP_GRACE_MS } from './taskReaper'
import type { Task } from '../persistence/types'

/**
 * Contra o repositório real: o que precisa ser provado é que a tarefa volta a
 * ser REIVINDICÁVEL, e quem decide isso é a máquina de estados do banco — não
 * o reaper.
 */

const tempDirs: string[] = []
let dbPath = ''

async function setup(): Promise<TaskLedger> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-reaper-'))
  tempDirs.push(cache)
  dbPath = join(cache, 'agent-code.db')
  const repository = new SqliteRepository(cache, dbPath, 'device-a')
  await repository.initialize()
  return new TaskLedger(repository)
}

/** Cria uma tarefa e a deixa em `running` com lease vivo. */
async function running(ledger: TaskLedger, title: string, maxAttempts = 3): Promise<string> {
  const task = await ledger.createTask({ projectCwd: 'C:/projeto', title, goal: 'g', maxAttempts })
  const claim = await ledger.claimTask('session:morto', { taskId: task.id })
  const fence = { token: claim!.token, fencingEpoch: claim!.fencingEpoch }
  await ledger.transitionTask(task.id, 'pending', 'running', fence)
  return task.id
}

/**
 * Mata o lease no banco, que é o que um executor morto de fato deixa para trás.
 *
 * Adiantar o relógio DO REAPER não serve: o repositório avalia a validade do
 * lease pelo relógio dele, então com um lease ainda vivo a transição sem fence
 * é recusada — exatamente como deve ser. Foi o teste que revelou isso.
 */
function killLease(taskId: string, agoMs = REAP_GRACE_MS + 60_000): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - agoMs).toISOString(),
      taskId
    )
  } finally {
    db.close()
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('isAbandoned', () => {
  const base = { status: 'running', leaseExpiresAt: null, attempts: 1, maxAttempts: 3 } as unknown as Task
  const at = (over: Partial<Task>): Task => ({ ...base, ...over }) as Task
  const now = Date.parse('2026-09-12T12:00:00.000Z')

  it('só olha tarefa em execução', () => {
    for (const status of ['pending', 'review', 'blocked', 'done', 'failed', 'cancelled'] as const) {
      expect(isAbandoned(at({ status, leaseExpiresAt: '2026-09-12T10:00:00.000Z' }), now)).toBe(false)
    }
  })

  it('lease vivo não é abandono', () => {
    expect(isAbandoned(at({ leaseExpiresAt: '2026-09-12T12:10:00.000Z' }), now)).toBe(false)
  })

  it('vencido há pouco ainda tem a folga — o executor pode estar voltando de um build', () => {
    expect(isAbandoned(at({ leaseExpiresAt: '2026-09-12T11:58:00.000Z' }), now)).toBe(false)
  })

  it('vencido além da folga é abandono', () => {
    expect(isAbandoned(at({ leaseExpiresAt: '2026-09-12T11:50:00.000Z' }), now)).toBe(true)
  })

  it('running sem lease nenhum conta como abandono — ninguém está segurando', () => {
    expect(isAbandoned(at({ leaseExpiresAt: null }), now)).toBe(true)
    expect(isAbandoned(at({ leaseExpiresAt: 'nao-e-data' }), now)).toBe(true)
  })
})

describe('reaper contra o repositório real', () => {
  it('tarefa abandonada volta a ser REIVINDICÁVEL', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'executor morreu')

    // Antes: ninguém consegue assumir — só `pending` é reivindicável.
    expect(await ledger.claimTask('session:novo', { taskId: id })).toBeNull()

    killLease(id)
    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome.requeued).toEqual([id])
    expect((await ledger.getTask(id))?.status).toBe('pending')

    const claim = await ledger.claimTask('session:novo', { taskId: id })
    expect(claim?.task.id).toBe(id)
    expect(claim?.task.attempts).toBe(2)
  })

  it('não mexe em tarefa com lease vivo', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'trabalhando agora')
    const outcome = await reapAbandonedTasks(ledger, Date.now())
    expect(outcome).toEqual({ requeued: [], exhausted: [] })
    expect((await ledger.getTask(id))?.status).toBe('running')
  })

  it('sem tentativas restantes, para em failed em vez de redistribuir para sempre', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'última tentativa', 1)

    killLease(id)
    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome.exhausted).toEqual([id])
    expect(outcome.requeued).toEqual([])
    expect((await ledger.getTask(id))?.status).toBe('failed')
    expect(await ledger.claimTask('session:novo', { taskId: id })).toBeNull()
  })

  it('registra o motivo no histórico — quem olhar depois entende o que houve', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'com rastro')
    killLease(id)
    await reapAbandonedTasks(ledger)

    const events = await ledger.listEvents(id)
    const reasons = events.map((e) => String(e.data.reason ?? ''))
    expect(reasons.some((r) => r.includes('Lease vencido'))).toBe(true)
    expect(events.some((e) => e.data.agent === 'app:reaper')).toBe(true)
  })

  it('não toca review nem blocked — ali o handoff foi deliberado', async () => {
    const ledger = await setup()
    const entregue = await running(ledger, 'entregue')
    const travada = await running(ledger, 'travada')
    const fenceOf = async (id: string): Promise<{ token: string; fencingEpoch: number }> => {
      const task = await ledger.getTask(id)
      return { token: task!.leaseToken as string, fencingEpoch: task!.fencingEpoch }
    }
    await ledger.transitionTask(entregue, 'running', 'review', await fenceOf(entregue))
    await ledger.transitionTask(travada, 'running', 'blocked', await fenceOf(travada))

    killLease(entregue)
    killLease(travada)
    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome).toEqual({ requeued: [], exhausted: [] })
    expect((await ledger.getTask(entregue))?.status).toBe('review')
    expect((await ledger.getTask(travada))?.status).toBe('blocked')
  })

  it('retoma a reciclagem que morreu entre as duas transições', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'meio do caminho')
    killLease(id)

    // Simula a passada anterior que fez `running → failed` e morreu antes de
    // devolver à fila: a tarefa some do radar (não é `running`) e ninguém
    // consegue assumi-la (não é `pending`).
    await ledger.transitionTask(id, 'running', 'failed', undefined, { agent: 'app:reaper' })
    expect(await ledger.claimTask('session:novo', { taskId: id })).toBeNull()

    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome.requeued).toEqual([id])
    expect((await ledger.getTask(id))?.status).toBe('pending')
  })

  it('não ressuscita a tarefa que o CRÍTICO reprovou — ali quem decide é ele', async () => {
    const ledger = await setup()
    const id = await running(ledger, 'reprovada de propósito')
    const task = await ledger.getTask(id)
    const fence = { token: task!.leaseToken as string, fencingEpoch: task!.fencingEpoch }
    await ledger.transitionTask(id, 'running', 'review', fence)
    await ledger.transitionTask(id, 'review', 'failed', undefined, { agent: 'critico' })

    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome.requeued).toEqual([])
    expect((await ledger.getTask(id))?.status).toBe('failed')
  })

  it('varre várias de uma vez', async () => {
    const ledger = await setup()
    const ids = [
      await running(ledger, 'a'),
      await running(ledger, 'b'),
      await running(ledger, 'c')
    ]
    for (const id of ids) killLease(id)
    const outcome = await reapAbandonedTasks(ledger)
    expect(outcome.requeued.sort()).toEqual([...ids].sort())
  })
})
