// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MirrorRepair } from './mirrorRepair'
import { reconnectDelayMs } from './persistence/storageReconnect'

const offline = () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })

describe('MirrorRepair: gatilho quando a persistência volta', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('kick() tenta já, sem esperar o degrau do backoff (que chegaria a 1h)', async () => {
    const attempt = vi.fn().mockRejectedValue(offline())
    const onRestored = vi.fn()
    const repair = new MirrorRepair({ attempt, onRestored, onGiveUp: vi.fn() })
    repair.begin()
    // Dez falhas seguidas: o próximo degrau já é de 1024s.
    await vi.advanceTimersByTimeAsync(Array.from({ length: 10 }, (_, i) => reconnectDelayMs(i)).reduce((a, b) => a + b))
    expect(attempt).toHaveBeenCalledTimes(10)

    attempt.mockResolvedValueOnce(undefined)
    repair.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(11)
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(repair.pending).toBe(false)
  })

  it('kick() com o turno ainda gravando (startAfter pendente) não antecipa nada', async () => {
    const attempt = vi.fn(async () => undefined)
    const repair = new MirrorRepair({ attempt, onRestored: vi.fn(), onGiveUp: vi.fn() })
    let turnEnded!: () => void
    repair.begin(new Promise<void>((resolve) => (turnEnded = resolve)))
    repair.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).not.toHaveBeenCalled()

    turnEnded()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('kick() sem reparo pendente é no-op', async () => {
    const attempt = vi.fn(async () => undefined)
    const repair = new MirrorRepair({ attempt, onRestored: vi.fn(), onGiveUp: vi.fn() })
    repair.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).not.toHaveBeenCalled()
  })
})
