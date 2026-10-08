import type { PostgresConnectionDraft, PostgresPublicSettings } from '../../shared/ipc'
import { BootstrapStore, POSTGRES_DATABASE, type PostgresTarget, type SecureStorageAdapter } from './bootstrapStore'
import { configureKvRepository, configureKvRepositoryOffline } from './kvFacade'
import { configureMemoryRuntime } from '../memory/memoryRuntime'
import { configureTaskRuntime } from '../tasks/taskRuntime'
import type { LocalPostgres } from './localPostgres'
import { postgresClientConfig, provisionPostgres, testPostgresConnection } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { hasCommittedActivation } from './postgresTransfer'
import { SqliteRepository } from './sqliteRepository'
import { StorageReconnector } from './storageReconnect'
import { logTransitionFailure } from './storageTransitionLog'
import {
  activatePostgres,
  deactivatePostgres,
  importSqliteToLocal,
  toStorageError,
  type TransitionHost
} from './storageTransitions'
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
  /** O PostgreSQL embutido (localPostgres.ts); sem ele, o alvo local fica indisponível. */
  localPostgres?: Pick<LocalPostgres, 'ensure'>
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
  private local: StorageInitialization['localPostgres'] | null = null
  private appVersion = 'unknown'
  private installationId = '00000000-0000-4000-8000-000000000000'
  private handlers = new Set<StatusHandler>()
  private changeHandlers = new Set<RepositoryChangeHandler>()
  private repositoryUnsubscribe: (() => void) | null = null
  private transition: Promise<void> | null = null
  private currentStatus: StorageStatus = this.makeStatus('sqlite', 'booting', false)
  private closed = false
  private readonly reconnector = new StorageReconnector({
    attempt: () => this.retryNow(),
    shouldRun: () => !this.closed && !this.transition && this.currentStatus.state === 'postgres-offline',
    isRetryable: (error) => this.storageError(error, 'PostgreSQL indisponível.', true).retryable,
    onGiveUp: (error) => {
      if (this.closed || this.currentStatus.state !== 'postgres-offline') return
      const typed = this.storageError(error, 'PostgreSQL indisponível.', true)
      this.setStatus(this.makeStatus('postgres', 'postgres-offline', false, this.currentStatus.hasPassword, typed))
    }
  })

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
    this.closed = false
    this.location = options.location
    this.appVersion = options.appVersion
    this.local = options.localPostgres ?? null
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
    if (refreshed.pendingLocalImport && (await this.importToLocal(options.location))) return
    await this.initializeSqlite(options.location)
  }

  /** Instalação nova ou que vinha do SQLite: tudo para o PostgreSQL local, com a
   *  tela ainda em "Abrindo…". Falhou? Abre o SQLite de sempre, intacto, e a
   *  importação é tentada de novo na próxima abertura. */
  private async importToLocal(location: SqliteStorageLocation): Promise<boolean> {
    let imported: PostgresRepository
    try {
      imported = await importSqliteToLocal(this.transitionHost(), location)
    } catch (cause) {
      logTransitionFailure('import-sqlite-to-local-postgres', cause)
      return false
    }
    if (this.closed) {
      await imported.close().catch(() => undefined)
      throw this.closedError()
    }
    await this.swapRepository(imported)
    this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, true))
    return true
  }

  async initializeSqlite(location: SqliteStorageLocation): Promise<void> {
    this.location = location
    this.setStatus(this.makeStatus('sqlite', 'booting', false))
    const next = new SqliteRepository(location.dir, location.dbPath, this.installationId)
    try {
      await next.initialize()
      // close() durante o initialize (retryNow de uma ativação não commitada):
      // não religa o SQLite nem publica sqlite-ready depois do encerramento.
      if (this.closed) throw this.closedError()
      await this.swapRepository(next)
      this.setStatus(this.makeStatus('sqlite', 'sqlite-ready', true))
    } catch (cause) {
      await next.close().catch(() => undefined)
      if (this.closed) throw this.closedError()
      const error = this.storageError(cause, 'Não foi possível inicializar o SQLite.')
      configureKvRepositoryOffline()
      configureMemoryRuntime(null)
      configureTaskRuntime(null)
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
    await this.runTransition(() => activatePostgres(this.transitionHost(), raw, hooks))
  }

  async deactivatePostgres(hooks: StorageTransitionHooks): Promise<void> {
    await this.runTransition(() => deactivatePostgres(this.transitionHost(), hooks))
  }

  /** Restauração e troca local ↔ nuvem (backup/storageSwitch.ts), com a trava das
   *  transições: uma de cada vez e nenhuma reconexão automática no meio. */
  async exclusive<T>(work: (host: TransitionHost) => Promise<T>): Promise<T> {
    let result: T | undefined
    await this.runTransition(async () => {
      result = await work(this.transitionHost())
    })
    return result as T
  }

  /** O lado em uso e a conexão dele (backup diário); null fora do PostgreSQL pronto. */
  async activeSide(): Promise<{ target: PostgresTarget; draft: PostgresConnectionDraft } | null> {
    if (this.transition || this.currentStatus.backend !== 'postgres' || this.currentStatus.state !== 'postgres-ready') return null
    const target = (await this.requireBootstrap().load()).postgresTarget
    return { target, draft: await this.selectedDraft() }
  }

  /** Queda durante a transição não agenda (`shouldRun`): a reconexão começa aqui. */
  private async runTransition(start: () => Promise<void>): Promise<void> {
    if (this.transition) throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição em andamento.')
    const work = start()
    this.transition = work
    try {
      await work
    } finally {
      if (this.transition === work) this.transition = null
      this.reconnector.schedule()
    }
  }

  /** "Tentar novamente" (botão ou rede de volta). Sem rascunho divide a tentativa
   *  automática (banco já de pé: no-op). Com rascunho ("Corrigir configuração")
   *  zera o backoff e espera a automática em curso: nunca dois pools em paralelo. */
  async retryPostgres(raw?: PostgresConnectionDraft): Promise<void> {
    if (!raw && this.currentStatus.state === 'postgres-ready') return
    if (!raw) return this.reconnector.now()
    return this.reconnector.nowWith(() => this.retryNow(raw))
  }

  /** O SO avisou que voltou da suspensão/desbloqueio: se o banco caiu enquanto
   *  isso, tenta na hora em vez de esperar o próximo passo do backoff. */
  resumeReconnect(): void {
    if (this.closed || this.transition || this.currentStatus.state !== 'postgres-offline') return
    void this.reconnector.now().catch(() => undefined)
  }

  private async retryNow(raw?: PostgresConnectionDraft): Promise<void> {
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
        if (this.closed) throw this.closedError()
        if (!this.location) throw new StorageError('STORAGE_OFFLINE', 'A origem SQLite não está disponível.')
        await this.initializeSqlite(this.location)
        return
      } catch (cause) {
        if (!this.closed) this.setOffline(cause)
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
    this.closed = true
    this.reconnector.cancel()
    configureKvRepositoryOffline()
    configureMemoryRuntime(null)
    configureTaskRuntime(null)
    this.repositoryUnsubscribe?.()
    this.repositoryUnsubscribe = null
    const current = this.active
    this.active = null
    await current?.close()
  }

  /** As transições entre backends (storageTransitions.ts) operam por aqui. */
  private transitionHost(): TransitionHost {
    return {
      installationId: this.installationId,
      appVersion: this.appVersion,
      status: () => this.status(),
      active: () => this.active,
      location: () => this.location,
      bootstrap: () => this.requireBootstrap(),
      publish: (backend, state, writable, hasPassword) => this.setStatus(this.makeStatus(backend, state, writable, hasPassword)),
      step: (transitionStep) => this.setTransitionStep(transitionStep),
      bind: (next) => this.bindRepository(next),
      createPostgresRepository: (pool, draft) => this.createPostgresRepository(pool, draft),
      resolveDraft: (raw) => this.resolveDraft(raw),
      localDraft: () => this.localDraft(),
      detach: () => this.detach(),
      reopen: () =>
        this.openSelectedPostgres().catch((error: unknown) => {
          if (!this.closed) this.setOffline(error)
          throw error
        })
    }
  }

  private async detach(): Promise<void> {
    configureKvRepositoryOffline()
    configureMemoryRuntime(null)
    configureTaskRuntime(null)
    this.repositoryUnsubscribe?.()
    this.repositoryUnsubscribe = null
    const current = this.active
    this.active = null
    await current?.close().catch((error) => logTransitionFailure('close-detached-repository', error))
  }

  /** A conexão do PostgreSQL escolhido no bootstrap: o embutido (sobe o servidor
   *  se preciso) ou o da nuvem. */
  private async selectedDraft(): Promise<PostgresConnectionDraft> {
    const bootstrap = this.requireBootstrap()
    return (await bootstrap.load()).postgresTarget === 'local' ? this.localDraft() : bootstrap.connection()
  }

  private async localDraft(): Promise<PostgresConnectionDraft> {
    if (!this.local) throw new StorageError('LOCAL_POSTGRES_UNAVAILABLE', 'O PostgreSQL local não está disponível nesta execução.')
    return this.local.ensure(this.requireBootstrap())
  }

  private async openSelectedPostgres(): Promise<void> {
    const draft = await this.selectedDraft()
    const provisioned = await provisionPostgres(draft, this.installationId, this.appVersion)
    const next = this.createPostgresRepository(provisioned.pool, draft)
    try {
      await next.initialize()
      // Sonda limitada, não `loadSnapshot()`: este backend JÁ está confirmado no
      // bootstrap, então não há importação para verificar — só "dá para ler?".
      // A releitura completa continua nas transições (activate/deactivate/recover).
      await next.verifyReadable()
      // Uma reconexão automática que termina com o app já fechando não pode
      // reinstalar um repositório (e um pool vivo) depois do close().
      if (this.closed) throw this.closedError()
      await this.swapRepository(next)
      this.setStatus(this.makeStatus('postgres', 'postgres-ready', true, Boolean(draft.password)))
    } catch (error) {
      await next.close().catch(() => provisioned.pool.end().catch(() => undefined))
      throw error
    }
  }

  private async recoverActivation(transitionId: string): Promise<boolean> {
    const bootstrap = this.requireBootstrap()
    // Confere no PostgreSQL para onde a ativação ia (o alvo é gravado ao começar).
    const draft = await this.selectedDraft()
    const provisioned = await provisionPostgres(draft, this.installationId, this.appVersion)
    // Cada tentativa automática passa aqui: pool que não vira repositório é encerrado.
    let next: PostgresRepository | null = null
    try {
      if (!(await hasCommittedActivation(provisioned.pool, transitionId))) {
        await provisioned.pool.end()
        return false
      }
      next = this.createPostgresRepository(provisioned.pool, draft)
      await next.initialize()
      await next.loadSnapshot()
      await bootstrap.confirmBackend('postgres', transitionId)
      // Como em openSelectedPostgres: app fechando não reinstala repositório.
      if (this.closed) throw this.closedError()
      await this.swapRepository(next)
    } catch (error) {
      await (next?.close() ?? provisioned.pool.end()).catch(() => provisioned.pool.end().catch(() => undefined))
      throw error
    }
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
      await previous.close().catch((error) => logTransitionFailure('close-replaced-repository', error))
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
    // The memory service writes through the authoritative repository, so it has
    // to follow every backend swap instead of holding a replaced one.
    configureMemoryRuntime(next)
    // O registro de tarefas segue a mesma regra: escreve pelo repositório
    // autoritativo e acompanha toda troca de backend.
    configureTaskRuntime(next)
    this.repositoryUnsubscribe = next.subscribe((changes) => {
      for (const handler of this.changeHandlers) handler(changes)
    })
  }

  private setOffline(cause: unknown): void {
    const error = this.storageError(cause, 'PostgreSQL indisponível.', true)
    configureKvRepositoryOffline()
    configureMemoryRuntime(null)
    configureTaskRuntime(null)
    this.repositoryUnsubscribe?.()
    this.repositoryUnsubscribe = null
    const current = this.active
    this.active = null
    void current?.close().catch(() => undefined)
    this.setStatus(this.makeStatus('postgres', 'postgres-offline', false, this.currentStatus.hasPassword, error))
    if (error.retryable) this.reconnector.schedule()
  }

  private storageError(cause: unknown, fallback: string, retryable = false): StorageError {
    return toStorageError(cause, fallback, retryable)
  }

  /** O app fechou no meio de uma tentativa: nada é reinstalado nem publicado. */
  private closedError(): StorageError {
    return new StorageError('STORAGE_OFFLINE', 'Persistência encerrada.', false)
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
