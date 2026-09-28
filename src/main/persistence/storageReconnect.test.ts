// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  StorageReconnector,
  reconnectDelayMs
} from './storageReconnect'

describe('reconnectDelayMs', () => {
  it('começa em 1s e dobra a cada falha', () => {
    expect(RECONNECT_BASE_DELAY_MS).toBe(1_000)
    expect([0, 1, 2, 3, 4, 5].map((failures) => reconnectDelayMs(failures))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000
    ])
  })

  it('para no teto de 3600s e não passa dele', () => {
    expect(RECONNECT_MAX_DELAY_MS).toBe(3_600_000)
    expect(reconnectDelayMs(11)).toBe(2_048_000)
    expect(reconnectDelayMs(12)).toBe(3_600_000)
    expect(reconnectDelayMs(1_000)).toBe(3_600_000)
    expect(reconnectDelayMs(Number.MAX_SAFE_INTEGER)).toBe(3_600_000)
    expect(reconnectDelayMs(Infinity)).toBe(3_600_000)
  })

  it('entrada inválida ou negativa vale como nenhuma falha', () => {
    expect(reconnectDelayMs(-3)).toBe(1_000)
    expect(reconnectDelayMs(Number.NaN)).toBe(1_000)
    expect(reconnectDelayMs(2.9)).toBe(4_000)
  })

  it('aceita base e teto próprios (reuso fora da persistência)', () => {
    expect([0, 1, 2, 3].map((failures) => reconnectDelayMs(failures, 250, 1_000))).toEqual([250, 500, 1_000, 1_000])
  })
})

describe('StorageReconnector com a espera padrão', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('segue 1s, 2s, 4s... e um gatilho imediato (now) zera a espera', async () => {
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('rede fora'))
    const reconnector = new StorageReconnector({ attempt, shouldRun: () => true, isRetryable: () => true })
    reconnector.schedule()
    let elapsed = 0
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(attempt).toHaveBeenCalledTimes(index)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempt).toHaveBeenCalledTimes(index + 1)
      elapsed += delay
    }
    expect(elapsed).toBe(15_000)
    // Próximo degrau seria 16s; o gatilho imediato tenta já e volta para 1s.
    await expect(reconnector.now()).rejects.toThrow('rede fora')
    expect(attempt).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(999)
    expect(attempt).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(6)
    reconnector.cancel()
  })

  it('servidor fora por muito tempo: a espera estaciona em 1 hora', async () => {
    const attempt = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('rede fora'))
    const reconnector = new StorageReconnector({ attempt, shouldRun: () => true, isRetryable: () => true })
    reconnector.schedule()
    // 1+2+...+2048s = 4095s cobrem as 12 primeiras tentativas.
    await vi.advanceTimersByTimeAsync(4_095_000)
    expect(attempt).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(3_600_000 - 1)
    expect(attempt).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(13)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(attempt).toHaveBeenCalledTimes(14)
    reconnector.cancel()
  })
})

const DELAYS = [100, 200, 400] as const

function setup(overrides: { retryable?: boolean } = {}) {
  let offline = true
  const attempt = vi.fn<() => Promise<void>>()
  const onGiveUp = vi.fn()
  const reconnector = new StorageReconnector({
    attempt,
    shouldRun: () => offline,
    isRetryable: () => overrides.retryable ?? true,
    onGiveUp,
    delays: DELAYS
  })
  return {
    reconnector,
    attempt,
    onGiveUp,
    setOffline: (value: boolean) => {
      offline = value
    }
  }
}

describe('StorageReconnector', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tenta sozinho com backoff crescente até conseguir, e para quando volta', async () => {
    const { reconnector, attempt, setOffline } = setup()
    attempt
      .mockRejectedValueOnce(new Error('rede fora'))
      .mockRejectedValueOnce(new Error('rede fora'))
      .mockImplementationOnce(async () => setOffline(false))
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(99)
    expect(attempt).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(199)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(400)
    expect(attempt).toHaveBeenCalledTimes(3)
    // Online: nada mais é agendado.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('o atraso para no último degrau em vez de crescer para sempre', async () => {
    const { reconnector, attempt } = setup()
    attempt.mockRejectedValue(new Error('rede fora'))
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100 + 200 + 400)
    expect(attempt).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(400)
    expect(attempt).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400)
    expect(attempt).toHaveBeenCalledTimes(5)
    reconnector.cancel()
  })

  it('erro não repetível (senha, TLS) encerra o ciclo e é relatado', async () => {
    const { reconnector, attempt, onGiveUp } = setup({ retryable: false })
    const failure = new Error('senha inválida')
    attempt.mockRejectedValue(failure)
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('now() (resume do SO / botão) tenta na hora, zera o backoff e divide a tentativa em curso', async () => {
    const { reconnector, attempt, setOffline } = setup()
    attempt.mockRejectedValueOnce(new Error('rede fora')).mockRejectedValueOnce(new Error('rede fora'))
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(100 + 200)
    expect(attempt).toHaveBeenCalledTimes(2)

    let release!: () => void
    attempt.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            setOffline(false)
            resolve()
          }
        })
    )
    const first = reconnector.now()
    const second = reconnector.now()
    expect(attempt).toHaveBeenCalledTimes(3)
    release()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('now() que falha propaga o erro e mantém o ciclo automático vivo', async () => {
    const { reconnector, attempt } = setup()
    attempt.mockRejectedValueOnce(new Error('ainda fora')).mockResolvedValueOnce(undefined)
    await expect(reconnector.now()).rejects.toThrow('ainda fora')
    await vi.advanceTimersByTimeAsync(100)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('não agenda nada quando já não faz sentido (online, transição, app fechando)', async () => {
    const { reconnector, attempt, setOffline } = setup()
    setOffline(false)
    reconnector.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).not.toHaveBeenCalled()
  })

  it('cancel() (app fechando) descarta a tentativa agendada', async () => {
    const { reconnector, attempt } = setup()
    reconnector.schedule()
    reconnector.cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).not.toHaveBeenCalled()
  })
})
