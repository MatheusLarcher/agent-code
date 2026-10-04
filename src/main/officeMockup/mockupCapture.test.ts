import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockupCapturer, type CaptureWindow } from './mockupCapture'

interface FakeWin extends CaptureWindow {
  loads: string[]
  destroyed: boolean
}

function fake(opts: { hang?: boolean; empty?: boolean; fail?: boolean } = {}, log: string[] = []): FakeWin {
  const w: FakeWin = {
    loads: [],
    destroyed: false,
    load: async (url) => {
      w.loads.push(url)
      log.push(`load ${url}`)
      if (opts.fail) throw new Error('ERR_FILE_NOT_FOUND')
      if (opts.hang) await new Promise(() => {})
    },
    capture: async () => {
      log.push('capture')
      return opts.empty ? new Uint8Array() : new Uint8Array([137, 80, 78, 71])
    },
    destroy: () => {
      w.destroyed = true
    }
  }
  return w
}

afterEach(() => vi.useRealTimers())

describe('captura do HTML para a TV (MockupCapturer)', () => {
  it('uma por vez, em fila, reaproveitando a janela escondida', async () => {
    const log: string[] = []
    const wins: FakeWin[] = []
    const c = new MockupCapturer(() => (wins.push(fake({}, log)), wins[wins.length - 1]), { settleMs: 1 })
    const [a, b] = await Promise.all([c.capture('agent-mockup://t/a.html'), c.capture('agent-mockup://t/b.html')])
    expect(a.ok && b.ok).toBe(true)
    expect(log).toEqual(['load agent-mockup://t/a.html', 'capture', 'load agent-mockup://t/b.html', 'capture'])
    expect(wins).toHaveLength(1)
    c.dispose()
    expect(wins[0].destroyed).toBe(true)
  })

  it('timeout, erro de carga e captura vazia falham e descartam a janela (a próxima nasce limpa)', async () => {
    vi.useFakeTimers()
    const plans = [{ hang: true }, { fail: true }, { empty: true }, {}]
    const wins: FakeWin[] = []
    const c = new MockupCapturer(() => (wins.push(fake(plans[wins.length])), wins[wins.length - 1]), { timeoutMs: 5_000, settleMs: 10 })
    const hung = c.capture('u1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await hung).toEqual({ ok: false, error: 'tempo esgotado' })
    const failed = c.capture('u2')
    await vi.advanceTimersByTimeAsync(20)
    expect((await failed).ok).toBe(false)
    const empty = c.capture('u3')
    await vi.advanceTimersByTimeAsync(20)
    expect(await empty).toEqual({ ok: false, error: 'captura vazia' })
    const good = c.capture('u4')
    await vi.advanceTimersByTimeAsync(20)
    expect((await good).ok).toBe(true)
    expect(wins.map((w) => w.destroyed)).toEqual([true, true, true, false])
    c.dispose()
  })

  it('sem uso por IDLE_MS a janela fecha; release fecha na hora; depois de dispose não captura', async () => {
    vi.useFakeTimers()
    const wins: FakeWin[] = []
    const c = new MockupCapturer(() => (wins.push(fake()), wins[wins.length - 1]), { settleMs: 1, idleMs: 1_000 })
    const p = c.capture('u')
    await vi.advanceTimersByTimeAsync(5)
    await p
    expect(wins[0].destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wins[0].destroyed).toBe(true)
    const q = c.capture('u')
    await vi.advanceTimersByTimeAsync(5)
    await q
    c.release()
    expect(wins[1].destroyed).toBe(true)
    c.dispose()
    expect(await c.capture('u')).toEqual({ ok: false, error: 'fechado' })
    expect(wins).toHaveLength(2)
  })
})
