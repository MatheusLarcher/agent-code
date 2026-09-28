// @vitest-environment node
// Brechas da reconexão apontadas na revisão: "Corrigir configuração" (retry com
// rascunho) zera o backoff e não abre pool em paralelo com a tentativa
// automática; close() no meio da recuperação de uma ativação não reinstala
// repositório; queda durante uma transição agenda a reconexão quando ela termina.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageError } from './types'

const hoisted = vi.hoisted(() => ({
  provision: vi.fn(),
  testConnection: vi.fn(),
  committed: vi.fn(),
  writeSqlite: vi.fn(),
  data: {
    installationId: 'install-1',
    backend: 'postgres' as 'postgres' | 'sqlite',
    transitionState: 'idle' as string,
    transitionId: null as string | null,
    postgres: { encryptedPassword: 'x' }
  },
  repositories: [] as Array<{
    onOffline: (error: unknown) => void
    closed: boolean
    loadSnapshot: () => Promise<unknown>
  }>,
  snapshotGate: null as Promise<void> | null,
  sqlites: [] as Array<{ closed: boolean }>,
  sqliteGate: null as Promise<void> | null,
  abortGate: null as Promise<void> | null
}))

vi.mock('./kvFacade', () => ({ configureKvRepository: vi.fn(), configureKvRepositoryOffline: vi.fn() }))
vi.mock('../memory/memoryRuntime', () => ({ configureMemoryRuntime: vi.fn() }))
vi.mock('../tasks/taskRuntime', () => ({ configureTaskRuntime: vi.fn() }))
vi.mock('./sqliteRepository', () => ({
  SqliteRepository: class {
    backend = 'sqlite'
    closed = false
    constructor() {
      hoisted.sqlites.push(this)
    }
    async initialize() {
      await hoisted.sqliteGate
    }
    async loadSnapshot() {}
    subscribe() {
      return () => undefined
    }
    async close() {
      this.closed = true
    }
  }
}))
vi.mock('./sqliteTransitionBackup', () => ({ backupSqliteForTransition: vi.fn() }))
vi.mock('./postgresTransfer', () => ({
  hasCommittedActivation: hoisted.committed,
  importRepositoryToPostgres: vi.fn(),
  writeRepositoryToSqlite: hoisted.writeSqlite
}))
vi.mock('./bootstrapStore', () => ({
  POSTGRES_DATABASE: 'agent-code',
  BootstrapStore: class {
    async load() {
      return { ...hoisted.data }
    }
    async connection() {
      return { host: 'db', port: 5432, user: 'u', password: 'p', tlsMode: 'disable' }
    }
    async saveConnection() {}
    async beginTransition(state: string) {
      hoisted.data.transitionState = state
      hoisted.data.transitionId = 't-1'
      return 't-1'
    }
    async confirmBackend(backend: 'postgres' | 'sqlite') {
      hoisted.data.backend = backend
      hoisted.data.transitionState = 'idle'
      hoisted.data.transitionId = null
    }
    async abortTransition() {
      await hoisted.abortGate
      hoisted.data.transitionState = 'idle'
      hoisted.data.transitionId = null
    }
  }
}))
vi.mock('./postgresProvisioning', () => ({
  provisionPostgres: hoisted.provision,
  postgresClientConfig: () => ({}),
  testPostgresConnection: hoisted.testConnection
}))
vi.mock('./postgresRepository', () => ({
  PostgresRepository: class {
    backend = 'postgres'
    closed = false
    constructor(_pool: unknown, _config: unknown, _id: string, _version: string, readonly onOffline: (e: unknown) => void) {
      hoisted.repositories.push(this)
    }
    async initialize() {}
    async verifyReadable() {}
    async loadSnapshot() {
      await hoisted.snapshotGate
    }
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
const pool = () => ({ pool: { end: vi.fn(async () => undefined) } })
const draft = { host: 'db2', port: 5432, user: 'u', password: 'nova', tlsMode: 'disable' } as never

async function initialized(expected: string) {
  const lifecycle = new StorageLifecycleService()
  await lifecycle.initialize({
    location: { dir: 'x', dbPath: 'x/db' },
    userDataDir: 'x',
    secureStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
    appVersion: 'test'
  })
  expect(lifecycle.status().state).toBe(expected)
  return lifecycle
}

describe('StorageLifecycleService: brechas da reconexão', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.provision.mockReset()
    hoisted.testConnection.mockReset()
    hoisted.committed.mockReset()
    hoisted.writeSqlite.mockReset()
    hoisted.repositories.length = 0
    hoisted.snapshotGate = null
    hoisted.sqlites.length = 0
    hoisted.sqliteGate = null
    hoisted.abortGate = null
    Object.assign(hoisted.data, { backend: 'postgres', transitionState: 'idle', transitionId: null })
  })
  afterEach(() => vi.useRealTimers())

  it('"Corrigir configuração" que falha depois de muitas tentativas volta a esperar 1s, não o degrau acumulado', async () => {
    hoisted.provision.mockResolvedValueOnce(pool())
    const lifecycle = await initialized('postgres-ready')
    hoisted.provision.mockRejectedValue(offlineError())
    hoisted.repositories[0].onOffline(offlineError())
    // 1+2+4+8+16+32s: seis automáticas; o próximo degrau seria 64s.
    await vi.advanceTimersByTimeAsync(63_000)
    expect(hoisted.provision).toHaveBeenCalledTimes(7)
    hoisted.testConnection.mockRejectedValueOnce(offlineError())
    await expect(lifecycle.retryPostgres(draft)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0) - 1)
    expect(hoisted.provision).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(hoisted.provision).toHaveBeenCalledTimes(8)
    await lifecycle.close()
  })

  it('"Corrigir configuração" durante uma tentativa automática espera ela terminar: nunca dois pools em paralelo', async () => {
    hoisted.provision.mockResolvedValueOnce(pool())
    const lifecycle = await initialized('postgres-ready')
    let release!: (value: unknown) => void
    hoisted.provision.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    hoisted.repositories[0].onOffline(offlineError())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.provision).toHaveBeenCalledTimes(2)

    hoisted.testConnection.mockResolvedValue(undefined)
    hoisted.provision.mockResolvedValueOnce(pool())
    const manual = lifecycle.retryPostgres(draft)
    await vi.advanceTimersByTimeAsync(0)
    // A automática ainda está no ar: o rascunho nem foi testado.
    expect(hoisted.testConnection).not.toHaveBeenCalled()
    expect(hoisted.provision).toHaveBeenCalledTimes(2)

    release(pool())
    await manual
    expect(hoisted.testConnection).toHaveBeenCalledTimes(1)
    expect(hoisted.provision).toHaveBeenCalledTimes(3)
    // Vence a configuração corrigida (a última a ser instalada), e o repositório
    // da automática foi fechado na troca.
    expect(lifecycle.repository()).toBe(hoisted.repositories[2])
    expect(hoisted.repositories[1].closed).toBe(true)
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })

  it('close() no meio da recuperação de uma ativação não reinstala repositório nem deixa pool vivo', async () => {
    Object.assign(hoisted.data, { transitionState: 'activating-postgres', transitionId: 't-0' })
    // Na abertura o banco não responde: offline com a transição ainda durável.
    hoisted.provision.mockRejectedValueOnce(offlineError())
    const lifecycle = await initialized('postgres-offline')

    let releaseSnapshot!: () => void
    hoisted.snapshotGate = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    const provisioned = pool()
    hoisted.provision.mockResolvedValueOnce(provisioned)
    hoisted.committed.mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.repositories).toHaveLength(1)

    await lifecycle.close()
    releaseSnapshot()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(hoisted.repositories[0].closed).toBe(true)
    expect(() => lifecycle.repository()).toThrow(StorageError)
    expect(lifecycle.status().state).toBe('postgres-offline')
  })

  // Ramo initializeSqlite do retryNow: a ativação não foi commitada, a transição é
  // abortada e o SQLite volta. close() no meio não pode religar o SQLite.
  async function offlineWithUncommittedActivation() {
    Object.assign(hoisted.data, { transitionState: 'activating-postgres', transitionId: 't-0' })
    hoisted.provision.mockRejectedValueOnce(offlineError())
    const lifecycle = await initialized('postgres-offline')
    const states: string[] = []
    lifecycle.subscribe((status) => states.push(status.state))
    const provisioned = pool()
    hoisted.provision.mockResolvedValueOnce(provisioned)
    hoisted.committed.mockResolvedValueOnce(false)
    return { lifecycle, states, provisioned }
  }

  it('close() durante o abortTransition da ativação não commitada: não abre SQLite nem publica sqlite-ready', async () => {
    let releaseAbort!: () => void
    hoisted.abortGate = new Promise<void>((resolve) => (releaseAbort = resolve))
    const { lifecycle, states, provisioned } = await offlineWithUncommittedActivation()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(provisioned.pool.end).toHaveBeenCalledTimes(1)

    await lifecycle.close()
    releaseAbort()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(hoisted.sqlites).toHaveLength(0)
    expect(() => lifecycle.repository()).toThrow(StorageError)
    expect(states).not.toContain('sqlite-ready')
    expect(states).toEqual([])
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
  })

  it('close() durante o initialize do SQLite: fecha o SqliteRepository candidato e não publica sqlite-ready', async () => {
    let releaseSqlite!: () => void
    hoisted.sqliteGate = new Promise<void>((resolve) => (releaseSqlite = resolve))
    const { lifecycle, states } = await offlineWithUncommittedActivation()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.sqlites).toHaveLength(1)

    await lifecycle.close()
    const afterClose = states.length
    releaseSqlite()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(hoisted.sqlites[0].closed).toBe(true)
    expect(() => lifecycle.repository()).toThrow(StorageError)
    expect(states).not.toContain('sqlite-ready')
    // Nada é publicado depois do close() (nem "fatal", nem offline de novo).
    expect(states.slice(afterClose)).toEqual([])
    expect(hoisted.provision).toHaveBeenCalledTimes(2)
  })

  it('sem close(), o mesmo ramo instala o SQLite e publica sqlite-ready', async () => {
    const { lifecycle, states } = await offlineWithUncommittedActivation()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(hoisted.sqlites).toHaveLength(1)
    expect(lifecycle.repository()).toBe(hoisted.sqlites[0])
    expect(states.at(-1)).toBe('sqlite-ready')
    await lifecycle.close()
  })

  it('recuperação de ativação que falha na consulta encerra o pool daquela tentativa', async () => {
    Object.assign(hoisted.data, { transitionState: 'activating-postgres', transitionId: 't-0' })
    const provisioned = pool()
    hoisted.provision.mockResolvedValueOnce(provisioned)
    hoisted.committed.mockRejectedValueOnce(offlineError())
    const lifecycle = await initialized('postgres-offline')
    expect(provisioned.pool.end).toHaveBeenCalledTimes(1)
    await lifecycle.close()
  })

  it('queda durante a volta para SQLite: não reinstala o repositório fechado e reconecta quando a transição termina', async () => {
    hoisted.provision.mockResolvedValueOnce(pool())
    const lifecycle = await initialized('postgres-ready')
    lifecycle.updateSqliteLocation({ dir: 'x', dbPath: 'x/db' })
    const source = hoisted.repositories[0]
    hoisted.writeSqlite.mockRejectedValueOnce(new Error('Cannot use a pool after calling end on the pool'))
    const deactivation = lifecycle.deactivatePostgres({
      // A queda chega enquanto a transição espera os agentes.
      waitForIdleAgents: async () => source.onOffline(offlineError()),
      flushRenderer: async () => undefined
    })
    await expect(deactivation).rejects.toThrow()
    expect(source.closed).toBe(true)
    expect(lifecycle.status().state).toBe('postgres-offline')
    expect(() => lifecycle.repository()).toThrow(StorageError)

    hoisted.provision.mockResolvedValueOnce(pool())
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(lifecycle.status().state).toBe('postgres-ready')
    expect(lifecycle.repository()).toBe(hoisted.repositories[1])
    await lifecycle.close()
  })
})
