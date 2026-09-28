import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIRROR_APPEND_RETRY_BUDGET_MS } from './persistence/postgresRetry'
import { SESSION_SETUP_TIMEOUT_MS } from './persistence/postgresSessionSetup'
import { POSTGRES_CONNECT_TIMEOUT_MS, POSTGRES_LOCK_TIMEOUT_MS } from './persistence/postgresTimeouts'
import { LEASE_RELEASE_WAIT_MS } from './persistence/leaseKeeper'
import {
  LEASE_ACQUIRE_DEADLINE_MS,
  LEASE_RELEASE_DEADLINE_MS,
  RESUME_PREPARE_DEADLINE_MS,
  SESSION_OPERATION_CEILING_MS,
  START_TYPESAFE_CEILING_MS,
  StepDeadlineError,
  createStepRunner
} from './sessionSteps'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createStepRunner — prazo por passo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminou no prazo: devolve o valor; falhou no prazo: devolve a falha', async () => {
    const steps = createStepRunner()
    expect(await steps.run('c:lease', 'passo', 1000, async () => 'ok')).toBe('ok')
    await expect(steps.run('c:lease', 'passo', 1000, async () => Promise.reject(new Error('banco')))).rejects.toThrow('banco')
    expect(steps.pending('c:lease')).toBe(false)
  })

  it('estourou: falha com StepDeadlineError; o valor que chega depois vai para o undo', async () => {
    vi.useFakeTimers()
    const steps = createStepRunner()
    const late = deferred<string>()
    const undo = vi.fn()
    const run = steps.run('c:lease', 'A aquisição do lease', 35_000, () => late.promise, undo).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(35_000)
    const error = await run
    expect(error).toBeInstanceOf(StepDeadlineError)
    expect((error as Error).message).toMatch(/A aquisição do lease não terminou em 35 s/)
    expect(undo).not.toHaveBeenCalled()
    expect(steps.pending('c:lease')).toBe(true)
    late.resolve('lease-atrasado')
    await vi.advanceTimersByTimeAsync(0)
    expect(undo).toHaveBeenCalledWith('lease-atrasado')
    expect(steps.pending('c:lease')).toBe(false)
  })

  it('o próximo passo da MESMA chave espera o atrasado assentar (nunca correm juntos); outra chave não espera', async () => {
    vi.useFakeTimers()
    const steps = createStepRunner()
    const late = deferred<string>()
    void steps.run('c:lease', 'passo', 100, () => late.promise).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    const started: string[] = []
    const next = steps.run('c:lease', 'passo', 1000, async () => {
      started.push('mesma')
      return 'nova'
    })
    expect(await steps.run('d:lease', 'passo', 1000, async () => 'outra')).toBe('outra')
    await vi.advanceTimersByTimeAsync(500)
    expect(started).toEqual([])
    late.resolve('x')
    await vi.advanceTimersByTimeAsync(0)
    expect(await next).toBe('nova')
    expect(started).toEqual(['mesma'])
  })

  it('o atrasado anterior que não assenta dentro do prazo do seguinte: o seguinte falha sem nem começar', async () => {
    vi.useFakeTimers()
    const steps = createStepRunner()
    void steps.run('c:resume', 'passo', 100, () => new Promise<void>(() => {})).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    const start = vi.fn(async () => 'nunca')
    const next = steps.run('c:resume', 'A preparação da retomada', 1000, start).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await next).toBeInstanceOf(StepDeadlineError)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('prazos: derivados dos tetos reais do caminho', () => {
  it('aquisição do lease (35 s) ≥ vaga + SET + espera pela trava da linha', () => {
    expect(POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS + POSTGRES_LOCK_TIMEOUT_MS).toBe(33_000)
    expect(LEASE_ACQUIRE_DEADLINE_MS).toBe(35_000)
  })

  it('soltura do lease (20 s) ≥ espera pela renovação em voo + vaga + SET', () => {
    expect(LEASE_RELEASE_WAIT_MS + POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS).toBe(19_000)
    expect(LEASE_RELEASE_DEADLINE_MS).toBe(20_000)
  })

  it('preparo da retomada (90 s) ≥ um append no teto + vaga e SET da consulta e da marcação', () => {
    const connect = POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS
    expect(MIRROR_APPEND_RETRY_BUDGET_MS + 2 * connect).toBe(81_000)
    expect(RESUME_PREPARE_DEADLINE_MS).toBe(90_000)
  })

  it('teto de uma operação no lock = soma dos prazos do caminho mais longo = 188 s', () => {
    expect(START_TYPESAFE_CEILING_MS).toBe(8_000)
    expect(SESSION_OPERATION_CEILING_MS).toBe(8_000 + 15_000 + 20_000 + 35_000 + 90_000 + 20_000)
    expect(SESSION_OPERATION_CEILING_MS).toBe(188_000)
  })
})
