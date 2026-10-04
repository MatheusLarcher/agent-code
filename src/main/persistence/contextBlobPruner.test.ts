// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTEXT_BLOB_PRUNE_INTERVAL_MS, ContextBlobPruner } from './contextBlobPruner'

afterEach(() => {
  vi.useRealTimers()
})

describe('ContextBlobPruner', () => {
  it('poda logo ao iniciar e repete a cada intervalo', async () => {
    vi.useFakeTimers()
    const pruneOrphanContextBlobs = vi.fn(async () => 0)
    new ContextBlobPruner({ pruneOrphanContextBlobs }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(pruneOrphanContextBlobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CONTEXT_BLOB_PRUNE_INTERVAL_MS - 1)
    expect(pruneOrphanContextBlobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(pruneOrphanContextBlobs).toHaveBeenCalledTimes(2)
  })

  it('uma falha só loga e tenta de novo no próximo ciclo', async () => {
    vi.useFakeTimers()
    const failure = new Error('db offline')
    const pruneOrphanContextBlobs = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(0)
    const onError = vi.fn()
    new ContextBlobPruner({ pruneOrphanContextBlobs }, onError).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(CONTEXT_BLOB_PRUNE_INTERVAL_MS)
    expect(pruneOrphanContextBlobs).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stop() cancela a poda seguinte', async () => {
    vi.useFakeTimers()
    const pruneOrphanContextBlobs = vi.fn(async () => 0)
    const pruner = new ContextBlobPruner({ pruneOrphanContextBlobs }).start()
    await vi.advanceTimersByTimeAsync(0)
    pruner.stop()
    await vi.advanceTimersByTimeAsync(10 * CONTEXT_BLOB_PRUNE_INTERVAL_MS)
    expect(pruneOrphanContextBlobs).toHaveBeenCalledTimes(1)
  })
})
