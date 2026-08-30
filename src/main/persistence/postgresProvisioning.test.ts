import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { POSTGRES_MIGRATIONS } from './postgresMigrations'
import { provisionPostgres, typedPostgresError } from './postgresProvisioning'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const admin: PostgresConnectionDraft = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  user: 'postgres',
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

async function maintenance(): Promise<Client> {
  const client = new Client({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database: admin.maintenanceDatabase
  })
  await client.connect()
  return client
}

async function dropTarget(): Promise<void> {
  const client = await maintenance()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

describe('erros PostgreSQL tipados', () => {
  it('distingue DNS, recusa, timeout, autenticação e TLS sem ecoar detalhes', () => {
    expect(typedPostgresError({ code: 'ENOTFOUND' }, 'connect').code).toBe('HOST_UNREACHABLE')
    expect(typedPostgresError({ code: 'ECONNREFUSED' }, 'connect').code).toBe('CONNECTION_REFUSED')
    expect(typedPostgresError({ code: 'ETIMEDOUT' }, 'connect').code).toBe('CONNECTION_TIMEOUT')
    expect(typedPostgresError({ code: '28P01' }, 'connect').code).toBe('AUTHENTICATION_FAILED')
    expect(typedPostgresError(new Error('self-signed certificate'), 'connect').code).toBe(
      'TLS_VERIFICATION_FAILED'
    )
  })
})

describe.runIf(integration).sequential('provisionamento PostgreSQL 16', () => {
  beforeEach(dropTarget)
  afterAll(async () => {
    await dropTarget()
    const client = await maintenance()
    try {
      await client.query('DROP ROLE IF EXISTS agent_code_no_createdb')
    } finally {
      await client.end()
    }
  })

  it('cria agent-code, aplica migrations e reaplica como no-op', async () => {
    const first = await provisionPostgres(admin, randomUUID(), 'test')
    expect(first.createdDatabase).toBe(true)
    await first.pool.end()
    const second = await provisionPostgres(admin, randomUUID(), 'test')
    expect(second.createdDatabase).toBe(false)
    const migrations = await second.pool.query('SELECT version FROM schema_migrations ORDER BY version')
    expect(migrations.rows.map((row) => Number(row.version))).toEqual(POSTGRES_MIGRATIONS.map((entry) => entry.version))
    for (const table of [
      'global_kv',
      'device_kv',
      'projects',
      'project_devices',
      'conversations',
      'conversation_device_state',
      'sdk_sessions',
      'sdk_session_entries',
      'conversation_leases',
      'change_log',
      'migration_runs',
      'migration_items'
    ]) {
      const found = await second.pool.query('SELECT to_regclass($1) AS table_name', [table])
      expect(found.rows[0]?.table_name).toBe(table)
    }
    await second.pool.end()
  })

  it('serializa duas criações concorrentes', async () => {
    const [left, right] = await Promise.all([
      provisionPostgres(admin, randomUUID(), 'test'),
      provisionPostgres(admin, randomUUID(), 'test')
    ])
    expect(Number(left.createdDatabase) + Number(right.createdDatabase)).toBe(1)
    await Promise.all([left.pool.end(), right.pool.end()])
  }, 15_000)

  it('distingue role sem CREATEDB', async () => {
    const client = await maintenance()
    try {
      await client.query('DROP ROLE IF EXISTS agent_code_no_createdb')
      await client.query("CREATE ROLE agent_code_no_createdb LOGIN PASSWORD 'no-create-test'")
    } finally {
      await client.end()
    }
    await expect(
      provisionPostgres({ ...admin, user: 'agent_code_no_createdb', password: 'no-create-test' }, randomUUID(), 'test')
    ).rejects.toMatchObject({ code: 'CREATE_DATABASE_DENIED' })
  })

  it('bloqueia checksum divergente e schema mais novo', async () => {
    const ready = await provisionPostgres(admin, randomUUID(), 'test')
    await ready.pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', ['divergente'])
    await ready.pool.end()
    await expect(provisionPostgres(admin, randomUUID(), 'test')).rejects.toMatchObject({
      code: 'SCHEMA_CHECKSUM_MISMATCH'
    })

    const target = new Client({ host: admin.host, port: admin.port, user: admin.user, password: admin.password, database: POSTGRES_DATABASE })
    await target.connect()
    try {
      await target.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', [POSTGRES_MIGRATIONS[0].checksum])
      await target.query(
        "INSERT INTO schema_migrations(version, name, checksum, app_version, applied_by) VALUES(999, 'future', 'x', 'future', $1)",
        [randomUUID()]
      )
    } finally {
      await target.end()
    }
    await expect(provisionPostgres(admin, randomUUID(), 'test')).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' })
  }, 15_000)
})
