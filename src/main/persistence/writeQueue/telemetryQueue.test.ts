// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnTimeTotals } from '../../../shared/ipc'
import type { TelemetryBatch } from '../telemetryBatch'
import { StorageError, type LlmCall, type LlmUsageTotal } from '../types'
import { TelemetryQueue } from './telemetryQueue'

const NOW = Date.parse('2026-10-08T12:00:00Z')

function fakeRepository() {
  const batches: TelemetryBatch[] = []
  const state = { online: true, fail: null as Error | null }
  const stored = { calls: [] as LlmCall[], totals: [] as LlmUsageTotal[], turns: { totalMs: 0, turns: 0, lastMs: null } as TurnTimeTotals }
  const repository = {
    writeTelemetryBatch: vi.fn(async (batch: TelemetryBatch) => {
      if (state.fail) throw state.fail
      batches.push(JSON.parse(JSON.stringify(batch)) as TelemetryBatch)
    }),
    insertLlmCall: vi.fn(),
    updateLlmCall: vi.fn(async () => null),
    listLlmCalls: vi.fn(async () => stored.calls),
    listLlmUsageTotals: vi.fn(async () => stored.totals),
    insertTurnTime: vi.fn(),
    turnTimeTotals: vi.fn(async () => stored.turns)
  }
  return { repository, batches, state, stored }
}

const call = (seq: number, extra: Record<string, unknown> = {}) => ({
  convId: 'c1', turnId: 't1', nodeId: 't1', seq, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, ...extra
})

let queues: TelemetryQueue[] = []
function setup() {
  const db = fakeRepository()
  const queue = new TelemetryQueue({
    repository: () => (db.state.online ? db.repository : null),
    reader: () => db.repository,
    now: () => Date.now()
  })
  queues.push(queue)
  return { db, queue }
}

beforeEach(() => vi.useFakeTimers({ now: NOW }))
afterEach(() => {
  for (const queue of queues) queue.dispose()
  queues = []
  vi.useRealTimers()
})

