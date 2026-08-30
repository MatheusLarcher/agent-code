import type { PostgresConnectionDraft, PostgresPublicSettings } from '../../shared/ipc'
import { BootstrapStore, POSTGRES_DATABASE, type SecureStorageAdapter } from './bootstrapStore'
import { configureKvRepository, configureKvRepositoryOffline } from './kvFacade'
import { postgresClientConfig, provisionPostgres, testPostgresConnection } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { hasCommittedActivation, importRepositoryToPostgres, writeRepositoryToSqlite } from './postgresTransfer'
import { SqliteRepository } from './sqliteRepository'
import { backupSqliteForTransition } from './sqliteTransitionBackup'
import {
  StorageError,
  type PersistenceRepository,
  type RepositoryChangeHandler,
  type StorageStatus
} from './types'

export interface SqliteStorageLocation {
  dir: string
  dbPath: string
}

export interface StorageInitialization {
  location: SqliteStorageLocation
  userDataDir: string
  secureStorage: SecureStorageAdapter
  appVersion: string
}

export interface StorageTransitionHooks {
  flushRenderer(): Promise<void>
  waitForIdleAgents(): Promise<void>
}

type StatusHandler = (status: StorageStatus) => void

export class StorageLifecycleService {
  private active: PersistenceRepository | null = null
  private bootstrap: BootstrapStore | null = null
  private location: SqliteStorageLocation | null = null
  private appVersion = 'unknown'
  private installationId = '00000000-0000-4000-8000-000000000000'
  private handlers = new Set<StatusHandler>()
  private changeHandlers = new Set<RepositoryChangeHandler>()
  private repositoryUnsubscribe: (() => void) | null = null
  private transition: Promise<void> | null = null
  private currentStatus: StorageStatus = this.makeStatus('sqlite', 'booting', false)

  status(): StorageStatus {
    return {
      ...this.currentStatus,
      ...(this.currentStatus.error ? { error: { ...this.currentStatus.error } } : {})
    }
  }

