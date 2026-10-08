import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDeadlineMessage } from '@shared/readDeadline'
import { DeadlineError, isDeadlineError, readFailureText, settleWithin, withDeadline } from './deadline'
import { ipcErrorMessage } from './ipcError'

describe('prazo das leituras da tela', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reconhece o estouro vindo do preload (mensagem com a marca) e o daqui', () => {
    const fromPreload = new Error(`Error invoking remote method: ${readDeadlineMessage(2_000)}`)
    expect(isDeadlineError(fromPreload)).toBe(true)
    expect(isDeadlineError(new DeadlineError())).toBe(true)
    expect(isDeadlineError(new Error('outra coisa'))).toBe(false)
    expect(readFailureText(fromPreload, 'x')).toBe('O banco está demorando para responder.')
    expect(ipcErrorMessage(fromPreload, 'x')).toBe('o banco está demorando para responder — tente de novo')
  })

  it('withDeadline rejeita no prazo; settleWithin para de esperar sem rejeitar', async () => {
    const never = new Promise<string>(() => undefined)
    const late = withDeadline(never, 2_000)
    const settled = settleWithin(never, 1_000)
    const outcome = late.then(() => 'ok', (error: unknown) => (isDeadlineError(error) ? 'prazo' : 'outro'))
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(outcome).resolves.toBe('prazo')
    await expect(settled).resolves.toBeUndefined()
    await expect(withDeadline(Promise.resolve('rápido'), 2_000)).resolves.toBe('rápido')
  })
})
