// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChangeLogPruner,
  CHANGE_LOG_PRUNE_INTERVAL_MS,
  CHANGE_LOG_RETENTION_DAYS,
  PRUNE_BATCH_SIZE,
  pruneInBatches
} from './changeLogPruner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const done = { rowCount: 0 }

describe('ChangeLogPruner', () => {
  it('poda logo ao iniciar, com a janela de retenção certa, e repete a cada 24h', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => done)
    new ChangeLogPruner({ query }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('DELETE FROM change_log')
    expect(query.mock.calls[0][0]).toContain('LIMIT $2')
    expect(query.mock.calls[0][1]).toEqual([CHANGE_LOG_RETENTION_DAYS, PRUNE_BATCH_SIZE])

    await vi.advanceTimersByTimeAsync(CHANGE_LOG_PRUNE_INTERVAL_MS - 1)
    expect(query).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('backlog grande: apaga em lotes até um lote vir incompleto', async () => {
    vi.useFakeTimers()
    const query = vi
      .fn(async (_sql: string, _params?: unknown[]) => done)
      .mockResolvedValueOnce({ rowCount: PRUNE_BATCH_SIZE })
      .mockResolvedValueOnce({ rowCount: PRUNE_BATCH_SIZE })
      .mockResolvedValueOnce({ rowCount: 17 })
    new ChangeLogPruner({ query }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('uma falha só loga e tenta de novo no próximo ciclo — nunca propaga', async () => {
    vi.useFakeTimers()
    const failure = new Error('connection terminated')
    const query = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(done)
    const onError = vi.fn()
    new ChangeLogPruner({ query }, onError).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(query).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CHANGE_LOG_PRUNE_INTERVAL_MS)
    expect(query).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stop() cancela a poda seguinte', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => done)
    const pruner = new ChangeLogPruner({ query }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)

    pruner.stop()
    await vi.advanceTimersByTimeAsync(10 * CHANGE_LOG_PRUNE_INTERVAL_MS)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('pruneInBatches', () => {
  it('soma o que cada lote apagou e para no primeiro lote incompleto', async () => {
    const counts = [10, 10, 3]
    const deleteBatch = vi.fn(async (limit: number) => {
      expect(limit).toBe(10)
      return counts.shift() ?? 0
    })
    await expect(pruneInBatches(deleteBatch, 10, 100)).resolves.toBe(23)
    expect(deleteBatch).toHaveBeenCalledTimes(3)
  })

  it('respeita o teto de lotes por rodada (o resto fica para a próxima)', async () => {
    const deleteBatch = vi.fn(async (limit: number) => limit)
    await expect(pruneInBatches(deleteBatch, 10, 4)).resolves.toBe(40)
    expect(deleteBatch).toHaveBeenCalledTimes(4)
  })
})
