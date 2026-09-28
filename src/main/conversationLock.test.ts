import { describe, expect, it, vi } from 'vitest'
import { createConversationLock } from './conversationLock'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createConversationLock', () => {
  it('um de cada vez na mesma conversa, na ordem de chegada', async () => {
    const lock = createConversationLock()
    const log: string[] = []
    const gate = deferred()
    const a = lock.run('c1', async () => {
      log.push('a:start')
      await gate.promise
      log.push('a:end')
    })
    const b = lock.run('c1', async () => {
      log.push('b')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['a:start'])
    gate.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(['a:start', 'a:end', 'b'])
  })

  it('conversas diferentes não esperam; uma falha não trava a fila', async () => {
    const lock = createConversationLock()
    const gate = deferred()
    const slow = lock.run('c1', () => gate.promise)
    expect(await lock.run('c2', async () => 'livre')).toBe('livre')
    gate.resolve()
    await slow
    await expect(lock.run('c1', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(await lock.run('c1', async () => 'segue')).toBe('segue')
  })

  it('sem prazo: uma operação lenta NUNCA perde a vez — a seguinte só roda depois que ela termina de verdade', async () => {
    vi.useFakeTimers()
    try {
      const lock = createConversationLock()
      const gate = deferred()
      const log: string[] = []
      const slow = lock.run('c1', async () => {
        log.push('lenta:início')
        await gate.promise
        log.push('lenta:fim')
      })
      const next = lock.run('c1', async () => {
        log.push('seguinte')
      })
      // Muito além de qualquer prazo antigo (90 s): a seguinte continua esperando.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(log).toEqual(['lenta:início'])
      gate.resolve()
      await Promise.all([slow, next])
      expect(log).toEqual(['lenta:início', 'lenta:fim', 'seguinte'])
    } finally {
      vi.useRealTimers()
    }
  })
})
