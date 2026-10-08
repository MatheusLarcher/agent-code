// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageError, type ContextHistoryRepository, type ContextTurnWrite } from '../types'
import { ContextHistoryQueue } from './contextHistoryQueue'

function turn(turnId: string, patch: Partial<ContextTurnWrite> = {}): ContextTurnWrite {
  return { convId: 'c1', turnId, pc: 'PC-A', startedAt: 1, model: 'm', models: [], provider: 'claude', request: 'r',
    memoriesSent: [], complete: false, blocks: [], usage: null, secrets: [], ...patch }
}

function fakeRepository() {
  const saved: ContextTurnWrite[] = []
  const state = { fail: null as Error | null }
  const repository = {
    saveContextTurn: vi.fn(async (write: ContextTurnWrite) => {
      if (state.fail) throw state.fail
      saved.push(write)
    }),
    listContextTurns: vi.fn(async () => []),
    readContextTurn: vi.fn(async () => null),
    deleteContextTurns: vi.fn(async () => 0),
    pruneOrphanContextBlobs: vi.fn(async () => 0)
  } satisfies ContextHistoryRepository
  return { repository, saved, state }
}

let queues: ContextHistoryQueue[] = []
function setup() {
  const db = fakeRepository()
  const queue = new ContextHistoryQueue({ repository: () => db.repository, reader: () => db.repository })
  queues.push(queue)
  return { db, queue }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const queue of queues) queue.dispose()
  queues = []
  vi.useRealTimers()
})

describe('ContextHistoryQueue', () => {
  it('as gravações do mesmo turno que chegam juntas viram uma (a mais nova); turnos diferentes vão todos', async () => {
    const { db, queue } = setup()
    await queue.saveContextTurn(turn('t1', { request: 'início' }))
    await queue.saveContextTurn(turn('t2'))
    await queue.saveContextTurn(turn('t1', { request: 'meio' }))
    await queue.saveContextTurn(turn('t1', { request: 'fim', complete: true }))
    expect(db.repository.saveContextTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.saved.map((write) => [write.turnId, write.request])).toEqual([['t2', 'r'], ['t1', 'fim']])
  })

  it('apagar o histórico da conversa leva junto o que ainda não foi gravado', async () => {
    const { db, queue } = setup()
    await queue.saveContextTurn(turn('t1'))
    await queue.saveContextTurn(turn('t9', { convId: 'outra' }))
    await queue.deleteContextTurns('c1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.repository.deleteContextTurns).toHaveBeenCalledWith('c1')
    expect(db.saved.map((write) => write.convId)).toEqual(['outra'])
  })

  it('banco fora: espera e grava depois; uma gravação mais nova do turno chegada no meio vence', async () => {
    const { db, queue } = setup()
    db.state.fail = new StorageError('STORAGE_OFFLINE', 'fora', true)
    await queue.saveContextTurn(turn('t1', { request: 'velho' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(queue.pendingCount()).toBe(1)
    await queue.saveContextTurn(turn('t1', { request: 'novo' }))
    db.state.fail = null
    queue.kick()
    await vi.advanceTimersByTimeAsync(10)
    expect(db.saved.map((write) => write.request)).toEqual(['novo'])
    await expect(queue.flush(1_000)).resolves.toBe(true)
  })

  it('recusa definitiva descarta o turno e segue com os outros', async () => {
    const log = vi.fn()
    const db = fakeRepository()
    const queue = new ContextHistoryQueue({ repository: () => db.repository, reader: () => db.repository, log })
    queues.push(queue)
    db.repository.saveContextTurn.mockRejectedValueOnce(new StorageError('INVALID_PERSISTED_DATA', 'torto'))
    await queue.saveContextTurn(turn('t1'))
    await queue.saveContextTurn(turn('t2'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('descartado'))
    expect(db.saved.map((write) => write.turnId)).toEqual(['t2'])
  })
})
