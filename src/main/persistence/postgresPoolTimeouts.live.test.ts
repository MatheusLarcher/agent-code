// @vitest-environment node
// Integração real: o pool de dados contra um PostgreSQL de verdade, nos modos
// de falha que esgotavam as 10 vagas e travavam o app ("timeout exceeded when
// trying to connect" em todo pedido). Ligada por AGENT_CODE_PG_INTEGRATION=1.
//
//   docker run -d --name agent-code-pg-test -p 55432:5432 -e POSTGRES_PASSWORD=agent-code-test-password postgres:16-alpine
//   AGENT_CODE_PG_INTEGRATION=1 npx vitest run src/main/persistence/postgresPoolTimeouts.live.test.ts
//
// Os tetos de produção (minutos) são trocados por segundos: o que se testa é
// que eles EXISTEM e soltam a vaga, não o valor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, type Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'

vi.mock('./postgresTimeouts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./postgresTimeouts')>()),
  POSTGRES_LOCK_TIMEOUT_MS: 1_000,
  POSTGRES_STATEMENT_TIMEOUT_MS: 3_000,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: 2_000,
  POSTGRES_QUERY_TIMEOUT_MS: 4_000,
  POSTGRES_CALL_TIMEOUT_MS: 1_500
}))

import { POSTGRES_DATABASE } from './bootstrapStore'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { createPostgresSessionStore } from './postgresSessionStore'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const upstream = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'
}

function draftFor(port: number): PostgresConnectionDraft {
  return { host: upstream.host, port, user: 'postgres', password: upstream.password, maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }
}

/** Proxy TCP que CONGELA as conexões existentes: os sockets continuam abertos
 *  dos dois lados, mas nada mais passa — o "socket meio morto" que nenhum erro
 *  de rede denuncia. Conexões novas passam normalmente. */
class FreezingProxy {
  private server: Server | null = null
  private readonly pairs = new Set<{ client: Socket; target: Socket; frozen: boolean }>()
  port = 0

