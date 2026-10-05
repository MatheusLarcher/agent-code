// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_SWEEP_MS, startHandoffSweep, type HandoffSweepTarget } from './handoffSweep'

// A varredura de fundo: uma passada por vez, carrega as conversas conhecidas
// até conseguir, e nenhuma falha dela derruba o app.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function target(over: Partial<HandoffSweepTarget> = {}) {
  return {
    loadKnown: vi.fn(async () => true),
    sweep: vi.fn(async () => ({ flushed: 0, stalled: 0 })),
    ...over
  }
}

describe('startHandoffSweep', () => {
  it('passa já ao ligar e a cada 60 s; carrega as conversas conhecidas uma vez só', async () => {
    const t = target()
    const stop = startHandoffSweep(t)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.loadKnown).toHaveBeenCalledTimes(1)
    expect(t.sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HANDOFF_SWEEP_MS * 2)
    expect(t.sweep).toHaveBeenCalledTimes(3)
    expect(t.loadKnown).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(HANDOFF_SWEEP_MS * 3)
    expect(t.sweep).toHaveBeenCalledTimes(3)
  })

  it('sem banco na carga (false) ou carga que falha: tenta de novo na passada seguinte', async () => {
    const log = vi.fn()
    const loadKnown = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('banco fora do ar'))
      .mockResolvedValue(true)
    const t = target({ loadKnown })
    const stop = startHandoffSweep(t, 1_000, log)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(loadKnown).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith('[handoff] varredura falhou: banco fora do ar')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(loadKnown).toHaveBeenCalledTimes(3)
    stop()
  })

  it('varredura que rejeita não derruba nada; a próxima passada roda', async () => {
    const log = vi.fn()
    const sweep = vi
      .fn<HandoffSweepTarget['sweep']>()
      .mockRejectedValueOnce(new Error('disco cheio'))
      .mockResolvedValue({ flushed: 1, stalled: 2 })
    const stop = startHandoffSweep(target({ sweep }), 1_000, log)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[handoff] varredura falhou: disco cheio')
    expect(log).toHaveBeenCalledWith('[handoff] varredura: 2 envio(s) marcado(s) como parada')
    stop()
  })

  it('uma passada por vez: banco lento não empilha varreduras', async () => {
    let release!: () => void
    const sweep = vi.fn(
      () =>
        new Promise<{ flushed: number; stalled: number }>((resolve) => {
          release = () => resolve({ flushed: 0, stalled: 0 })
        })
    )
    const stop = startHandoffSweep(target({ sweep }), 1_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sweep).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).toHaveBeenCalledTimes(2)
    stop()
  })

  it('tracker que lança de forma síncrona também não escapa', async () => {
    const log = vi.fn()
    const stop = startHandoffSweep(
      target({
        loadKnown: () => {
          throw new Error('quebrou')
        }
      }),
      1_000,
      log
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledWith('[handoff] varredura falhou: quebrou')
    stop()
  })
})
