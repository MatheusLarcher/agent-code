import { describe, expect, it, vi } from 'vitest'
import { MAX_DELTA_TIME_SEC } from './constants'
import { createGameLoop } from './gameLoop'

/** requestAnimationFrame de mentira: guarda os callbacks e roda quando mandarmos. */
function fakeRaf() {
  const pending = new Map<number, FrameRequestCallback>()
  let next = 1
  return {
    raf: vi.fn((cb: FrameRequestCallback) => {
      const id = next++
      pending.set(id, cb)
      return id
    }),
    caf: vi.fn((id: number) => {
      pending.delete(id)
    }),
    /** Roda o quadro agendado (há no máximo um por vez). */
    tick(time: number) {
      const [id, cb] = [...pending.entries()][0] ?? []
      if (id === undefined || !cb) return false
      pending.delete(id)
      cb(time)
      return true
    },
    pending
  }
}

describe('createGameLoop', () => {
  it('chama update com dt limitado e render a cada quadro', () => {
    const f = fakeRaf()
    const update = vi.fn()
    const render = vi.fn()
    const loop = createGameLoop({ update, render }, f.raf, f.caf)
    loop.start()
    expect(loop.running).toBe(true)
    f.tick(1000)
    f.tick(1016)
    f.tick(5000)
    expect(update.mock.calls.map((c) => c[0])).toEqual([0, expect.closeTo(0.016, 6), MAX_DELTA_TIME_SEC])
    expect(render).toHaveBeenCalledTimes(3)
  })

  it('stop cancela o rAF agendado de verdade', () => {
    const f = fakeRaf()
    const update = vi.fn()
    const loop = createGameLoop({ update, render: () => {} }, f.raf, f.caf)
    loop.start()
    f.tick(10)
    const scheduled = f.raf.mock.results[f.raf.mock.results.length - 1].value as number
    loop.stop()
    expect(loop.running).toBe(false)
    expect(f.caf).toHaveBeenCalledWith(scheduled)
    expect(f.pending.size).toBe(0)
    expect(f.tick(20)).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('stop dentro do update não reagenda', () => {
    const f = fakeRaf()
    const loop = createGameLoop({ update: () => loop.stop(), render: () => {} }, f.raf, f.caf)
    loop.start()
    f.tick(10)
    expect(f.pending.size).toBe(0)
    expect(loop.running).toBe(false)
  })
})
