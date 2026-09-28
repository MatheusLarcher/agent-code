// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { isTransientPostgresError, MIRROR_APPEND_RETRY_BUDGET_MS, withTransientRetry } from './postgresRetry'
import { StorageError } from './types'

function pgError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

describe('isTransientPostgresError', () => {
  it.each([
    ['timeout do pool', pgError('timeout exceeded when trying to connect')],
    ['conexão encerrada', pgError('Connection terminated unexpectedly')],
    ['ECONNRESET', pgError('read ECONNRESET', 'ECONNRESET')],
    ['ETIMEDOUT', pgError('connect ETIMEDOUT', 'ETIMEDOUT')],
    ['EPIPE', pgError('write EPIPE', 'EPIPE')],
    ['57P01 (pg_terminate_backend)', pgError('terminating connection due to administrator command', '57P01')],
    ['classe 08', pgError('connection failure', '08006')],
    ['causa embrulhada', new Error('falhou', { cause: pgError('x', 'ECONNREFUSED') })],
    ['StorageError de conexão', new StorageError('CONNECTION_TIMEOUT', 'x', true)]
  ])('%s é transitório', (_label, error) => {
    expect(isTransientPostgresError(error)).toBe(true)
  })

  it.each([
    ['violação de unique', pgError('duplicate key value', '23505')],
    ['sintaxe', pgError('syntax error at or near', '42601')],
    ['statement timeout', pgError('canceling statement due to statement timeout', '57014')],
    ['pool encerrado', pgError('Cannot use a pool after calling end on the pool')],
    ['StorageError de verificação', new StorageError('SESSION_HANDOFF_INCOMPLETE', 'x')],
    ['não-erro', 'texto']
  ])('%s não é transitório', (_label, error) => {
    expect(isTransientPostgresError(error)).toBe(false)
  })
})

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept
  }
}

describe('withTransientRetry', () => {
  it('repete falha transitória com backoff e devolve o sucesso', async () => {
    const clock = fakeClock()
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(pgError('timeout exceeded when trying to connect'))
      .mockRejectedValueOnce(pgError('read ECONNRESET', 'ECONNRESET'))
      .mockResolvedValueOnce('ok')
    await expect(withTransientRetry(fn, { ...clock, delaysMs: [100, 200, 400] })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(clock.slept).toEqual([100, 200])
  })

  it('erro não transitório falha na hora, sem esperar', async () => {
    const clock = fakeClock()
    const fn = vi.fn(async () => {
      throw pgError('duplicate key value', '23505')
    })
    await expect(withTransientRetry(fn, clock)).rejects.toThrow('duplicate key')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })

  it('para quando a próxima espera estouraria o orçamento', async () => {
    const clock = fakeClock()
    const fn = vi.fn(async () => {
      throw pgError('timeout exceeded when trying to connect')
    })
    await expect(withTransientRetry(fn, { ...clock, budgetMs: 1_000, delaysMs: [300, 600] })).rejects.toThrow('timeout')
    // 300 (t=300) cabe; 600 levaria a 900 < 1000, cabe; o próximo 600 levaria a 1500: para.
    expect(clock.slept).toEqual([300, 600])
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('o orçamento padrão (prazo único do append) fica bem abaixo dos 60s do SDK', async () => {
    const clock = fakeClock()
    const fn = vi.fn(async () => {
      throw pgError('Connection terminated unexpectedly')
    })
    await expect(withTransientRetry(fn, clock)).rejects.toThrow()
    expect(clock.now()).toBeLessThan(MIRROR_APPEND_RETRY_BUDGET_MS)
    expect(MIRROR_APPEND_RETRY_BUDGET_MS).toBeLessThanOrEqual(45_000)
  })

  it('não começa tentativa nova se o que sobra até o prazo não cobre uma tentativa inteira', async () => {
    const clock = fakeClock()
    const fn = vi.fn(async () => {
      throw pgError('timeout exceeded when trying to connect')
    })
    await expect(
      withTransientRetry(fn, { ...clock, deadlineAt: 10_000, attemptMinMs: 8_000, delaysMs: [500, 1_000, 2_000] })
    ).rejects.toThrow('timeout')
    // t=0 tenta; 500+8000 < 10000 → tenta em t=500; 500+1000+8000 = 9500 < 10000
    // → tenta em t=1500; 1500+2000+8000 > 10000 → para.
    expect(clock.slept).toEqual([500, 1_000])
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
