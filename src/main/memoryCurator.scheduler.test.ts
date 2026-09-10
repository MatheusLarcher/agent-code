// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURATOR_INTERVAL_MS, startMemoryCuratorScheduler } from './memoryCurator'

const stops: Array<() => void> = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('curator successful-run checkpoint', () => {
  it('defers scanning while checkpoint reads fail and recovers the original window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const previous = CURATOR_INTERVAL_MS
    const readCheckpoint = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline')).mockResolvedValue(String(previous))
    const runOnce = vi.fn(async () => ({ transcripts: 0, chunks: 0 }))
    const writeCheckpoint = vi.fn(async () => {})
    stops.push(await startMemoryCuratorScheduler({ readCheckpoint, writeCheckpoint, runOnce }))
    await vi.advanceTimersByTimeAsync(0)
    expect(runOnce).not.toHaveBeenCalled()
    expect(writeCheckpoint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CURATOR_INTERVAL_MS)
    expect(runOnce).toHaveBeenCalledWith({ lastRunAt: previous, now: 11 * CURATOR_INTERVAL_MS })
  })

  it.each(['invalid', '-1', 'Infinity', ''])('does not overwrite invalid checkpoint %j', async (checkpoint) => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runOnce = vi.fn(async () => ({ transcripts: 0, chunks: 0 }))
    const writeCheckpoint = vi.fn(async () => {})
    stops.push(await startMemoryCuratorScheduler({
      readCheckpoint: async () => checkpoint, writeCheckpoint, runOnce
    }))
    await vi.advanceTimersByTimeAsync(CURATOR_INTERVAL_MS)
    expect(runOnce).not.toHaveBeenCalled()
    expect(writeCheckpoint).not.toHaveBeenCalled()
  })

  it('keeps the previous window after extraction fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const previous = CURATOR_INTERVAL_MS
    const runOnce = vi.fn().mockRejectedValueOnce(new Error('extraction failed'))
      .mockResolvedValue({ transcripts: 0, chunks: 0 })
    const writeCheckpoint = vi.fn(async () => {})
    stops.push(await startMemoryCuratorScheduler({
      readCheckpoint: async () => String(previous), writeCheckpoint, runOnce
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeCheckpoint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CURATOR_INTERVAL_MS)
    expect(runOnce.mock.calls.map(([options]) => options.lastRunAt)).toEqual([previous, previous])
    expect(writeCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('checkpoints scan start, not completion, including an empty successful scan', async () => {
    vi.useFakeTimers()
    const started = 10 * CURATOR_INTERVAL_MS
    vi.setSystemTime(started)
    const writeCheckpoint = vi.fn(async () => {})
    const runOnce = vi.fn(async () => {
      vi.setSystemTime(started + 60_000)
      return { transcripts: 0, chunks: 0 }
    })
    stops.push(await startMemoryCuratorScheduler({
      readCheckpoint: async () => null, writeCheckpoint, runOnce
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(runOnce).toHaveBeenCalledWith({ lastRunAt: undefined, now: started })
    expect(writeCheckpoint).toHaveBeenCalledWith(String(started))
  })

  it('does not advance the in-memory cursor when persistence fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const previous = CURATOR_INTERVAL_MS
    const runOnce = vi.fn(async () => ({ transcripts: 1, chunks: 1 }))
    const writeCheckpoint = vi.fn().mockRejectedValueOnce(new Error('store offline')).mockResolvedValue(undefined)
    stops.push(await startMemoryCuratorScheduler({
      readCheckpoint: async () => String(previous), writeCheckpoint, runOnce
    }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CURATOR_INTERVAL_MS)
    expect(runOnce).toHaveBeenNthCalledWith(2, {
      lastRunAt: previous, now: 11 * CURATOR_INTERVAL_MS
    })
  })

  it('does not start a scan after stopping during checkpoint recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let finish!: (value: string) => void
    const pending = new Promise<string>((resolve) => { finish = resolve })
    const readCheckpoint = vi.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValue(pending)
    const runOnce = vi.fn(async () => ({ transcripts: 0, chunks: 0 }))
    const stop = await startMemoryCuratorScheduler({
      readCheckpoint, writeCheckpoint: async () => {}, runOnce
    })
    stops.push(stop)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    finish(String(CURATOR_INTERVAL_MS))
    await vi.advanceTimersByTimeAsync(CURATOR_INTERVAL_MS)
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('stopping during a scan prevents another scheduled run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * CURATOR_INTERVAL_MS)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const runOnce = vi.fn(async () => {
      await pending
      return { transcripts: 0, chunks: 0 }
    })
    const stop = await startMemoryCuratorScheduler({
      readCheckpoint: async () => null, writeCheckpoint: async () => {}, runOnce
    })
    stops.push(stop)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    finish()
    await vi.advanceTimersByTimeAsync(2 * CURATOR_INTERVAL_MS)
    expect(runOnce).toHaveBeenCalledTimes(1)
  })
})
