// @vitest-environment node
// Ciclo de vida da persistência com o PostgreSQL de mentira: queda do backend
// autoritativo (o change feed desistiu) -> offline -> reconexão automática com
// backoff, aviso de resume do SO e o botão manual dividindo a mesma tentativa.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageError } from './types'

const hoisted = vi.hoisted(() => ({
  provision: vi.fn(),
  repositories: [] as Array<{ onOffline: (error: unknown) => void; closed: boolean }>
}))

vi.mock('./kvFacade', () => ({ configureKvRepository: vi.fn(), configureKvRepositoryOffline: vi.fn() }))
vi.mock('../memory/memoryRuntime', () => ({ configureMemoryRuntime: vi.fn() }))
vi.mock('../tasks/taskRuntime', () => ({ configureTaskRuntime: vi.fn() }))
vi.mock('./sqliteRepository', () => ({ SqliteRepository: class {} }))
vi.mock('./sqliteTransitionBackup', () => ({ backupSqliteForTransition: vi.fn() }))
vi.mock('./postgresTransfer', () => ({
  hasCommittedActivation: vi.fn(),
  importRepositoryToPostgres: vi.fn(),
  writeRepositoryToSqlite: vi.fn()
}))
vi.mock('./bootstrapStore', () => ({
  POSTGRES_DATABASE: 'agent-code',
  BootstrapStore: class {
    async load() {
      return {
        installationId: 'install-1',
        backend: 'postgres',
        transitionState: 'idle',
        transitionId: null,
        postgres: { encryptedPassword: 'x' }
      }
    }
    async connection() {
      return { host: 'db', port: 5432, user: 'u', password: 'p', tlsMode: 'disable' }
    }
  }
}))
vi.mock('./postgresProvisioning', () => ({
  provisionPostgres: hoisted.provision,
  postgresClientConfig: () => ({}),
  testPostgresConnection: vi.fn()
}))
vi.mock('./postgresRepository', () => ({
  PostgresRepository: class {
    closed = false
    constructor(_pool: unknown, _config: unknown, _id: string, _version: string, readonly onOffline: (e: unknown) => void) {
      hoisted.repositories.push(this)
    }
    async initialize() {}
    async verifyReadable() {}
    subscribe() {
      return () => undefined
    }
    async close() {
      this.closed = true
    }
  }
}))

const { StorageLifecycleService } = await import('./lifecycle')
const { reconnectDelayMs } = await import('./storageReconnect')

const offlineError = () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })

async function readyLifecycle() {
  hoisted.provision.mockResolvedValueOnce({ pool: { end: vi.fn(async () => undefined) } })
  const lifecycle = new StorageLifecycleService()
  const states: string[] = []
  lifecycle.subscribe((status) => states.push(status.state))
  await lifecycle.initialize({
    location: { dir: 'x', dbPath: 'x/db' },
    userDataDir: 'x',
    secureStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
    appVersion: 'test'
  })
  expect(lifecycle.status().state).toBe('postgres-ready')
  return { lifecycle, states }
}

