/** A store do "último sinal" (liveness.ts): guarda o maior, por conversa; o raciocínio aberto; o clear. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveness } from './liveness'

afterEach(() => {
  liveness.clear('a')
  liveness.clear('b')
  vi.useRealTimers()
})

describe('liveness', () => {
  it('sem sinal: undefined; note sem hora usa o agora', () => {
    expect(liveness.get('a')).toBeUndefined()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    liveness.note('a')
    expect(liveness.get('a')).toBe(1_000_000)
  })

  it('guarda o MAIOR: um heartbeat atrasado não volta o relógio', () => {
    liveness.note('a', 500)
    liveness.note('a', 300)
    expect(liveness.get('a')).toBe(500)
    liveness.note('a', 900)
    expect(liveness.get('a')).toBe(900)
    liveness.note('a', Number.NaN)
    expect(liveness.get('a')).toBe(900)
  })

  it('por conversa', () => {
    liveness.note('a', 10)
    liveness.note('b', 20)
    expect(liveness.get('a')).toBe(10)
    expect(liveness.get('b')).toBe(20)
  })

  it('raciocínio aberto: setThinking/thinking; null apaga', () => {
    expect(liveness.thinking('a')).toBeNull()
    liveness.setThinking('a', 42)
    expect(liveness.thinking('a')).toBe(42)
    liveness.setThinking('a', null)
    expect(liveness.thinking('a')).toBeNull()
  })

  it('clear limpa o sinal e o raciocínio da conversa', () => {
    liveness.note('a', 10)
    liveness.setThinking('a', 5)
    liveness.clear('a')
    expect(liveness.get('a')).toBeUndefined()
    expect(liveness.thinking('a')).toBeNull()
  })
})
