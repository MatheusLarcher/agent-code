// @vitest-environment node
// Integração real atrás de um PgBouncer (config padrão, pool_mode=session).
// Os tetos do servidor (lock/statement/idle_in_transaction) iam como parâmetro
// de startup e o PgBouncer recusava TODA conexão com "unsupported startup
// parameter". Agora vão por SET depois de conectar; aqui se confere com SHOW
// que estão ativos no pool, no LISTEN e na conexão avulsa. Ligada por
// AGENT_CODE_PG_INTEGRATION=1 e AGENT_CODE_PGBOUNCER_PORT.
//
//   docker network create e26c-net
//   docker run -d --name e26c-pg --network e26c-net -e POSTGRES_PASSWORD=agent-code-test-password postgres:16-alpine
//   docker run -d --name e26c-bouncer --network e26c-net -p 127.0.0.1:16432:5432 \
//     -e DB_HOST=e26c-pg -e DB_USER=postgres -e DB_PASSWORD=agent-code-test-password \
//     -e AUTH_TYPE=scram-sha-256 -e POOL_MODE=session edoburu/pgbouncer
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { postgresClientConfig, provisionPostgres, testPostgresConnection } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { applySessionTimeouts } from './postgresSessionSetup'
import { createPostgresSessionStore } from './postgresSessionStore'
import {
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS
} from './postgresTimeouts'

const bouncerPort = Number(process.env.AGENT_CODE_PGBOUNCER_PORT ?? 0)
const enabled = process.env.AGENT_CODE_PG_INTEGRATION === '1' && bouncerPort > 0
const host = process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1'
const password = process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'
const draft: PostgresConnectionDraft = {
  host,
  port: bouncerPort,
  user: 'postgres',
  password,
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

type Queryable = { query: (text: string) => Promise<{ rows: Record<string, string>[] }> }

const NAMES = ['lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout'] as const

/** Os três tetos como a sessão no servidor os vê: `SHOW` (texto) e o valor em
 *  ms de `pg_settings`. */
async function activeTimeouts(client: Queryable): Promise<Record<string, string | number>> {
  const shown: Record<string, string | number> = {}
  for (const name of NAMES) {
    const show = await client.query(`SHOW ${name}`)
    shown[`SHOW ${name}`] = show.rows[0][name]
  }
  const settings = await client.query(
    `SELECT name, setting FROM pg_settings WHERE name IN ('${NAMES.join("', '")}')`
  )
  for (const row of settings.rows) shown[row.name] = Number(row.setting)
  return shown
}

const expected = {
  idle_in_transaction_session_timeout: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
  statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS
}

describe.runIf(enabled).sequential('PostgreSQL atrás do PgBouncer', () => {
  let repository: PostgresRepository | null = null
  const extra: Client[] = []

  afterEach(async () => {
    for (const client of extra.splice(0)) await client.end().catch(() => undefined)
    await repository?.close().catch(() => undefined)
    repository = null
  })

  it('o jeito antigo (tetos como parâmetro de startup) é recusado pelo PgBouncer', async () => {
    const old = new Client({ host, port: bouncerPort, user: 'postgres', password, database: 'postgres', statement_timeout: 1_000 })
    old.on('error', () => undefined)
    await expect(old.connect()).rejects.toThrow(/unsupported startup parameter/i)
    await old.end().catch(() => undefined)
  })

  it('testar conexão, provisionar, pool e LISTEN funcionam, com os três tetos ativos por SET', async () => {
    await expect(testPostgresConnection(draft)).resolves.toBeUndefined()

    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    repository = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repository.initialize()

    // Pool (onConnect): vale para toda conexão, inclusive as abertas depois.
    const pooled = await Promise.all(Array.from({ length: 3 }, () => provisioned.pool.connect()))
    try {
      for (const client of pooled) {
        const shown = await activeTimeouts(client as unknown as Queryable)
        expect(shown).toMatchObject(expected)
        console.info(`[pgbouncer] pool: ${JSON.stringify(shown)}`)
      }
    } finally {
      for (const client of pooled) client.release()
    }

    // LISTEN do change feed (Client avulso, SET logo após o connect).
    const listen = (repository as unknown as { feed: { client: Queryable | null } }).feed.client
    expect(listen).not.toBeNull()
    const listenShown = await activeTimeouts(listen!)
    expect(listenShown).toMatchObject(expected)
    console.info(`[pgbouncer] LISTEN: ${JSON.stringify(listenShown)}`)

    // O mesmo caminho do maintenance/testPostgresConnection: Client avulso + SET.
    const standalone = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
    extra.push(standalone)
    await standalone.connect()
    await applySessionTimeouts(standalone)
    const standaloneShown = await activeTimeouts(standalone as unknown as Queryable)
    expect(standaloneShown).toMatchObject(expected)
    console.info(`[pgbouncer] avulso: ${JSON.stringify(standaloneShown)}`)

    // E o app funciona de ponta a ponta atrás do PgBouncer.
    const task = await repository.createTask({ projectCwd: 'C:/p', title: 'via pgbouncer', goal: 'g' })
    await expect(repository.getTask(task.id)).resolves.toMatchObject({ title: 'via pgbouncer' })

    // Append do espelho (BEGIN; SET LOCAL ...; txid_current) e renovação do
    // lease (transação com SET LOCAL lock_timeout) também passam por ele, e o
    // txid_status que resolve um COMMIT ambíguo responde por outra conexão.
    const conversationId = randomUUID()
    await provisioned.pool.query(
      `INSERT INTO conversations(conversation_id, payload, revision, content_hash, updated_by)
       VALUES($1, '{}'::jsonb, 1, 'h', $2)`,
      [conversationId, installationId]
    )
    const store = createPostgresSessionStore(provisioned.pool, conversationId)
    const key = { projectKey: 'p', sessionId: 's-bouncer' }
    await store.append(key, [{ type: 'custom-title', customTitle: 't', sessionId: 's-bouncer' }] as never)
    await expect(store.load(key)).resolves.toHaveLength(1)
    const lease = await repository.acquireConversationLease(conversationId)
    await expect(repository.renewConversationLease(lease)).resolves.toMatchObject({ conversationId })
    const txid = await provisioned.pool.query<{ txid: string }>('SELECT txid_current()::text AS txid')
    const status = await provisioned.pool.query<{ status: string }>('SELECT txid_status($1::bigint) AS status', [txid.rows[0].txid])
    expect(status.rows[0].status).toBe('committed')
  }, 60_000)
})
