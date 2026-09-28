// @vitest-environment node
// Integração real: COMMIT ambíguo no append do espelho e lock_timeout curto dos
// caminhos quentes, contra um PostgreSQL descartável. Um proxy TCP entre o pool
// e o servidor derruba/congela a conexão logo depois de o COMMIT sair — o caso
// em que o servidor aplica o COMMIT e a resposta nunca chega. Ligada por
// AGENT_CODE_PG_INTEGRATION=1 (ver postgresPoolTimeouts.live.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { Client, type Pool } from 'pg'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { PostgresConnectionDraft } from '../../shared/ipc'

// Tetos encolhidos para o teste andar rápido, mantendo as relações de produção:
// lock_timeout das transações quentes < teto do cliente por consulta.
vi.mock('./postgresTimeouts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./postgresTimeouts')>()),
  POSTGRES_CALL_TIMEOUT_MS: 3_000,
  HOT_PATH_LOCK_TIMEOUT_MS: 1_000,
  APPEND_IDLE_IN_TRANSACTION_TIMEOUT_MS: 1_500
}))

import { POSTGRES_DATABASE } from './bootstrapStore'
import { pendingCommitsFor } from './postgresCommitAmbiguity'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { createPostgresSessionStore } from './postgresSessionStore'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const upstream = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'
}

type Mode = 'pass' | 'drop-after-commit' | 'freeze-after-commit' | 'blackhole-commit'
const COMMIT_MESSAGE = Buffer.from('COMMIT\0')

/** Proxy TCP que, armado, age sobre a PRIMEIRA conexão que mandar um COMMIT. */
class CommitProxy {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private mode: Mode = 'pass'
  port = 0
  fired = false

  arm(mode: Mode): void {
    this.mode = mode
    this.fired = false
  }

