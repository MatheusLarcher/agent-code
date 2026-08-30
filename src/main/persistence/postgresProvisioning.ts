import { Client, Pool, type ClientConfig, type PoolConfig } from 'pg'
import { z } from 'zod'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { applyPostgresMigrations } from './postgresMigrations'
import { StorageError } from './types'

const draftSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    user: z.string().trim().min(1).max(128),
    password: z.string().max(10_000),
    maintenanceDatabase: z.string().trim().min(1).max(128),
    tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-full']),
    ca: z.string().max(1_000_000)
  })
  .strict()

type PgPhase = 'connect' | 'maintenance' | 'create' | 'migration' | 'dml'

function sslOptions(draft: PostgresConnectionDraft): ClientConfig['ssl'] {
  if (draft.tlsMode === 'disable') return false
  if (draft.tlsMode === 'verify-full') {
    return { rejectUnauthorized: true, ...(draft.ca.trim() ? { ca: draft.ca } : {}) }
  }
  return { rejectUnauthorized: false }
}

export function validatePostgresDraft(value: unknown): PostgresConnectionDraft {
  const parsed = draftSchema.safeParse(value)
  if (!parsed.success) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Configuração PostgreSQL inválida.', false, {
      cause: parsed.error
    })
  }
  return parsed.data
}

export function postgresClientConfig(
  raw: PostgresConnectionDraft,
  database: string
): ClientConfig & PoolConfig {
  const draft = validatePostgresDraft(raw)
  return {
    host: draft.host,
    port: draft.port,
    user: draft.user,
    password: draft.password,
    database,
    ssl: sslOptions(draft),
    connectionTimeoutMillis: 8_000,
    application_name: 'agent-code'
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { code?: unknown; cause?: { code?: unknown } }
  return typeof candidate.code === 'string'
    ? candidate.code
    : typeof candidate.cause?.code === 'string'
      ? candidate.cause.code
      : ''
}

export function typedPostgresError(error: unknown, phase: PgPhase): StorageError {
  if (error instanceof StorageError) return error
  const code = errorCode(error)
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new StorageError('HOST_UNREACHABLE', 'Host PostgreSQL não encontrado.', true, { cause: error })
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new StorageError('CONNECTION_REFUSED', 'A conexão PostgreSQL foi recusada.', true, { cause: error })
  }
  if (code === 'ETIMEDOUT' || message.includes('timeout') || message.includes('timed out')) {
    return new StorageError('CONNECTION_TIMEOUT', 'A conexão PostgreSQL excedeu o tempo limite.', true, {
      cause: error
    })
  }
  if (code === '28P01' || code === '28000') {
    return new StorageError('AUTHENTICATION_FAILED', 'Usuário ou senha PostgreSQL inválidos.', false, {
      cause: error
    })
  }
  if (
    message.includes('certificate') ||
    message.includes('self-signed') ||
    message.includes('ssl') ||
    message.includes('tls')
  ) {
    return new StorageError('TLS_VERIFICATION_FAILED', 'A validação TLS do PostgreSQL falhou.', false, {
      cause: error
    })
  }
  if (code === '3D000' || phase === 'maintenance') {
    return new StorageError('MAINTENANCE_DB_UNAVAILABLE', 'O maintenance database não está disponível.', false, {
      cause: error
    })
  }
  if (code === '42501' && phase === 'create') {
    return new StorageError(
      'CREATE_DATABASE_DENIED',
      'A role PostgreSQL não possui permissão CREATEDB para criar o banco agent-code.',
      false,
      { cause: error }
    )
  }
  if (phase === 'migration' || phase === 'dml') {
    return new StorageError('DML_FAILED', 'O PostgreSQL rejeitou uma operação de persistência.', false, {
      cause: error
    })
  }
  return new StorageError('STORAGE_OFFLINE', 'Não foi possível acessar o PostgreSQL.', true, { cause: error })
}

export async function testPostgresConnection(raw: PostgresConnectionDraft): Promise<void> {
  const draft = validatePostgresDraft(raw)
  const client = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
  try {
    await client.connect()
    await client.query('SELECT 1')
  } catch (error) {
    throw typedPostgresError(error, 'connect')
  } finally {
    await client.end().catch(() => undefined)
  }
}

export interface ProvisionedPostgres {
  pool: Pool
  createdDatabase: boolean
}

export async function provisionPostgres(
  raw: PostgresConnectionDraft,
  installationId: string,
  appVersion: string
): Promise<ProvisionedPostgres> {
  const draft = validatePostgresDraft(raw)
  const maintenance = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
  let createdDatabase = false
  try {
    await maintenance.connect()
    await maintenance.query('SELECT pg_advisory_lock($1)', [7_420_260_828])
    try {
      const found = await maintenance.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [POSTGRES_DATABASE]
      )
      if (!found.rows[0]?.exists) {
        const role = await maintenance.query<{ can_create: boolean }>(
          'SELECT (rolsuper OR rolcreatedb) AS can_create FROM pg_roles WHERE rolname = current_user'
        )
        if (!role.rows[0]?.can_create) {
          throw new StorageError(
            'CREATE_DATABASE_DENIED',
            'A role PostgreSQL não possui permissão CREATEDB para criar o banco agent-code.'
          )
        }
        try {
          await maintenance.query('CREATE DATABASE "agent-code" ENCODING \'UTF8\' TEMPLATE template0')
          createdDatabase = true
        } catch (error) {
          if (errorCode(error) !== '42P04') throw typedPostgresError(error, 'create')
        }
      }
      const verified = await maintenance.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [POSTGRES_DATABASE]
      )
      if (!verified.rows[0]?.exists) {
        throw new StorageError('MIGRATION_VERIFICATION_FAILED', 'O banco agent-code não foi encontrado após o provisionamento.')
      }
    } finally {
      await maintenance.query('SELECT pg_advisory_unlock($1)', [7_420_260_828]).catch(() => undefined)
    }
  } catch (error) {
    throw typedPostgresError(error, errorCode(error) === '3D000' ? 'maintenance' : 'connect')
  } finally {
    await maintenance.end().catch(() => undefined)
  }

  const pool = new Pool({ ...postgresClientConfig(draft, POSTGRES_DATABASE), max: 10 })
  const client = await pool.connect().catch((error) => {
    throw typedPostgresError(error, 'connect')
  })
  let released = false
  try {
    await applyPostgresMigrations(client, installationId, appVersion)
    await client.query(
      `INSERT INTO installations(installation_id, app_version)
       VALUES($1, $2)
       ON CONFLICT(installation_id) DO UPDATE SET app_version = EXCLUDED.app_version, last_seen_at = clock_timestamp()`,
      [installationId, appVersion]
    )
  } catch (error) {
    client.release(true)
    released = true
    await pool.end().catch(() => undefined)
    throw typedPostgresError(error, 'migration')
  } finally {
    if (!released) client.release()
  }
  return { pool, createdDatabase }
}
