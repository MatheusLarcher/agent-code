import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStopHolds, type StopPhase } from './stopHold'

/**
 * A espera do Stop que mantém a fila (puro, relógio falso): "parando" até o
 * terminal do turno parado (`result` + carência para o `error` do fim do stream,
 * ou o `error`); sem turno para parar, nada a esperar; turno mudo, reserva curta
 * do recibo; turno que falou, só o terminal (reserva longa só para nunca travar).
 * Depois de soltar, nenhum terminal é engolido.
 */

const SETTLE = 3000
const GRACE = 500
const SAFETY = 30_000

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function make() {
  const onRelease = vi.fn<(cid: string) => void>()
  return { holds: createStopHolds({ settleMs: SETTLE, graceMs: GRACE, safetyMs: SAFETY, onRelease }), onRelease }
}
function stopped(phase: StopPhase) {
  const k = make()
  k.holds.begin('a', phase)
  return k
}

describe('createStopHolds — o terminal do turno parado', () => {
  it('result: a carência espera o error do fim do stream — solta em 500 ms, nem 1 ms antes', () => {
    const { holds, onRelease } = stopped('started')
    holds.receipt('a', false)
    expect(holds.terminal('a', 'result')).toBe('wait')
    expect(holds.isHeld('a')).toBe(true)
    vi.advanceTimersByTime(GRACE - 1)
    expect(onRelease).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onRelease).toHaveBeenCalledTimes(1)
    expect(holds.isHeld('a')).toBe(false)
  })

  it('result e o error do fim do stream: o error solta na hora (e a carência não solta de novo)', () => {
    const { holds, onRelease } = stopped('started')
    expect(holds.terminal('a', 'result')).toBe('wait')
    expect(holds.terminal('a', 'error')).toBe('release')
    expect(holds.isHeld('a')).toBe(false)
    vi.advanceTimersByTime(SAFETY * 2)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it('o error primeiro: solta na hora (depois dele a query morreu, nada mais vem)', () => {
    const { holds } = stopped('unknown')
    expect(holds.terminal('a', 'error')).toBe('release')
    expect(holds.isHeld('a')).toBe(false)
  })

  it('depois de soltar, nada é engolido: o terminal seguinte é normal (o do turno que saiu da fila)', () => {
    const { holds } = stopped('started')
    holds.terminal('a', 'result')
    vi.advanceTimersByTime(GRACE)
    expect(holds.terminal('a', 'result')).toBe('normal')
    expect(holds.terminal('a', 'error')).toBe('normal')
    const k = stopped('unknown')
    k.holds.receipt('a', false)
    vi.advanceTimersByTime(SETTLE)
    expect(k.holds.terminal('a', 'result')).toBe('normal')
  })

  it('terminal identificado (turnIds do turno parado): solta na hora, sem carência — o error tardio também traz o id', () => {
    const { holds, onRelease } = stopped('started')
    holds.receipt('a', false)
    expect(holds.terminal('a', 'result', true)).toBe('release')
    expect(holds.isHeld('a')).toBe(false)
    vi.advanceTimersByTime(SAFETY * 2)
    expect(onRelease).not.toHaveBeenCalled()
    expect(holds.terminal('a', 'error', true)).toBe('normal')
  })

  it('terminal antes do recibo: o recibo que chega depois não arma nada', () => {
    const { holds, onRelease } = stopped('started')
    expect(holds.terminal('a', 'error')).toBe('release')
    holds.receipt('a', false)
    vi.advanceTimersByTime(SAFETY * 2)
    expect(onRelease).not.toHaveBeenCalled()
  })
})

describe('createStopHolds — sem terminal', () => {
  it('unsent (o envio nem saiu: sem query, connect pendente): não há o que esperar — solta no recibo', () => {
    const { holds, onRelease } = stopped('unsent')
    expect(holds.isHeld('a')).toBe(true)
    holds.receipt('a', false)
    expect(onRelease).toHaveBeenCalledWith('a')
    expect(holds.isHeld('a')).toBe(false)
  })

  it('unknown (enviada, turno mudo — o Stop pode ter pegado antes de começar): solta 3000 ms depois do recibo, nem 1 ms antes', () => {
    const { holds, onRelease } = stopped('unknown')
    vi.advanceTimersByTime(SAFETY) // antes do recibo, nada corre
    expect(holds.isHeld('a')).toBe(true)
    holds.receipt('a', false)
    vi.advanceTimersByTime(SETTLE - 1)
    expect(onRelease).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it('started (o turno falou: o terminal vem): a reserva curta não solta; só a longa, contada do último sinal de vida', () => {
    const { holds, onRelease } = stopped('started')
    holds.receipt('a', false)
    vi.advanceTimersByTime(SETTLE * 3)
    expect(onRelease).not.toHaveBeenCalled()
    holds.activity('a') // o CLI ainda produzindo (recibo por prazo de 5 s)
    vi.advanceTimersByTime(SAFETY - 1)
    expect(onRelease).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it('unknown que fala durante a espera vira started: a reserva curta deixa de valer', () => {
    const { holds, onRelease } = stopped('unknown')
    holds.receipt('a', false)
    vi.advanceTimersByTime(SETTLE - 1)
    holds.activity('a')
    vi.advanceTimersByTime(SETTLE * 3)
    expect(onRelease).not.toHaveBeenCalled()
    expect(holds.terminal('a', 'result')).toBe('wait')
  })

  it('mensagens sobreviveram ao Stop: o turno segue, a espera acaba sem soltar', () => {
    const { holds, onRelease } = stopped('started')
    holds.receipt('a', true)
    expect(holds.isHeld('a')).toBe(false)
    vi.advanceTimersByTime(SAFETY * 2)
    expect(onRelease).not.toHaveBeenCalled()
    expect(holds.terminal('a', 'result')).toBe('normal')
  })

  it('cancel (Stop comum, conversa apagada) e dispose: nada solta depois; conversas não se seguram', () => {
    const { holds, onRelease } = make()
    holds.begin('a', 'unknown')
    holds.receipt('a', false)
    holds.cancel('a')
    expect(holds.terminal('a', 'result')).toBe('normal')
    holds.begin('b', 'started')
    expect(holds.isHeld('c')).toBe(false)
    expect(holds.terminal('c', 'result')).toBe('normal')
    holds.receipt('b', false)
    holds.dispose()
    vi.advanceTimersByTime(SAFETY * 2)
    expect(onRelease).not.toHaveBeenCalled()
  })
})
