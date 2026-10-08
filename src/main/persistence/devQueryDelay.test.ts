// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { applyDevQueryDelay, configureDevQueryDelay, devQueryDelayMs } from './devQueryDelay'

function fakePool() {
  const pool = new EventEmitter()
  const calls: unknown[][] = []
  const client = {
    query: vi.fn(function (...args: unknown[]) {
      calls.push(args)
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        callback(null, { rows: [] })
        return undefined
      }
      return isSubmit(args[0]) ? args[0] : Promise.resolve({ rows: [] })
    })
  }
  const isSubmit = (value: unknown): boolean => typeof (value as { submit?: unknown })?.submit === 'function'
  return { pool: pool as unknown as Pool, emitter: pool, client, calls }
}

describe('AGENT_CODE_DEV_PG_DELAY_MS', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    configureDevQueryDelay(0)
    vi.useRealTimers()
  })

  it('valor torto, negativo ou ausente desliga; acima de 60 s é cortado', () => {
    expect(configureDevQueryDelay('abc')).toBe(0)
    expect(configureDevQueryDelay(-5)).toBe(0)
    expect(configureDevQueryDelay(undefined)).toBe(0)
    expect(configureDevQueryDelay('2000')).toBe(2000)
    expect(configureDevQueryDelay(999_999)).toBe(60_000)
    expect(devQueryDelayMs()).toBe(60_000)
  })

  it('atrasa toda consulta (promessa e callback); cursor passa direto', async () => {
    configureDevQueryDelay(2000)
    const { pool, emitter, client, calls } = fakePool()
    applyDevQueryDelay(pool)
    emitter.emit('connect', client)

    const promised = (client.query as (...args: unknown[]) => Promise<unknown>)('SELECT 1')
    const callback = vi.fn()
    ;(client.query as (...args: unknown[]) => unknown)('SELECT 2', [], callback)
    const cursor = { submit: () => undefined }
    expect((client.query as (...args: unknown[]) => unknown)(cursor)).toBe(cursor)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((call) => call[0])).toEqual([cursor, 'SELECT 1', 'SELECT 2'])
    await expect(promised).resolves.toEqual({ rows: [] })
    expect(callback).toHaveBeenCalledWith(null, { rows: [] })
  })

  it('desligado: o pool nem é envolvido', () => {
    const { pool, emitter, client } = fakePool()
    const original = client.query
    applyDevQueryDelay(pool)
    emitter.emit('connect', client)
    expect(client.query).toBe(original)
  })
})