describe('StorageLifecycleService: reconexão automática', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.provision.mockReset()
    hoisted.repositories.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('backend caiu: fica offline, tenta sozinho com backoff e volta a postgres-ready quando a rede volta', async () => {
    const { lifecycle } = await readyLifecycle()
    hoisted.provision.mockRejectedValueOnce(offlineError())
    hoisted.repositories[0].onOffline(offlineError())
    expect(lifecycle.status()).toMatchObject({ state: 'postgres-offline', writable: false })
    expect(hoisted.repositories[0].closed).toBe(true)
    expect(() => lifecycle.repository()).toThrow(StorageError)

    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
    expect(lifecycle.status().state).toBe('postgres-offline')

    hoisted.provision.mockResolvedValueOnce({ pool: { end: vi.fn() } })
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1))
    expect(lifecycle.status()).toMatchObject({ state: 'postgres-ready', writable: true })
    expect(lifecycle.repository()).toBe(hoisted.repositories[1])
    // Online: não sobra tentativa agendada abrindo pools em paralelo.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hoisted.provision).toHaveBeenCalledTimes(3)
    await lifecycle.close()
  })

  it('um repositório já substituído não derruba o atual', async () => {
    const { lifecycle } = await readyLifecycle()
    hoisted.provision.mockResolvedValueOnce({ pool: { end: vi.fn() } })
    hoisted.repositories[0].onOffline(offlineError())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(lifecycle.status().state).toBe('postgres-ready')
    hoisted.repositories[0].onOffline(offlineError())
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })

  it('volta da suspensão: resumeReconnect tenta na hora, sem esperar o degrau do backoff', async () => {
    const { lifecycle } = await readyLifecycle()
    hoisted.provision.mockRejectedValue(offlineError())
    hoisted.repositories[0].onOffline(offlineError())
    // Esgota alguns degraus: o próximo já está longe.
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0) + reconnectDelayMs(1))
    const calls = hoisted.provision.mock.calls.length
    hoisted.provision.mockReset()
    hoisted.provision.mockResolvedValueOnce({ pool: { end: vi.fn() } })
    lifecycle.resumeReconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(3)
    expect(hoisted.provision).toHaveBeenCalledTimes(1)
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })

  it('resume com o banco de pé é no-op (não reabre pool)', async () => {
    const { lifecycle } = await readyLifecycle()
    lifecycle.resumeReconnect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hoisted.provision).toHaveBeenCalledTimes(1)
    await lifecycle.close()
  })

  it('espera exponencial 1s, 2s, 4s...; um gatilho imediato que falha zera a espera para 1s', async () => {
    const { lifecycle } = await readyLifecycle()
    hoisted.provision.mockRejectedValue(offlineError())
    hoisted.repositories[0].onOffline(offlineError())
    // 1s + 2s + 4s + 8s: quatro tentativas automáticas.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(hoisted.provision).toHaveBeenCalledTimes(5)
    // O próximo degrau seria 16s. O resume tenta na hora e ainda falha...
    lifecycle.resumeReconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.provision).toHaveBeenCalledTimes(6)
    // ...então a espera recomeça em 1s, não em 32s.
    await vi.advanceTimersByTimeAsync(999)
    expect(hoisted.provision).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(hoisted.provision).toHaveBeenCalledTimes(7)
    await lifecycle.close()
  })

  it('"Tentar novamente" sem rascunho com o banco já de pé (status atrasado no renderer) não reabre pool', async () => {
    const { lifecycle } = await readyLifecycle()
    await lifecycle.retryPostgres()
    expect(hoisted.provision).toHaveBeenCalledTimes(1)
    expect(lifecycle.repository()).toBe(hoisted.repositories[0])
    await lifecycle.close()
  })

  it('"Tentar novamente" durante uma tentativa automática divide a mesma tentativa', async () => {
    const { lifecycle } = await readyLifecycle()
    let release!: () => void
    hoisted.provision.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ pool: { end: vi.fn() } })))
    )
    hoisted.repositories[0].onOffline(offlineError())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
    const manual = lifecycle.retryPostgres()
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
    release()
    await manual
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })

  it('erro que repetir não resolve (senha) para o ciclo e fica no status, sem prometer reconexão', async () => {
    const { lifecycle } = await readyLifecycle()
    hoisted.provision.mockRejectedValue(new StorageError('AUTHENTICATION_FAILED', 'Senha recusada.', false))
    hoisted.repositories[0].onOffline(offlineError())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(lifecycle.status()).toMatchObject({
      state: 'postgres-offline',
      error: { code: 'AUTHENTICATION_FAILED', retryable: false }
    })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
    await lifecycle.close()
  })

  it('close() cancela a reconexão e uma tentativa que termina depois não reinstala o repositório', async () => {
    const { lifecycle } = await readyLifecycle()
    let release!: () => void
    hoisted.provision.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ pool: { end: vi.fn() } })))
    )
    hoisted.repositories[0].onOffline(offlineError())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    await lifecycle.close()
    release()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(hoisted.repositories[1].closed).toBe(true)
    expect(() => lifecycle.repository()).toThrow(StorageError)
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
  })

  it('banco fora já na abertura: entra em reconexão automática em vez de esperar o botão', async () => {
    hoisted.provision.mockRejectedValueOnce(offlineError())
    const lifecycle = new StorageLifecycleService()
    await lifecycle.initialize({
      location: { dir: 'x', dbPath: 'x/db' },
      userDataDir: 'x',
      secureStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
      appVersion: 'test'
    })
    expect(lifecycle.status().state).toBe('postgres-offline')
    hoisted.provision.mockResolvedValueOnce({ pool: { end: vi.fn() } })
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })
})
