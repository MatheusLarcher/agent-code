// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_PRINT_PRUNE_INTERVAL_MS, BOARD_PRINT_RETENTION_MS, BoardPrintPruner } from './boardPrintPruner'

/** A faxina dos prints: corte de 30 dias atrás, no boot e a cada 24 h; falha só loga. */

afterEach(() => vi.useRealTimers())

describe('BoardPrintPruner', () => {
  it('poda com o corte de 30 dias atrás, já no boot, e de novo 24 h depois', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 9, 7, 12, 0)
    const prune = vi.fn(async (_cutoff: string) => 0)
    const pruner = new BoardPrintPruner({ pruneBoardItemPrints: prune }, undefined, () => now).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(prune).toHaveBeenCalledWith(new Date(now - BOARD_PRINT_RETENTION_MS).toISOString())
    await vi.advanceTimersByTimeAsync(BOARD_PRINT_PRUNE_INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(2)
    pruner.stop()
    await vi.advanceTimersByTimeAsync(BOARD_PRINT_PRUNE_INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(2)
  })

  it('falha: chama onError e tenta no ciclo seguinte', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const prune = vi.fn(async () => Promise.reject(new Error('banco fora')))
    const pruner = new BoardPrintPruner({ pruneBoardItemPrints: prune }, onError).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'banco fora' }))
    await vi.advanceTimersByTimeAsync(BOARD_PRINT_PRUNE_INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(2)
    pruner.stop()
  })
})