  async up(): Promise<void> {
    this.server = createServer((client) => {
      const target = connect(upstream.port, upstream.host)
      const pair = { client, target, frozen: false }
      this.pairs.add(pair)
      const drop = (): void => {
        client.destroy()
        target.destroy()
        this.pairs.delete(pair)
      }
      client.on('error', drop).on('close', drop)
      target.on('error', drop).on('close', drop)
      client.on('data', (chunk) => { if (!pair.frozen) target.write(chunk) })
      target.on('data', (chunk) => { if (!pair.frozen) client.write(chunk) })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.port = (this.server.address() as { port: number }).port
  }

  freezeExisting(): void {
    for (const pair of this.pairs) pair.frozen = true
  }

  async down(): Promise<void> {
    for (const pair of this.pairs) {
      pair.client.destroy()
      pair.target.destroy()
    }
    this.pairs.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function resetTarget(): Promise<void> {
  const client = new Client({ ...upstream, user: 'postgres', database: 'postgres' })
  await client.connect()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

/** Resolve com o resultado, ou com 'PRESA' se não terminar no prazo — o teste
 *  nunca fica pendurado esperando o próprio bug. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'PRESA'> {
  return Promise.race([promise, new Promise<'PRESA'>((resolve) => setTimeout(() => resolve('PRESA'), ms))])
}

function settle<T>(promise: Promise<T>): Promise<{ ok: true } | { ok: false; message: string }> {
  return promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) })
  )
}

describe.runIf(integration).sequential('pool PostgreSQL: nenhuma consulta segura uma vaga para sempre', () => {
  let proxy: FreezingProxy
  let repository: PostgresRepository | null = null
  let pool: Pool | null = null
  const extra: Client[] = []

  beforeEach(async () => {
    await resetTarget()
    proxy = new FreezingProxy()
    await proxy.up()
  })

  afterEach(async () => {
    for (const client of extra.splice(0)) await client.end().catch(() => undefined)
    await proxy.down()
    // `close()` espera as vagas presas; sem teto, um teste que achou o bug
    // penduraria o afterEach.
    if (repository) await within(repository.close().catch(() => undefined), 3_000)
    repository = null
    pool = null
  })

  async function open(port: number): Promise<PostgresRepository> {
    const draft = draftFor(port)
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    pool = provisioned.pool
    repository = new PostgresRepository(pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repository.initialize()
    return repository
  }

  it('trava órfã de outra sessão: esperas por FOR UPDATE não esgotam o pool', async () => {
    const repo = await open(upstream.port)
    const task = await repo.createTask({ projectCwd: 'C:/p', title: 'alvo', goal: 'g' })

    // Outra sessão (ex.: outra máquina cuja conexão morreu no meio) segura a
    // linha da tarefa numa transação que nunca termina.
    const orphan = new Client({ ...upstream, user: 'postgres', database: POSTGRES_DATABASE })
    extra.push(orphan)
    await orphan.connect()
    await orphan.query('BEGIN')
    await orphan.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [task.id])

    // Mais pedidos na linha travada do que vagas no pool.
    const writes = Array.from({ length: 12 }, (_, index) =>
      settle(repo.appendTaskEvent({ taskId: task.id, kind: `evento-${index}` }))
    )
    // Uma leitura sem relação com a linha travada — o sintoma do usuário era
    // ESTA falhar com "timeout exceeded when trying to connect".
    const unrelated = await within(settle(repo.listTasks()), 15_000)
    expect(unrelated).toEqual({ ok: true })

    const settled = await within(Promise.all(writes), 10_000)
    expect(settled).not.toBe('PRESA')
    for (const result of settled as Awaited<(typeof writes)[number]>[]) {
      expect(result).toEqual({ ok: false, message: expect.stringMatching(/lock timeout/i) })
    }
    await orphan.query('ROLLBACK')
    // E, solta a trava, a escrita volta a funcionar na hora.
    await expect(repo.appendTaskEvent({ taskId: task.id, kind: 'depois' })).resolves.toMatchObject({ kind: 'depois' })
  }, 30_000)

  it('sessão nossa esquecida no meio de uma transação é derrubada pelo servidor', async () => {
    const repo = await open(upstream.port)
    const task = await repo.createTask({ projectCwd: 'C:/p', title: 'alvo', goal: 'g' })

    // Um caminho que pegou a conexão, abriu a transação e congelou.
    const wedged = await pool!.connect()
    wedged.on('error', () => undefined)
    await wedged.query('BEGIN')
    await wedged.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [task.id])

    // idle_in_transaction_session_timeout (2s aqui) solta a trava.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await expect(within(repo.appendTaskEvent({ taskId: task.id, kind: 'livre' }), 5_000)).resolves.toMatchObject({
      kind: 'livre'
    })
    wedged.release(new Error('sessão derrubada pelo servidor'))
  }, 30_000)

  it('socket meio morto: a consulta desiste, a conexão é descartada e o pool se recupera', async () => {
    const repo = await open(proxy.port)
    const task = await repo.createTask({ projectCwd: 'C:/p', title: 'alvo', goal: 'g' })
    const before = pool!.totalCount
    expect(pool!.idleCount).toBeGreaterThan(0)

    // Todas as conexões vivas (as ociosas do pool e a do LISTEN) param de
    // receber resposta, sem erro de rede nenhum.
    proxy.freezeExisting()

    const frozen = await within(settle(repo.appendTaskEvent({ taskId: task.id, kind: 'no-vacuo' })), 10_000)
    expect(frozen).not.toBe('PRESA')
    expect(frozen).toEqual({ ok: false, message: 'Query read timeout' })

    // A conexão presa saiu do pool. As outras ociosas congeladas custam, cada
    // uma, um query_timeout (em paralelo) e também saem — nenhuma fica presa.
    expect(pool!.totalCount).toBeLessThan(before)
    const drain = await within(Promise.all(Array.from({ length: before + 2 }, () => settle(repo.getTask(task.id)))), 10_000)
    expect(drain).not.toBe('PRESA')
    // Pool limpo: tudo funciona por conexões novas.
    const reads = await within(Promise.all(Array.from({ length: 12 }, () => settle(repo.getTask(task.id)))), 10_000)
    expect(reads).toEqual(Array.from({ length: 12 }, () => ({ ok: true })))
    await expect(repo.appendTaskEvent({ taskId: task.id, kind: 'recuperado' })).resolves.toMatchObject({
      kind: 'recuperado'
    })
  }, 60_000)

  it('socket meio morto: append do espelho e renovação do lease desistem no teto POR CHAMADA', async () => {
    const repo = await open(proxy.port)
    // Algumas conexões ociosas no pool, para as duas chamadas pegarem uma congelada.
    await Promise.all(Array.from({ length: 4 }, () => pool!.query('SELECT pg_sleep(0.05)')))
    expect(pool!.idleCount).toBeGreaterThanOrEqual(2)
    proxy.freezeExisting()

    const store = createPostgresSessionStore(pool!, randomUUID())
    const entry = { type: 'user', uuid: randomUUID() } as never
    let started = Date.now()
    const append = await within(settle(store.append({ projectKey: 'p', sessionId: 's' }, [entry])), 10_000)
    const appendMs = Date.now() - started
    expect(append).toEqual({ ok: false, message: 'Query read timeout' })

    started = Date.now()
    const lease = { conversationId: randomUUID(), ownerInstallationId: 'x', token: 't', fencingEpoch: 1, expiresAt: '' }
    const renew = await within(settle(repo.renewConversationLease(lease)), 10_000)
    const renewMs = Date.now() - started
    expect(renew).toEqual({ ok: false, message: 'Query read timeout' })

    // Teto por chamada (1,5s aqui) e não o geral (4s aqui; 130s em produção).
    expect(appendMs).toBeLessThan(3_000)
    expect(renewMs).toBeLessThan(3_000)
    console.info(`[call-timeout] append desistiu em ${appendMs}ms, renovação em ${renewMs}ms`)
  }, 30_000)

  it('podas de change_log e llm_calls em lotes, cada DELETE dentro do statement_timeout', async () => {
    const repo = await open(upstream.port)
    const admin = new Client({ ...upstream, user: 'postgres', database: POSTGRES_DATABASE })
    extra.push(admin)
    await admin.connect()
    await admin.query(
      `INSERT INTO change_log(entity, entity_id, scope, changed_at)
       SELECT 'teste', g::text, 'global', now() - interval '40 days' FROM generate_series(1, 12000) g`
    )
    await admin.query(`INSERT INTO change_log(entity, entity_id, scope) VALUES ('teste', 'recente', 'global')`)
    await admin.query(
      `INSERT INTO llm_calls(id, conv_id, turn_id, node_id, seq, model, created_at)
       SELECT 'velha-' || g, 'c', 't', 'n', g, 'm', now() - interval '20 days' FROM generate_series(1, 12000) g`
    )
    await admin.query(`INSERT INTO llm_calls(id, conv_id, turn_id, node_id, seq, model) VALUES ('nova', 'c', 't', 'n', 1, 'm')`)

    const deletes: { table: string; ms: number; rows: number }[] = []
    const original = pool!.query.bind(pool!) as (...args: unknown[]) => Promise<{ rowCount: number | null }>
    ;(pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : ''
      const started = Date.now()
      const result = await original(...args)
      const table = /DELETE FROM (\w+)/.exec(text)?.[1]
      if (table) deletes.push({ table, ms: Date.now() - started, rows: result.rowCount ?? 0 })
      return result
    }
    const pruners = repo as unknown as { changeLogPruner: { run(): Promise<void> }; tokenUsagePruner: { run(): Promise<void> } }
    await pruners.changeLogPruner.run()
    await pruners.tokenUsagePruner.run()

    const left = await admin.query<{ old_changes: string; recent_changes: string; old_calls: string; new_calls: string }>(
      `SELECT (SELECT count(*) FROM change_log WHERE changed_at < now() - interval '30 days') AS old_changes,
              (SELECT count(*) FROM change_log WHERE entity_id = 'recente') AS recent_changes,
              (SELECT count(*) FROM llm_calls WHERE id LIKE 'velha-%') AS old_calls,
              (SELECT count(*) FROM llm_calls WHERE id = 'nova') AS new_calls`
    )
    expect(left.rows[0]).toEqual({ old_changes: '0', recent_changes: '1', old_calls: '0', new_calls: '1' })
    // 12000 linhas em lotes de 5000: três DELETEs por tabela, nenhum perto do
    // statement_timeout (3s aqui).
    expect(deletes.filter((d) => d.table === 'change_log').map((d) => d.rows)).toEqual([5000, 5000, 2000])
    expect(deletes.filter((d) => d.table === 'llm_calls').map((d) => d.rows)).toEqual([5000, 5000, 2000])
    for (const d of deletes) expect(d.ms).toBeLessThan(3_000)
    console.info(`[prune] ${JSON.stringify(deletes)}`)
  }, 60_000)

  it('pool esgotado: o diagnóstico grava contagens, clientes retirados e pg_stat_activity', async () => {
    const file = join(tmpdir(), `pool-diag-live-${randomUUID()}.log`)
    process.env.AGENT_CODE_POOL_DIAGNOSTICS_FILE = file
    try {
      await open(upstream.port)
      const held = await Promise.all(Array.from({ length: 10 }, () => pool!.connect()))
      for (const client of held) {
        client.on('error', () => undefined)
        await client.query('SELECT 1 AS segurando_a_vaga')
      }
      // Uma vaga retirada cujo socket morreu: continua contando no totalCount.
      ;(held[0] as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy()
      await new Promise((resolve) => setTimeout(resolve, 200))

      const failure = await settle(pool!.query('SELECT 2'))
      expect(failure).toEqual({ ok: false, message: 'timeout exceeded when trying to connect' })

      let text = ''
      for (let attempt = 0; attempt < 50 && !text; attempt += 1) {
        text = await readFile(file, 'utf8').catch(() => '')
        if (!text) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const report = JSON.parse(text.trim().split('\n')[0])
      expect(report.pool).toMatchObject({ totalCount: 10, idleCount: 0, max: 10 })
      expect(report.clients).toHaveLength(10)
      expect(report.clients.filter((c: { state: string }) => c.state === 'checked-out')).toHaveLength(10)
      expect(report.clients.filter((c: { socketDestroyed: boolean }) => c.socketDestroyed)).toHaveLength(1)
      expect(report.clients[1].lastSql).toBe('SELECT 1 AS segurando_a_vaga')
      // 9 sessões vivas do pool + o LISTEN; a do socket destruído já saiu.
      expect(Array.isArray(report.activity)).toBe(true)
      expect(report.activity).toHaveLength(10)
      console.info(`[pool-diag] ${text.trim().slice(0, 1500)}`)
      for (const client of held) client.release(new Error('fim do teste'))
    } finally {
      delete process.env.AGENT_CODE_POOL_DIAGNOSTICS_FILE
      await rm(file, { force: true })
    }
  }, 30_000)
})