  subscribe(handler: StatusHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  subscribeChanges(handler: RepositoryChangeHandler): () => void {
    this.changeHandlers.add(handler)
    return () => this.changeHandlers.delete(handler)
  }

  repository(): PersistenceRepository {
    if (!this.active) throw new StorageError('STORAGE_OFFLINE', 'Persistência autoritativa offline.', true)
    return this.active
  }

  canMutate(): boolean {
    return this.currentStatus.writable && this.active !== null
  }

  async initialize(options: StorageInitialization): Promise<void> {
    this.location = options.location
    this.appVersion = options.appVersion
    this.bootstrap = new BootstrapStore(options.userDataDir, options.secureStorage)
    const data = await this.bootstrap.load()
    this.installationId = data.installationId
    this.setStatus(this.makeStatus(data.backend, 'booting', false, Boolean(data.postgres.encryptedPassword)))

    if (data.transitionState === 'activating-postgres' && data.transitionId) {
      try {
        const recovered = await this.recoverActivation(data.transitionId)
        if (recovered) return
        await this.bootstrap.abortTransition(data.transitionId)
      } catch (cause) {
        // Until PostgreSQL answers, we cannot distinguish a pre-commit crash
        // from a committed import whose bootstrap write was interrupted. Keep
        // the transition durable and never fall back to a possibly stale SQLite.
        this.setOffline(cause)
        return
      }
    } else if (data.transitionState === 'deactivating-postgres' && data.transitionId) {
      await this.bootstrap.abortTransition(data.transitionId)
    }

    const refreshed = await this.bootstrap.load()
    if (refreshed.backend === 'postgres') {
      await this.openSelectedPostgres().catch((error) => this.setOffline(error))
      return
    }
    await this.initializeSqlite(options.location)
  }

  async initializeSqlite(location: SqliteStorageLocation): Promise<void> {
    this.location = location
    this.setStatus(this.makeStatus('sqlite', 'booting', false))
    const next = new SqliteRepository(location.dir, location.dbPath, this.installationId)
    try {
      await next.initialize()
      await this.swapRepository(next)
      this.setStatus(this.makeStatus('sqlite', 'sqlite-ready', true))
    } catch (cause) {
      await next.close().catch(() => undefined)
      const error = this.storageError(cause, 'Não foi possível inicializar o SQLite.')
      configureKvRepositoryOffline()
      this.setStatus(this.makeStatus('sqlite', 'fatal', false, false, error))
      throw error
    }
  }

  async postgresSettings(): Promise<PostgresPublicSettings> {
    return this.requireBootstrap().publicSettings()
  }

  updateSqliteLocation(location: SqliteStorageLocation): void {
    this.location = location
  }

  async testPostgres(raw: PostgresConnectionDraft): Promise<void> {
    const previous = this.status()
    this.setStatus({ ...previous, state: 'testing-postgres', error: undefined })
    try {
      await testPostgresConnection(await this.resolveDraft(raw))
    } finally {
      this.setStatus(previous)
    }
  }

  async activatePostgres(raw: PostgresConnectionDraft, hooks: StorageTransitionHooks): Promise<void> {
    if (this.transition) throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição em andamento.')
    const work = this.activate(raw, hooks)
    this.transition = work
    try {
      await work
    } finally {
      if (this.transition === work) this.transition = null
    }
  }

  async deactivatePostgres(hooks: StorageTransitionHooks): Promise<void> {
    if (this.transition) throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição em andamento.')
    const work = this.deactivate(hooks)
    this.transition = work
    try {
      await work
    } finally {
      if (this.transition === work) this.transition = null
    }
  }

  async retryPostgres(raw?: PostgresConnectionDraft): Promise<void> {
    const data = await this.requireBootstrap().load()
    if (raw) {
      const draft = await this.resolveDraft(raw)
      await testPostgresConnection(draft)
      await this.requireBootstrap().saveConnection(raw)
    }
    if (data.transitionState === 'activating-postgres' && data.transitionId) {
      try {
        if (await this.recoverActivation(data.transitionId)) return
        await this.requireBootstrap().abortTransition(data.transitionId)
        if (!this.location) throw new StorageError('STORAGE_OFFLINE', 'A origem SQLite não está disponível.')
        await this.initializeSqlite(this.location)
        return
      } catch (cause) {
        this.setOffline(cause)
        throw this.storageError(cause, 'Não foi possível recuperar a ativação PostgreSQL.', true)
      }
    }
    if (data.backend !== 'postgres') throw new StorageError('STORAGE_OFFLINE', 'PostgreSQL não está selecionado.')
    await this.openSelectedPostgres()
  }

  async clearPostgresPassword(): Promise<void> {
    await this.requireBootstrap().clearPassword()
  }

  async close(): Promise<void> {
    configureKvRepositoryOffline()
    this.repositoryUnsubscribe?.()
    this.repositoryUnsubscribe = null
    const current = this.active
    this.active = null
    await current?.close()
  }

  private async activate(raw: PostgresConnectionDraft, hooks: StorageTransitionHooks): Promise<void> {
    if (this.currentStatus.backend !== 'sqlite' || !this.active) {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'A ativação exige SQLite pronto.')
    }
    const bootstrap = this.requireBootstrap()
    const source = this.active
    const draft = await this.resolveDraft(raw)
    await testPostgresConnection(draft)
    await bootstrap.saveConnection(raw)
    const transitionId = await bootstrap.beginTransition('activating-postgres')
    // The current repository remains writable only for the renderer's explicit
    // durability flush. Main-process guards still block new agents/config/cache.
    this.setStatus(this.makeStatus('sqlite', 'activating-postgres', true, true))
    let target: PostgresRepository | null = null
    let provisioned: Awaited<ReturnType<typeof provisionPostgres>> | null = null
    let confirmed = false
    try {
      this.setTransitionStep('Aguardando os turnos ativos chegarem a um ponto seguro')
      await hooks.waitForIdleAgents()
      this.setTransitionStep('Sincronizando gravações pendentes da interface')
      await hooks.flushRenderer()
      this.setTransitionStep('Criando backup e manifest das fontes SQLite')
      if (!this.location) throw new StorageError('STORAGE_OFFLINE', 'A origem SQLite não está disponível.')
      await backupSqliteForTransition(this.location.dir, this.location.dbPath, transitionId)
      this.setTransitionStep('Criando o banco agent-code e aplicando migrations')
      provisioned = await provisionPostgres(draft, this.installationId, this.appVersion)
      this.setTransitionStep('Importando e verificando o snapshot SQLite')
      await importRepositoryToPostgres(provisioned.pool, source, this.installationId, transitionId)
      target = this.createPostgresRepository(provisioned.pool, draft)
      await target.initialize()
      this.setTransitionStep('Validando a releitura pelo PostgreSQL')
      await target.loadSnapshot()
      this.setTransitionStep('Confirmando o PostgreSQL como backend autoritativo')
      await bootstrap.confirmBackend('postgres', transitionId)
      confirmed = true
      this.bindRepository(target)
      this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, true))
      await source.close().catch((error) => this.logTransitionFailure('close-sqlite-after-activation', error))
    } catch (cause) {
      this.logTransitionFailure('activate-postgres', cause)
      if (confirmed && target) {
        this.bindRepository(target)
        this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, true))
        await source.close().catch(() => undefined)
        return
      }
      await target?.close().catch(() => undefined)
      if (!target) await provisioned?.pool.end().catch(() => undefined)
      await bootstrap.abortTransition(transitionId).catch(() => undefined)
      this.bindRepository(source)
      const saved = await bootstrap.load()
      this.setStatus(this.makeStatus('sqlite', 'sqlite-ready', true, Boolean(saved.postgres.encryptedPassword)))
      throw this.storageError(cause, 'Não foi possível ativar o PostgreSQL.')
    }
  }

  private async deactivate(hooks: StorageTransitionHooks): Promise<void> {
    if (this.currentStatus.backend !== 'postgres' || !this.active || !this.location) {
      throw new StorageError('STORAGE_OFFLINE', 'A desativação exige PostgreSQL online.')
    }
    const bootstrap = this.requireBootstrap()
    const source = this.active
    const transitionId = await bootstrap.beginTransition('deactivating-postgres')
    this.setStatus(this.makeStatus('postgres', 'deactivating-postgres', true, true))
    let target: SqliteRepository | null = null
    let confirmed = false
    try {
      this.setTransitionStep('Aguardando os turnos ativos chegarem a um ponto seguro')
      await hooks.waitForIdleAgents()
      this.setTransitionStep('Sincronizando gravações pendentes da interface')
      await hooks.flushRenderer()
      this.setTransitionStep('Exportando e verificando o snapshot PostgreSQL')
      await writeRepositoryToSqlite(source, this.location.dbPath)
      this.setTransitionStep('Validando a releitura pelo SQLite')
      target = new SqliteRepository(this.location.dir, this.location.dbPath, this.installationId)
      await target.initialize()
      await target.loadSnapshot()
      this.setTransitionStep('Confirmando o SQLite como backend autoritativo')
      await bootstrap.confirmBackend('sqlite', transitionId)
      confirmed = true
      this.bindRepository(target)
      this.setStatus(this.makeStatus('sqlite', 'sqlite-ready', true, true))
      await source.close().catch((error) => this.logTransitionFailure('close-postgres-after-deactivation', error))
    } catch (cause) {
      this.logTransitionFailure('deactivate-postgres', cause)
      if (confirmed && target) {
        this.bindRepository(target)
        this.setStatus(this.makeStatus('sqlite', 'sqlite-ready', true, true))
        await source.close().catch(() => undefined)
        return
      }
      await target?.close().catch(() => undefined)
      await bootstrap.abortTransition(transitionId).catch(() => undefined)
      this.bindRepository(source)
      this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, true))
      throw this.storageError(cause, 'Não foi possível migrar de volta para SQLite.')
    }
  }

  private async openSelectedPostgres(): Promise<void> {
    const draft = await this.requireBootstrap().connection()
    const provisioned = await provisionPostgres(draft, this.installationId, this.appVersion)
    const next = this.createPostgresRepository(provisioned.pool, draft)
    try {
      await next.initialize()
      await next.loadSnapshot()
      await this.swapRepository(next)
      this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, Boolean(draft.password)))
    } catch (error) {
      await next.close().catch(() => provisioned.pool.end().catch(() => undefined))
      throw error
    }
  }

  private async recoverActivation(transitionId: string): Promise<boolean> {
    const bootstrap = this.requireBootstrap()
    const draft = await bootstrap.connection()
    const provisioned = await provisionPostgres(draft, this.installationId, this.appVersion)
    if (!(await hasCommittedActivation(provisioned.pool, transitionId))) {
      await provisioned.pool.end()
      return false
    }
    const next = this.createPostgresRepository(provisioned.pool, draft)
    await next.initialize()
    await next.loadSnapshot()
    await bootstrap.confirmBackend('postgres', transitionId)
    await this.swapRepository(next)
    this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, Boolean(draft.password)))
    return true
  }

  private async resolveDraft(raw: PostgresConnectionDraft): Promise<PostgresConnectionDraft> {
    return this.requireBootstrap().connection(raw)
  }

  private requireBootstrap(): BootstrapStore {
    if (!this.bootstrap) throw new StorageError('STORAGE_OFFLINE', 'Bootstrap ainda não inicializado.')
    return this.bootstrap
  }

  private async swapRepository(next: PersistenceRepository): Promise<void> {
    const previous = this.active
    this.bindRepository(next)
    if (previous && previous !== next) {
      await previous.close().catch((error) => this.logTransitionFailure('close-replaced-repository', error))
    }
  }

  private createPostgresRepository(
    pool: Awaited<ReturnType<typeof provisionPostgres>>['pool'],
    draft: PostgresConnectionDraft
  ): PostgresRepository {
    let repository: PostgresRepository
    repository = new PostgresRepository(
      pool,
      postgresClientConfig(draft, POSTGRES_DATABASE),
      this.installationId,
      this.appVersion,
      (error) => {
        // A listener belonging to a candidate or already-replaced repository
        // cannot take the current authoritative backend offline.
        if (this.active === repository) this.setOffline(error)
      }
    )
    return repository
  }

  private bindRepository(next: PersistenceRepository): void {
    this.repositoryUnsubscribe?.()
    this.active = next
    configureKvRepository(next)
    this.repositoryUnsubscribe = next.subscribe((changes) => {
      for (const handler of this.changeHandlers) handler(changes)
    })
  }

  private setOffline(cause: unknown): void {
    const error = this.storageError(cause, 'PostgreSQL indisponível.', true)
    configureKvRepositoryOffline()
    this.repositoryUnsubscribe?.()
    this.repositoryUnsubscribe = null
    const current = this.active
    this.active = null
    void current?.close().catch(() => undefined)
    this.setStatus(this.makeStatus('postgres', 'postgres-offline', false, this.currentStatus.hasPassword, error))
  }

  private storageError(cause: unknown, fallback: string, retryable = false): StorageError {
    return cause instanceof StorageError ? cause : new StorageError('STORAGE_OFFLINE', fallback, retryable, { cause })
  }

  private logTransitionFailure(phase: string, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const code = typeof (cause as { code?: unknown })?.code === 'string'
      ? (cause as { code: string }).code
      : undefined
    const message = error.message
      .replace(/password=[^\s]+/gi, 'password=[redacted]')
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
      .slice(0, 1_000)
    console.error('[storage-transition]', JSON.stringify({ phase, name: error.name, code, message }))
  }

  private makeStatus(
    backend: 'sqlite' | 'postgres',
    state: StorageStatus['state'],
    writable: boolean,
    hasPassword = false,
    error?: StorageError
  ): StorageStatus {
    return {
      backend,
      state,
      writable,
      installationId: this.installationId,
      targetDatabase: POSTGRES_DATABASE,
      hasPassword,
      ...(error ? { error: { code: error.code, message: error.message, retryable: error.retryable } } : {})
    }
  }

  private setStatus(status: StorageStatus): void {
    this.currentStatus = status
    const copy = this.status()
    for (const handler of this.handlers) {
      try {
        handler(copy)
      } catch {
        // Status observers are not part of the storage commit boundary.
      }
    }
  }

  private setTransitionStep(transitionStep: string): void {
    this.setStatus({ ...this.currentStatus, transitionStep })
  }
}

export const storageLifecycle = new StorageLifecycleService()
