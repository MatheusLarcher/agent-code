import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSwapThrottle, MONITOR_SWAP_MS } from './monitorThrottle'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSwapThrottle: no máximo uma troca a cada 2 s, a última sempre aparece', () => {
  it('a primeira entra na hora; as do meio esperam e só a mais nova aparece quando o intervalo vence', () => {
    const late = vi.fn()
    const t = createSwapThrottle<string>(late)
    expect(MONITOR_SWAP_MS).toBe(2000)
    expect(t.offer('a', 'a')).toBe('a')
    vi.advanceTimersByTime(500)
    expect(t.offer('b', 'b')).toBe('a')
    vi.advanceTimersByTime(1000)
    expect(t.offer('c', 'c')).toBe('a')
    vi.advanceTimersByTime(499)
    expect(late).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenLastCalledWith('c')
    // Já está na tela: a mesma oferta não muda nada.
    expect(t.offer('c', 'c')).toBe('c')
    vi.advanceTimersByTime(10_000)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('depois da troca atrasada, a próxima também espera 2 s a partir dela', () => {
    const late = vi.fn()
    const t = createSwapThrottle<string>(late)
    t.offer('a', 'a')
    vi.advanceTimersByTime(500)
    t.offer('b', 'b')
    vi.advanceTimersByTime(1500) // b entra aos 2 s
    expect(late).toHaveBeenLastCalledWith('b')
    vi.advanceTimersByTime(1000)
    expect(t.offer('c', 'c')).toBe('b')
    vi.advanceTimersByTime(999)
    expect(late).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(late).toHaveBeenLastCalledWith('c')
  })

  it('passado o intervalo, troca na hora (sem timer)', () => {
    const late = vi.fn()
    const t = createSwapThrottle<string>(late)
    t.offer('a', 'a')
    vi.advanceTimersByTime(MONITOR_SWAP_MS)
    expect(t.offer('b', 'b')).toBe('b')
    expect(vi.getTimerCount()).toBe(0)
    expect(late).not.toHaveBeenCalled()
  })

  it('voltou ao que já está na tela antes do intervalo: a troca agendada é cancelada', () => {
    const late = vi.fn()
    const t = createSwapThrottle<string>(late)
    t.offer('a', 'a')
    t.offer('b', 'b')
    expect(t.offer('a2', 'a')).toBe('a')
    vi.advanceTimersByTime(MONITOR_SWAP_MS * 2)
    expect(late).not.toHaveBeenCalled()
  })

  it('reset: esquece a tela e cancela a troca; a próxima entra na hora', () => {
    const late = vi.fn()
    const t = createSwapThrottle<string>(late)
    t.offer('a', 'a')
    t.offer('b', 'b')
    t.reset()
    expect(vi.getTimerCount()).toBe(0)
    expect(t.offer('c', 'c')).toBe('c')
    vi.advanceTimersByTime(MONITOR_SWAP_MS * 2)
    expect(late).not.toHaveBeenCalled()
  })
})