describe('TelemetryQueue', () => {
  it('quem grava recebe na hora; o banco recebe UM lote em ~3 s, com os totais já somados por chave', async () => {
    const { db, queue } = setup()
    const first = await queue.insertLlmCall(call(1))
    await queue.insertLlmCall(call(2, { inputTokens: 7 }))
    await queue.insertLlmCall(call(1, { subagentType: 'executor', nodeId: 'n2' }))
    await queue.insertTurnTime({ convId: 'c1', turnId: 't1', durationMs: 1234.4 })
    expect(first).toMatchObject({ id: expect.any(String), createdAt: '2026-10-08T12:00:00.000Z', cacheReadTokens: 0, costUsd: null })
    expect(db.repository.writeTelemetryBatch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.batches).toHaveLength(1)
    const [batch] = db.batches
    expect(batch.calls).toHaveLength(3)
    expect(batch.turnTimes).toHaveLength(1)
    expect(batch.totals).toEqual([
      expect.objectContaining({ day: '2026-10-08', subagentType: '', sumInput: 17, sumOutput: 10, callCount: 2, sumCost: null }),
      expect.objectContaining({ subagentType: 'executor', sumInput: 10, callCount: 1 })
    ])
  })

  it('a correção de uma chamada ainda na fila entra no próprio INSERT; a de uma já gravada vira UPDATE, e os totais levam só a diferença', async () => {
    const { db, queue } = setup()
    const pending = await queue.insertLlmCall(call(1))
    await queue.updateLlmCall(pending.id, { inputTokens: 30, outputTokens: 5, cacheReadTokens: 100 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.batches[0].calls[0]).toMatchObject({ id: pending.id, inputTokens: 30, cacheReadTokens: 100 })
    expect(db.batches[0].updates).toEqual([])
    expect(db.batches[0].totals[0]).toMatchObject({ sumInput: 30, sumCacheRead: 100, callCount: 1 })

    await queue.updateLlmCall(pending.id, { inputTokens: 40, outputTokens: 6, cacheReadTokens: 100 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.batches[1].calls).toEqual([])
    expect(db.batches[1].updates).toEqual([{ id: pending.id, inputTokens: 40, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: null }])
    expect(db.batches[1].totals[0]).toMatchObject({ sumInput: 10, sumOutput: 1, sumCacheRead: 0, callCount: 0 })
  })

  it('correção de chamada que este processo não gravou vai direto ao repositório, como antes', async () => {
    const { db, queue } = setup()
    await queue.updateLlmCall('de-outro-processo', { inputTokens: 1, outputTokens: 1 })
    expect(db.repository.updateLlmCall).toHaveBeenCalledWith('de-outro-processo', { inputTokens: 1, outputTokens: 1 })
  })

  it('banco fora: o lote volta para a fila sem somar duas vezes; quando volta, vai um lote só com tudo', async () => {
    const { db, queue } = setup()
    db.state.fail = new StorageError('STORAGE_OFFLINE', 'fora', true)
    const a = await queue.insertLlmCall(call(1))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.repository.writeTelemetryBatch).toHaveBeenCalledTimes(1)
    // Chega mais coisa durante a queda, inclusive a correção de uma que voltou para a fila.
    await queue.insertLlmCall(call(2))
    await queue.updateLlmCall(a.id, { inputTokens: 25, outputTokens: 5 })
    db.state.fail = null
    queue.kick()
    await vi.advanceTimersByTimeAsync(10)
    expect(db.batches).toHaveLength(1)
    const [batch] = db.batches
    // A correção de uma chamada que voltou para a fila entra no próprio INSERT.
    expect(batch.calls.map((c) => [c.seq, c.inputTokens])).toEqual([[1, 25], [2, 10]])
    expect(batch.updates).toEqual([])
    expect(batch.totals).toEqual([expect.objectContaining({ sumInput: 35, callCount: 2 })])
  })

  it('as leituras somam o que ainda está na fila', async () => {
    const { db, queue } = setup()
    db.stored.totals = [{ convId: 'c1', day: '2026-10-08', model: 'claude-opus-5-5', subagentType: null, sumInput: 100, sumOutput: 50, sumCacheRead: 0, sumCacheWrite: 0, sumCost: null, callCount: 4 }]
    db.stored.turns = { totalMs: 1000, turns: 1, lastMs: 1000 }
    const pending = await queue.insertLlmCall(call(5))
    await queue.insertTurnTime({ convId: 'c1', turnId: 't2', durationMs: 500 })

    expect((await queue.listLlmCalls('c1')).map((c) => c.id)).toEqual([pending.id])
    expect(await queue.listLlmUsageTotals('c1')).toEqual([expect.objectContaining({ subagentType: null, sumInput: 110, callCount: 5 })])
    expect(await queue.turnTimeTotals('c1')).toEqual({ totalMs: 1500, turns: 2, lastMs: 500 })
    expect(await queue.listLlmUsageTotals('outra')).toEqual([expect.objectContaining({ sumInput: 100 })])
  })

  it('flush com prazo: sem banco não espera; com banco grava e devolve true', async () => {
    const { db, queue } = setup()
    db.state.online = false
    await queue.insertLlmCall(call(1))
    await expect(queue.flush(2_000)).resolves.toBe(false)
    expect(queue.pendingCounts()).toMatchObject({ calls: 1, totals: 1 })
    db.state.online = true
    await expect(queue.flush(2_000)).resolves.toBe(true)
    expect(queue.pendingCounts()).toEqual({ calls: 0, updates: 0, totals: 0, turnTimes: 0 })
  })

  it('lote recusado de vez (erro não transitório) é descartado com log, sem travar a fila', async () => {
    const log = vi.fn()
    const db = fakeRepository()
    const queue = new TelemetryQueue({ repository: () => db.repository, reader: () => db.repository, log })
    queues.push(queue)
    db.state.fail = new StorageError('INVALID_PERSISTED_DATA', 'torto')
    await queue.insertLlmCall(call(1))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('descartado'))
    db.state.fail = null
    await queue.insertLlmCall(call(2))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.batches[0].calls.map((c) => c.seq)).toEqual([2])
  })
})
