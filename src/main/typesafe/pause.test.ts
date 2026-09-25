// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  classifyTypeSafeFailure,
  createTypeSafePause,
  TYPESAFE_BLOCKING_TIMEOUT_MS,
  TYPESAFE_PAUSE_MS
} from './pause'

const err = (fields: Record<string, unknown>): Error => Object.assign(new Error('x'), fields)

describe('classifyTypeSafeFailure', () => {
  it('separa chave recusada, limite, queda e erro nosso', () => {
    expect(classifyTypeSafeFailure(err({ status: 401 })).kind).toBe('auth')
    expect(classifyTypeSafeFailure(err({ status: 403 })).kind).toBe('auth')
    expect(classifyTypeSafeFailure(err({ status: 429, retryAfterMs: 30_000 }))).toEqual({ kind: 'rate', retryAfterMs: 30_000 })
    expect(classifyTypeSafeFailure(err({ status: 502 })).kind).toBe('transient')
    expect(classifyTypeSafeFailure(err({ name: 'APITimeoutError' })).kind).toBe('transient')
    expect(classifyTypeSafeFailure(err({ name: 'APIConnectionError' })).kind).toBe('transient')
    expect(classifyTypeSafeFailure(err({ name: 'APIUserAbortError' })).kind).toBe('ignore')
    expect(classifyTypeSafeFailure(err({ status: 400 })).kind).toBe('ignore')
  })
})

describe('createTypeSafePause', () => {
  function setup() {
    let clock = 1_000_000
    const onPause = vi.fn()
    const pause = createTypeSafePause({ now: () => clock, onPause })
    return { pause, onPause, tick: (ms: number) => (clock += ms), at: () => clock }
  }

  it('teto do caminho que bloqueia é ~3 s', () => {
    expect(TYPESAFE_BLOCKING_TIMEOUT_MS).toBe(3000)
  })

  it('401 entra em pausa de 10 min na hora e avisa uma vez', () => {
    const { pause, onPause, at } = setup()
    pause.recordFailure(err({ status: 401 }), 'k1')
    expect(pause.isPaused('k1')).toBe(true)
    expect(onPause).toHaveBeenCalledWith({ pausedUntil: at() + TYPESAFE_PAUSE_MS, reason: 'key recusada' })
    pause.isPaused('k1')
    expect(onPause).toHaveBeenCalledTimes(1)
  })

  it('2 falhas SEGUIDAS pausam; sucesso no meio zera a contagem', () => {
    const { pause } = setup()
    pause.recordFailure(err({ name: 'APITimeoutError' }), 'k1')
    pause.recordSuccess()
    pause.recordFailure(err({ status: 500 }), 'k1')
    expect(pause.isPaused('k1')).toBe(false)
    pause.recordFailure(err({ status: 500 }), 'k1')
    expect(pause.isPaused('k1')).toBe(true)
  })

  it('429 respeita o Retry-After', () => {
    const { pause, tick } = setup()
    pause.recordFailure(err({ status: 429, retryAfterMs: 60_000 }), 'k1')
    expect(pause.isPaused('k1')).toBe(true)
    tick(60_000)
    expect(pause.isPaused('k1')).toBe(false)
  })

  it('sai da pausa quando o tempo acaba, a chave muda ou o modo é religado', () => {
    const { pause, tick } = setup()
    pause.recordFailure(err({ status: 401 }), 'k1')
    tick(TYPESAFE_PAUSE_MS - 1)
    expect(pause.isPaused('k1')).toBe(true)
    tick(1)
    expect(pause.isPaused('k1')).toBe(false)

    pause.recordFailure(err({ status: 401 }), 'k1')
    expect(pause.isPaused('k2')).toBe(false)

    pause.recordFailure(err({ status: 401 }), 'k1')
    pause.reset()
    expect(pause.status()).toEqual({ pausedUntil: null, reason: null })
  })
})
