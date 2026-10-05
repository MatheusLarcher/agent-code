import { describe, expect, it, vi } from 'vitest'
import { createQueueHandoff } from './queueHandoff'

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('createQueueHandoff', () => {
  it('roda o próximo só depois do sinal do main; pending durante a espera', async () => {
    let end: (() => void) | undefined
    const waitTurnEnd = vi.fn(() => new Promise<void>((resolve) => (end = resolve)))
    const h = createQueueHandoff({ waitTurnEnd, fallbackMs: 60_000 })
    const next = vi.fn(() => 'enviado')
    const run = h.after('c1', next)
    await tick()
    expect(waitTurnEnd).toHaveBeenCalledWith('c1')
    expect(next).not.toHaveBeenCalled()
    expect(h.pending('c1')).toBe(true)
    expect(h.pending('c2')).toBe(false)
    end?.()
    await expect(run).resolves.toBe('enviado')
    expect(h.pending('c1')).toBe(false)
  })

  it('sem canal, sinal que rejeita ou que nunca volta: segue (a fila não trava)', async () => {
    const none = createQueueHandoff({ waitTurnEnd: () => undefined, fallbackMs: 10 })
    await expect(none.after('c1', () => 1)).resolves.toBe(1)
    const broken = createQueueHandoff({ waitTurnEnd: () => Promise.reject(new Error('x')), fallbackMs: 10 })
    await expect(broken.after('c1', () => 2)).resolves.toBe(2)
    vi.useFakeTimers()
    try {
      const hung = createQueueHandoff({ waitTurnEnd: () => new Promise(() => {}), fallbackMs: 1000 })
      const next = vi.fn()
      const run = hung.after('c1', next)
      await vi.advanceTimersByTimeAsync(999)
      expect(next).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await run
      expect(next).toHaveBeenCalledTimes(1)
      expect(hung.pending('c1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('erro do próximo volta para quem chamou (o caminho de falha de envio da fila)', async () => {
    const h = createQueueHandoff({ waitTurnEnd: async () => undefined, fallbackMs: 10 })
    await expect(
      h.after('c1', async () => {
        throw new Error('falhou')
      })
    ).rejects.toThrow('falhou')
    expect(h.pending('c1')).toBe(false)
  })
})