  async up(): Promise<void> {
    this.server = createServer((client) => {
      const target = connect(upstream.port, upstream.host)
      this.sockets.add(client).add(target)
      let toClient = true
      let toServer = true
      let keepTarget = false
      client.on('error', () => undefined)
      target.on('error', () => undefined)
      client.on('close', () => {
        // Sem o FIN, o servidor segue com a sessão aberta: o "socket meio morto".
        if (!keepTarget) target.end()
      })
      // Congelado, o cliente não fica sabendo nem que o servidor fechou.
      target.on('close', () => {
        if (toClient) client.destroy()
      })
      target.on('data', (chunk) => {
        if (toClient) client.write(chunk)
      })
      client.on('data', (chunk: Buffer) => {
        const isCommit = !this.fired && this.mode !== 'pass' && chunk[0] === 0x51 && chunk.includes(COMMIT_MESSAGE)
        if (!isCommit) {
          if (toServer) target.write(chunk)
          return
        }
        this.fired = true
        const mode = this.mode
        this.mode = 'pass'
        if (mode === 'blackhole-commit') {
          // O COMMIT nunca chega; nada mais passa em nenhum sentido.
          toServer = false
          toClient = false
          keepTarget = true
          return
        }
        target.write(chunk)
        if (mode === 'drop-after-commit') {
          toClient = false
          client.destroy()
        } else {
          toClient = false
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.port = (this.server.address() as { port: number }).port
  }

  async down(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function admin(database = 'postgres'): Promise<Client> {
  const client = new Client({ ...upstream, user: 'postgres', database })
  await client.connect()
  return client
}

async function resetTarget(): Promise<void> {
  const client = await admin()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

function draftFor(port: number): PostgresConnectionDraft {
  return { host: upstream.host, port, user: 'postgres', password: upstream.password, maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }
}

// Entradas sem uuid, duas delas idênticas (legítimo), e uma com uuid.
function batch(sessionId: string): SessionStoreEntry[] {
  return [
    { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'oi' } },
    { type: 'custom-title', customTitle: 'Título', sessionId },
    { type: 'tag', tag: 'x', sessionId },
    { type: 'tag', tag: 'x', sessionId },
    { type: 'agent-metadata', agentType: 'geral', sessionId }
  ] as unknown as SessionStoreEntry[]
}

describe.runIf(integration).sequential('append do espelho contra PostgreSQL real', () => {
  let proxy: CommitProxy
  let pool: Pool
  let repository: PostgresRepository
  let db: Client
  let conversationId: string

  beforeEach(async () => {
    await resetTarget()
    proxy = new CommitProxy()
    await proxy.up()
    const installationId = randomUUID()
    const draft = draftFor(proxy.port)
    pool = (await provisionPostgres(draft, installationId, 'test')).pool
    repository = new PostgresRepository(pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    db = await admin(POSTGRES_DATABASE)
    conversationId = randomUUID()
    await db.query(
      `INSERT INTO conversations(conversation_id, payload, revision, content_hash, updated_by)
       VALUES($1, '{}'::jsonb, 1, 'h', $2)`,
      [conversationId, installationId]
    )
  })

  afterEach(async () => {
    await db.end().catch(() => undefined)
    await proxy.down()
    await pool.end().catch(() => undefined)
  })

  async function counts(sessionId: string): Promise<{ total: number; uuidless: number }> {
    const result = await db.query<{ total: string; uuidless: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE entry_uuid IS NULL) AS uuidless
       FROM sdk_session_entries WHERE conversation_id = $1 AND session_id = $2`,
      [conversationId, sessionId]
    )
    return { total: Number(result.rows[0].total), uuidless: Number(result.rows[0].uuidless) }
  }

  it('conexão derrubada logo depois do COMMIT: a retentativa interna não duplica nada', async () => {
    const store = createPostgresSessionStore(pool, conversationId)
    const entries = batch('s-drop')
    proxy.arm('drop-after-commit')
    await expect(store.append({ projectKey: 'p', sessionId: 's-drop' }, entries)).resolves.toBeUndefined()
    expect(proxy.fired).toBe(true)
    expect(await counts('s-drop')).toEqual({ total: 5, uuidless: 4 })
    expect(pendingCommitsFor(pool).size).toBe(0)
  }, 30_000)

  it('resposta do COMMIT perdida (Query read timeout): a repetição do SDK com o mesmo lote não duplica', async () => {
    const store = createPostgresSessionStore(pool, conversationId)
    const key = { projectKey: 'p', sessionId: 's-freeze' }
    const entries = batch('s-freeze')
    proxy.arm('freeze-after-commit')
    await expect(store.append(key, entries)).rejects.toThrow('Query read timeout')
    expect(proxy.fired).toBe(true)
    // O servidor aplicou o COMMIT; só a resposta se perdeu.
    expect(await counts('s-freeze')).toEqual({ total: 5, uuidless: 4 })
    expect(pendingCommitsFor(pool).size).toBe(1)

    // É o que o sendWithRetry do SDK faz: chama de novo com o mesmo lote.
    await expect(store.append(key, entries)).resolves.toBeUndefined()
    expect(await counts('s-freeze')).toEqual({ total: 5, uuidless: 4 })
    expect(pendingCommitsFor(pool).size).toBe(0)
    const summary = await store.listSessionSummaries!('p')
    expect(summary.map((item) => item.sessionId)).toEqual(['s-freeze'])
  }, 30_000)

  it('pendência atravessa a reconexão: pool fechado, pool novo do mesmo banco, a repetição não duplica', async () => {
    const key = { projectKey: 'p', sessionId: 's-reconnect' }
    const entries = batch('s-reconnect')
    proxy.arm('freeze-after-commit')
    await expect(createPostgresSessionStore(pool, conversationId).append(key, entries)).rejects.toThrow('Query read timeout')
    expect(await counts('s-reconnect')).toEqual({ total: 5, uuidless: 4 })

    // O que setOffline + reconexão automática fazem: pool.end() e outro Pool.
    await pool.end()
    pool = (await provisionPostgres(draftFor(proxy.port), randomUUID(), 'test')).pool
    await expect(createPostgresSessionStore(pool, conversationId).append(key, entries)).resolves.toBeUndefined()
    expect(await counts('s-reconnect')).toEqual({ total: 5, uuidless: 4 })
    expect(pendingCommitsFor(pool).size).toBe(0)
  }, 30_000)

  it('replay do reparo (store de replay do repositório): sem uuid não duplica e idênticas legítimas continuam gravadas', async () => {
    const sessionId = 's-replay'
    const key = { projectKey: 'p', sessionId }
    const users = [randomUUID(), randomUUID(), randomUUID()].map(
      (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: uuid } }) as unknown as SessionStoreEntry
    )
    const tag = { type: 'tag', tag: 'x', sessionId } as unknown as SessionStoreEntry
    // Espelho vivo: a mesma tag em dois momentos, em lotes separados — legítimo.
    const live = createPostgresSessionStore(pool, conversationId)
    await live.append(key, [users[0], tag])
    await live.append(key, [users[1], tag])
    expect(await counts(sessionId)).toEqual({ total: 4, uuidless: 2 })

    // O 3º lote (user + a mesma tag) foi descartado pelo SDK. Reparo repetido,
    // em dois lotes cada, pelo mesmo caminho de produção.
    const transcript = [users[0], tag, users[1], tag, users[2], tag]
    for (let round = 0; round < 2; round += 1) {
      const replay = repository.createSessionReplayStore!(conversationId)
      await replay.append(key, transcript.slice(0, 3))
      await replay.append(key, transcript.slice(3))
    }
    expect(await counts(sessionId)).toEqual({ total: 6, uuidless: 3 })
  }, 30_000)

  it('controle: sem a pendência (repetição às cegas, o comportamento antigo) o mesmo cenário duplica', async () => {
    const store = createPostgresSessionStore(pool, conversationId)
    const key = { projectKey: 'p', sessionId: 's-control' }
    const entries = batch('s-control')
    proxy.arm('freeze-after-commit')
    await expect(store.append(key, entries)).rejects.toThrow('Query read timeout')
    ;(pendingCommitsFor(pool) as unknown as { items: Map<string, unknown> }).items.clear()
    await store.append(key, entries)
    // uuid tem ON CONFLICT; as 4 sem uuid entram de novo.
    expect(await counts('s-control')).toEqual({ total: 9, uuidless: 8 })
  }, 30_000)

  it('COMMIT que nunca chegou (socket meio morto): a transação aborta no servidor e a repetição grava uma vez', async () => {
    const store = createPostgresSessionStore(pool, conversationId)
    const key = { projectKey: 'p', sessionId: 's-hole' }
    const entries = batch('s-hole')
    proxy.arm('blackhole-commit')
    await expect(store.append(key, entries)).rejects.toThrow('Query read timeout')
    expect(await counts('s-hole')).toEqual({ total: 0, uuidless: 0 })

    // O servidor derrubou a transação órfã pelo idle_in_transaction curto do
    // append (1,5s aqui, antes do teto de 3s do cliente): ela já está 'aborted'.
    const probe = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND state = 'idle in transaction'`,
      [POSTGRES_DATABASE]
    )
    expect(probe.rows[0].n).toBe('0')
    const started = Date.now()
    await expect(store.append(key, entries)).resolves.toBeUndefined()
    expect(await counts('s-hole')).toEqual({ total: 5, uuidless: 4 })
    console.info(`[commit-ambiguo] repetição resolveu 'aborted' e gravou em ${Date.now() - started}ms`)
  }, 60_000)

  it('espera por trava no append: o servidor corta primeiro (55P03) e a conexão volta ao pool', async () => {
    const store = createPostgresSessionStore(pool, conversationId)
    const key = { projectKey: 'p', sessionId: 's-lock' }
    await store.append(key, batch('s-lock'))
    const before = pool.totalCount

    await db.query('BEGIN')
    await db.query('SELECT 1 FROM sdk_sessions WHERE conversation_id = $1 AND session_id = $2 FOR UPDATE', [conversationId, 's-lock'])
    const started = Date.now()
    const error = await store.append(key, batch('s-lock')).catch((caught: unknown) => caught)
    const elapsed = Date.now() - started
    await db.query('ROLLBACK')

    expect(error).toMatchObject({ code: '55P03' })
    // lock_timeout de 1s aqui, teto do cliente de 3s: foi o servidor.
    expect(elapsed).toBeLessThan(2_500)
    expect(pool.totalCount).toBe(before)
    expect(pool.idleCount).toBe(before)
    console.info(`[lock-timeout] append: 55P03 em ${elapsed}ms, conexões ${before} -> ${pool.totalCount}`)
  }, 30_000)

  it('espera por trava na renovação do lease: o servidor corta primeiro (55P03) e a conexão volta ao pool', async () => {
    const lease = await repository.acquireConversationLease(conversationId)
    const before = pool.totalCount

    await db.query('BEGIN')
    await db.query('SELECT 1 FROM conversation_leases WHERE conversation_id = $1 FOR UPDATE', [conversationId])
    const started = Date.now()
    const error = await repository.renewConversationLease(lease).catch((caught: unknown) => caught)
    const elapsed = Date.now() - started
    await db.query('ROLLBACK')

    expect(error).toMatchObject({ code: '55P03' })
    expect(elapsed).toBeLessThan(2_500)
    expect(pool.totalCount).toBe(before)
    await expect(repository.renewConversationLease(lease)).resolves.toMatchObject({ conversationId })
    console.info(`[lock-timeout] renovação: 55P03 em ${elapsed}ms, conexões ${before} -> ${pool.totalCount}`)
  }, 30_000)
})
