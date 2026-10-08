// @vitest-environment node
// O PostgreSQL local no ciclo de vida: abrir pelo servidor embutido, importar o
// SQLite na atualização (sem publicar o SQLite antes) e cair no SQLite intacto se
// a importação falhar.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  provision: vi.fn(),
  importToPostgres: vi.fn(),
  backup: vi.fn(),
  data: {
    installationId: 'install-1',
    backend: 'sqlite' as 'postgres' | 'sqlite',
    postgresTarget: 'local' as 'local' | 'cloud',
    pendingLocalImport: true,
    transitionState: 'idle' as string,
    transitionId: null as string | null,
    postgres: { encryptedPassword: '' }
  },
  aborted: [] as string[],
  sqlites: [] as Array<{ closed: boolean; initialized: boolean }>,
  repositories: [] as Array<{ closed: boolean }>
}))

vi.mock('./kvFacade', () => ({ configureKvRepository: vi.fn(), configureKvRepositoryOffline: vi.fn() }))
vi.mock('../memory/memoryRuntime', () => ({ configureMemoryRuntime: vi.fn() }))
vi.mock('../tasks/taskRuntime', () => ({ configureTaskRuntime: vi.fn() }))
vi.mock('./sqliteRepository', () => ({
  SqliteRepository: class {
    backend = 'sqlite'
    closed = false
    initialized = false
    constructor() {
      hoisted.sqlites.push(this)
    }
    async initialize() {
      this.initialized = true
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
vi.mock('./sqliteTransitionBackup', () => ({ backupSqliteForTransition: hoisted.backup }))
vi.mock('./postgresTransfer', () => ({
  hasCommittedActivation: vi.fn(),
  importRepositoryToPostgres: hoisted.importToPostgres,
  writeRepositoryToSqlite: vi.fn()
}))
vi.mock('./bootstrapStore', () => ({
  POSTGRES_DATABASE: 'agent-code',
  BootstrapStore: class {
    async load() {
      return { ...hoisted.data }
    }
    async connection() {
      return { host: 'nuvem', port: 6502, user: 'u', password: 'p', tlsMode: 'disable' }
    }
    async beginTransition(state: string, target: 'local' | 'cloud') {
      Object.assign(hoisted.data, { transitionState: state, transitionId: 't-1', postgresTarget: target })
      return 't-1'
    }
    async confirmBackend(backend: 'postgres' | 'sqlite') {
      Object.assign(hoisted.data, { backend, pendingLocalImport: false, transitionState: 'idle', transitionId: null })
    }
    async abortTransition(id: string) {
      hoisted.aborted.push(id)
      Object.assign(hoisted.data, { transitionState: 'idle', transitionId: null })
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
    backend = 'postgres'
    closed = false
    constructor() {
      hoisted.repositories.push(this)
    }
    async initialize() {}
    async verifyReadable() {}
    async loadSnapshot() {}
    subscribe() {
      return () => undefined
    }
    async close() {
      this.closed = true
    }
  }
}))

const { StorageLifecycleService } = await import('./lifecycle')

const localDraft = { host: '127.0.0.1', port: 45432, user: 'agentcode', password: 'local', maintenanceDatabase: 'postgres', tlsMode: 'disable' as const, ca: '' }

async function start(localPostgres?: { ensure: () => Promise<typeof localDraft> }) {
  const lifecycle = new StorageLifecycleService()
  const states: string[] = []
  lifecycle.subscribe((status) => states.push(status.state))
  await lifecycle.initialize({
    location: { dir: 'x', dbPath: 'x/db' },
    userDataDir: 'x',
    secureStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
    appVersion: 'test',
    ...(localPostgres ? { localPostgres: localPostgres as never } : {})
  })
  return { lifecycle, states }
}

describe('StorageLifecycleService: PostgreSQL local', () => {
  beforeEach(() => {
    hoisted.provision.mockReset().mockResolvedValue({ pool: { end: vi.fn(async () => undefined) } })
    hoisted.importToPostgres.mockReset().mockResolvedValue(undefined)
    hoisted.backup.mockReset()
    hoisted.aborted.length = 0
    hoisted.sqlites.length = 0
    hoisted.repositories.length = 0
    Object.assign(hoisted.data, {
      backend: 'sqlite',
      postgresTarget: 'local',
      pendingLocalImport: true,
      transitionState: 'idle',
      transitionId: null
    })
  })

  it('atualização do SQLite: importa para o PostgreSQL local sem publicar o SQLite antes', async () => {
    const ensure = vi.fn(async () => localDraft)
    const { lifecycle, states } = await start({ ensure })
    expect(hoisted.provision).toHaveBeenCalledWith(localDraft, 'install-1', 'test')
    expect(hoisted.backup).toHaveBeenCalledWith('x', 'x/db', 't-1')
    expect(hoisted.importToPostgres).toHaveBeenCalledWith(expect.anything(), hoisted.sqlites[0], 'install-1', 't-1')
    expect(hoisted.data).toMatchObject({ backend: 'postgres', postgresTarget: 'local', pendingLocalImport: false })
    expect(lifecycle.status()).toMatchObject({ backend: 'postgres', state: 'postgres-ready', writable: true })
    expect(lifecycle.repository()).toBe(hoisted.repositories[0])
    expect(states).not.toContain('sqlite-ready')
    // A origem é só lida e fechada: o SQLite continua lá, intacto.
    expect(hoisted.sqlites[0].closed).toBe(true)
    await lifecycle.close()
  })

  it('importação que falha: aborta a transição e abre o SQLite de sempre (tenta de novo na próxima)', async () => {
    const pool = { end: vi.fn(async () => undefined) }
    hoisted.provision.mockResolvedValueOnce({ pool })
    hoisted.importToPostgres.mockRejectedValueOnce(new Error('falhou no meio'))
    const { lifecycle } = await start({ ensure: async () => localDraft })
    expect(hoisted.aborted).toEqual(['t-1'])
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(lifecycle.status()).toMatchObject({ backend: 'sqlite', state: 'sqlite-ready' })
    expect(hoisted.data.pendingLocalImport).toBe(true)
    // A origem da tentativa foi fechada; o SQLite aberto é outra instância.
    expect(hoisted.sqlites[0].closed).toBe(true)
    expect(lifecycle.repository()).toBe(hoisted.sqlites[1])
    await lifecycle.close()
  })

  it('PostgreSQL local escolhido: abre pelo servidor embutido, não pela conexão da nuvem', async () => {
    Object.assign(hoisted.data, { backend: 'postgres', pendingLocalImport: false })
    const ensure = vi.fn(async () => localDraft)
    const { lifecycle } = await start({ ensure })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(hoisted.provision).toHaveBeenCalledWith(localDraft, 'install-1', 'test')
    expect(lifecycle.status().state).toBe('postgres-ready')
    await lifecycle.close()
  })

  it('nuvem ligada: continua na conexão salva, sem tocar no servidor embutido', async () => {
    Object.assign(hoisted.data, { backend: 'postgres', postgresTarget: 'cloud', pendingLocalImport: false })
    const ensure = vi.fn(async () => localDraft)
    const { lifecycle } = await start({ ensure })
    expect(ensure).not.toHaveBeenCalled()
    expect(hoisted.provision).toHaveBeenCalledWith(expect.objectContaining({ host: 'nuvem' }), 'install-1', 'test')
    await lifecycle.close()
  })

  it('servidor local que não sobe: offline com o erro dele (a tela de recuperação mostra o log)', async () => {
    Object.assign(hoisted.data, { backend: 'postgres', pendingLocalImport: false })
    const { StorageError } = await import('./types')
    const ensure = vi.fn(async () => {
      throw new StorageError('LOCAL_POSTGRES_UNAVAILABLE', 'O PostgreSQL local não subiu. Log do PostgreSQL: C:\\x\\postgres.log', true)
    })
    const { lifecycle } = await start({ ensure })
    expect(lifecycle.status()).toMatchObject({
      state: 'postgres-offline',
      error: { code: 'LOCAL_POSTGRES_UNAVAILABLE', message: expect.stringContaining('postgres.log') }
    })
    await lifecycle.close()
  })
})
