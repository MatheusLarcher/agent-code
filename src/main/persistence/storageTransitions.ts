import type { Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import type { BootstrapStore } from './bootstrapStore'
import type { SqliteStorageLocation, StorageTransitionHooks } from './lifecycle'
import { provisionPostgres, testPostgresConnection } from './postgresProvisioning'
import type { PostgresRepository } from './postgresRepository'
import { importRepositoryToPostgres, writeRepositoryToSqlite } from './postgresTransfer'
import { SqliteRepository } from './sqliteRepository'
import { backupSqliteForTransition } from './sqliteTransitionBackup'
import { logTransitionFailure } from './storageTransitionLog'
import { StorageError, type PersistenceRepository, type StorageStatus } from './types'

/** O que as transições entre backends usam do ciclo de vida (lifecycle.ts). */
export interface TransitionHost {
  readonly installationId: string
  readonly appVersion: string
  status(): StorageStatus
  active(): PersistenceRepository | null
  location(): SqliteStorageLocation | null
  bootstrap(): BootstrapStore
  publish(backend: 'sqlite' | 'postgres', state: StorageStatus['state'], writable: boolean, hasPassword?: boolean): void
  step(transitionStep: string): void
  bind(next: PersistenceRepository): void
  createPostgresRepository(pool: Pool, draft: PostgresConnectionDraft): PostgresRepository
  resolveDraft(raw: PostgresConnectionDraft): Promise<PostgresConnectionDraft>
  /** Sobe o PostgreSQL embutido e devolve a conexão com ele. */
  localDraft(): Promise<PostgresConnectionDraft>
  /** Solta o repositório em uso (pool fechado, leituras recusadas na hora) — a
   *  restauração por cima do banco em uso não disputa trava com o próprio app. */
  detach(): Promise<void>
  /** Reabre o PostgreSQL escolhido no bootstrap e publica "pronto". */
  reopen(): Promise<void>
}

export function toStorageError(cause: unknown, fallback: string, retryable = false): StorageError {
  return cause instanceof StorageError ? cause : new StorageError('STORAGE_OFFLINE', fallback, retryable, { cause })
}

/** SQLite → PostgreSQL da nuvem, pela tela (o app reinicia depois). */
export async function activatePostgres(
  host: TransitionHost,
  raw: PostgresConnectionDraft,
  hooks: StorageTransitionHooks
): Promise<void> {
  const source = host.active()
  if (host.status().backend !== 'sqlite' || !source) {
    throw new StorageError('TRANSITION_IN_PROGRESS', 'A ativação exige SQLite pronto.')
  }
  const bootstrap = host.bootstrap()
  const draft = await host.resolveDraft(raw)
  await testPostgresConnection(draft)
  await bootstrap.saveConnection(raw)
  const transitionId = await bootstrap.beginTransition('activating-postgres', 'cloud')
  // The current repository remains writable only for the renderer's explicit
  // durability flush. Main-process guards still block new agents/config/cache.
  host.publish('sqlite', 'activating-postgres', true, true)
  let target: PostgresRepository | null = null
  let provisioned: Awaited<ReturnType<typeof provisionPostgres>> | null = null
  let confirmed = false
  try {
    host.step('Aguardando os turnos ativos chegarem a um ponto seguro')
    await hooks.waitForIdleAgents()
    host.step('Sincronizando gravações pendentes da interface')
    await hooks.flushRenderer()
    host.step('Criando backup e manifest das fontes SQLite')
    const location = host.location()
    if (!location) throw new StorageError('STORAGE_OFFLINE', 'A origem SQLite não está disponível.')
    await backupSqliteForTransition(location.dir, location.dbPath, transitionId)
    host.step('Criando o banco agent-code e aplicando migrations')
    provisioned = await provisionPostgres(draft, host.installationId, host.appVersion)
    host.step('Importando e verificando o snapshot SQLite')
    await importRepositoryToPostgres(provisioned.pool, source, host.installationId, transitionId)
    target = host.createPostgresRepository(provisioned.pool, draft)
    await target.initialize()
    host.step('Validando a releitura pelo PostgreSQL')
    await target.loadSnapshot()
    host.step('Confirmando o PostgreSQL como backend autoritativo')
    await bootstrap.confirmBackend('postgres', transitionId)
    confirmed = true
    host.bind(target)
    host.publish('postgres', 'postgres-ready', true, true)
    await source.close().catch((error) => logTransitionFailure('close-sqlite-after-activation', error))
  } catch (cause) {
    logTransitionFailure('activate-postgres', cause)
    if (confirmed && target) {
      host.bind(target)
      host.publish('postgres', 'postgres-ready', true, true)
      await source.close().catch(() => undefined)
      return
    }
    await target?.close().catch(() => undefined)
    if (!target) await provisioned?.pool.end().catch(() => undefined)
    await bootstrap.abortTransition(transitionId).catch(() => undefined)
    host.bind(source)
    const saved = await bootstrap.load()
    host.publish('sqlite', 'sqlite-ready', true, Boolean(saved.postgres.encryptedPassword))
    throw toStorageError(cause, 'Não foi possível ativar o PostgreSQL.')
  }
}

/** PostgreSQL → SQLite, pela tela (o app reinicia depois). */
export async function deactivatePostgres(host: TransitionHost, hooks: StorageTransitionHooks): Promise<void> {
  const source = host.active()
  const location = host.location()
  if (host.status().backend !== 'postgres' || !source || !location) {
    throw new StorageError('STORAGE_OFFLINE', 'A desativação exige PostgreSQL online.')
  }
  const bootstrap = host.bootstrap()
  const transitionId = await bootstrap.beginTransition('deactivating-postgres')
  host.publish('postgres', 'deactivating-postgres', true, true)
  let target: SqliteRepository | null = null
  let confirmed = false
  try {
    host.step('Aguardando os turnos ativos chegarem a um ponto seguro')
    await hooks.waitForIdleAgents()
    host.step('Sincronizando gravações pendentes da interface')
    await hooks.flushRenderer()
    host.step('Exportando e verificando o snapshot PostgreSQL')
    await writeRepositoryToSqlite(source, location.dbPath)
    host.step('Validando a releitura pelo SQLite')
    target = new SqliteRepository(location.dir, location.dbPath, host.installationId)
    await target.initialize()
    await target.loadSnapshot()
    host.step('Confirmando o SQLite como backend autoritativo')
    await bootstrap.confirmBackend('sqlite', transitionId)
    confirmed = true
    host.bind(target)
    host.publish('sqlite', 'sqlite-ready', true, true)
    await source.close().catch((error) => logTransitionFailure('close-postgres-after-deactivation', error))
  } catch (cause) {
    logTransitionFailure('deactivate-postgres', cause)
    if (confirmed && target) {
      host.bind(target)
      host.publish('sqlite', 'sqlite-ready', true, true)
      await source.close().catch(() => undefined)
      return
    }
    await target?.close().catch(() => undefined)
    await bootstrap.abortTransition(transitionId).catch(() => undefined)
    // Queda no meio: setOffline já fechou `source` — fica offline (runTransition reconecta).
    if (host.active() === source) {
      host.bind(source)
      host.publish('postgres', 'postgres-ready', true, true)
    }
    throw toStorageError(cause, 'Não foi possível migrar de volta para SQLite.')
  }
}

/**
 * Instalação nova ou que vinha do SQLite: passa tudo para o PostgreSQL local e o
 * confirma no bootstrap. Mesma trilha da ativação pela tela (backup, importação
 * verificada, releitura, confirmação), mas na abertura, antes de qualquer backend
 * ser publicado — sem agente para parar nem interface para esperar. O SQLite de
 * origem não é alterado. Devolve o repositório pronto para ser instalado.
 */
export async function importSqliteToLocal(host: TransitionHost, location: SqliteStorageLocation): Promise<PostgresRepository> {
  const bootstrap = host.bootstrap()
  const source = new SqliteRepository(location.dir, location.dbPath, host.installationId)
  let transitionId: string | null = null
  let pool: Pool | null = null
  let target: PostgresRepository | null = null
  try {
    await source.initialize()
    const draft = await host.localDraft()
    transitionId = await bootstrap.beginTransition('activating-postgres', 'local')
    await backupSqliteForTransition(location.dir, location.dbPath, transitionId)
    pool = (await provisionPostgres(draft, host.installationId, host.appVersion)).pool
    await importRepositoryToPostgres(pool, source, host.installationId, transitionId)
    target = host.createPostgresRepository(pool, draft)
    await target.initialize()
    await target.loadSnapshot()
    await bootstrap.confirmBackend('postgres', transitionId)
    return target
  } catch (cause) {
    if (target) await target.close().catch(() => undefined)
    else await pool?.end().catch(() => undefined)
    if (transitionId) await bootstrap.abortTransition(transitionId).catch(() => undefined)
    throw cause
  } finally {
    await source.close().catch(() => undefined)
  }
}
