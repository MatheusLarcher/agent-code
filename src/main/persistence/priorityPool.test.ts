// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { inInteractiveRead, interactiveRead, reserveInteractiveLane } from './priorityPool'

function fakePool(name: string) {
  const calls: string[] = []
  const pool = {
    query: vi.fn(async (sql: string) => {
      calls.push(`${name}:${sql}`)
      return { rows: [] }
    }),
    connect: vi.fn(async () => {
      calls.push(`${name}:connect`)
      return { release: () => undefined }
    }),
    end: vi.fn(async () => undefined)
  }
  return { pool: pool as unknown as Pool, raw: pool, calls }
}

describe('reserveInteractiveLane', () => {
  it('dentro de interactiveRead as consultas vão às conexões reservadas — inclusive depois de await; fora, ao pool de fundo', async () => {
    const background = fakePool('fundo')
    const reserved = fakePool('tela')
    reserveInteractiveLane(background.pool, reserved.pool)

    await background.pool.query('INSERT gravação')
    await interactiveRead(async () => {
      expect(inInteractiveRead()).toBe(true)
      await background.pool.query('SELECT conversa')
      await new Promise((resolve) => setTimeout(resolve, 1))
      await background.pool.connect()
    })
    expect(inInteractiveRead()).toBe(false)
    await background.pool.query('UPDATE telemetria')

    expect(background.calls).toEqual(['fundo:INSERT gravação', 'fundo:UPDATE telemetria'])
    expect(reserved.calls).toEqual(['tela:SELECT conversa', 'tela:connect'])
  })

  it('fechar o pool fecha os dois', async () => {
    const background = fakePool('fundo')
    const reserved = fakePool('tela')
    const end = background.raw.end
    reserveInteractiveLane(background.pool, reserved.pool)
    await background.pool.end()
    expect(end).toHaveBeenCalledTimes(1)
    expect(reserved.raw.end).toHaveBeenCalledTimes(1)
  })
})
