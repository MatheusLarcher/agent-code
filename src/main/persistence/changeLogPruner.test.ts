// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChangeLogPruner, CHANGE_LOG_PRUNE_INTERVAL_MS, CHANGE_LOG_RETENTION_DAYS } from './changeLogPruner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ChangeLogPruner', () => {
  it('poda logo ao iniciar, com a janela de retenção certa, e repete a cada 24h', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => undefined)
    new ChangeLogPruner({ query }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('DELETE FROM change_log')
    expect(query.mock.calls[0][1]).toEqual([CHANGE_LOG_RETENTION_DAYS])

    await vi.advanceTimersByTimeAsync(CHANGE_LOG_PRUNE_INTERVAL_MS - 1)
    expect(query).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('uma falha só loga e tenta de novo no próximo ciclo — nunca propaga', async () => {
    vi.useFakeTimers()
    const failure = new Error('connection terminated')
    const query = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
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
    const query = vi.fn(async () => undefined)
    const pruner = new ChangeLogPruner({ query }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)

    pruner.stop()
    await vi.advanceTimersByTimeAsync(10 * CHANGE_LOG_PRUNE_INTERVAL_MS)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
