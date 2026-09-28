// @vitest-environment node
// Integração real: o ciclo de vida da persistência contra um PostgreSQL de
// verdade, atrás de um proxy TCP que o teste derruba para simular o que a
// suspensão do Windows faz com os sockets (conexões mortas, rede fora por um
// tempo). Ligada por AGENT_CODE_PG_INTEGRATION=1; sem ela os casos são pulados.
//
//   AGENT_CODE_PG_INTEGRATION=1 AGENT_CODE_PG_PORT=15432 npx vitest run src/main/persistence/lifecycle.reconnect.live.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'

vi.mock('./kvFacade', () => ({ configureKvRepository: vi.fn(), configureKvRepositoryOffline: vi.fn() }))
vi.mock('../memory/memoryRuntime', () => ({ configureMemoryRuntime: vi.fn() }))
vi.mock('../tasks/taskRuntime', () => ({ configureTaskRuntime: vi.fn() }))

import { StorageLifecycleService } from './lifecycle'
import type { StorageStatus } from './types'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const upstream = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'
}

/** Proxy TCP que o teste controla: `cut()` derruba todas as conexões vivas (o
 *  que o SO faz com os sockets ao voltar da suspensão), `down()` passa a recusar
 *  conexões novas (rede ainda fora) e `up()` volta a aceitar. */
class FlakyProxy {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  port = 0

  async up(): Promise<void> {
    const server = createServer((client) => {
      const target = connect(upstream.port, upstream.host)
      this.sockets.add(client).add(target)
      const drop = (): void => {
        client.destroy()
        target.destroy()
        this.sockets.delete(client)
        this.sockets.delete(target)
      }
      client.on('error', drop).on('close', drop)
      target.on('error', drop).on('close', drop)
      client.pipe(target).pipe(client)
    })
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', () => resolve()))
    this.port = (server.address() as { port: number }).port
    this.server = server
  }

  cut(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  async down(): Promise<void> {
    this.cut()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8')
}

async function resetTarget(): Promise<void> {
  const client = new Client({ ...upstream, user: 'postgres', database: 'postgres' })
  await client.connect()
  try {
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'agent-code'")
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

describe.skipIf(!integration)('StorageLifecycleService: reconexão após queda de rede/suspensão', () => {
  let proxy: FlakyProxy
  let dir: string
  let lifecycle: StorageLifecycleService
  let states: StorageStatus['state'][]

  beforeEach(async () => {
    await resetTarget()
    proxy = new FlakyProxy()
    await proxy.up()
    dir = await mkdtemp(join(tmpdir(), 'agent-code-reconnect-'))
    await writeFile(
      join(dir, 'storage-bootstrap.json'),
      JSON.stringify({
        version: 1,
        installationId: randomUUID(),
        backend: 'postgres',
        transitionState: 'idle',
        transitionId: null,
        lastConfirmedTransitionId: null,
        postgres: {
          host: '127.0.0.1',
          port: proxy.port,
          user: 'postgres',
          maintenanceDatabase: 'postgres',
          tlsMode: 'disable',
          ca: '',
          encryptedPassword: Buffer.from(upstream.password, 'utf8').toString('base64'),
          targetDatabase: 'agent-code'
        }
      })
    )
    lifecycle = new StorageLifecycleService()
    states = []
    lifecycle.subscribe((status) => states.push(status.state))
    await lifecycle.initialize({
      location: { dir, dbPath: join(dir, 'unused.db') },
      userDataDir: dir,
      secureStorage,
      appVersion: 'test'
    })
    expect(lifecycle.status().state).toBe('postgres-ready')
  }, 60_000)

  afterEach(async () => {
    await lifecycle.close().catch(() => undefined)
    await proxy.down()
    await rm(dir, { recursive: true, force: true })
  })

  it('conexões derrubadas (volta da suspensão com a rede de pé) não viram "Persistência indisponível"', async () => {
    proxy.cut()
    // Tempo para o LISTEN perceber a queda e reconectar.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(states).not.toContain('postgres-offline')
    expect(lifecycle.status()).toMatchObject({ state: 'postgres-ready', writable: true })
    // E o banco continua gravável pelo repositório ativo.
    const repository = lifecycle.repository()
    const written = await repository.setKv({ scope: 'device', key: 'reconnect-probe', value: 'ok-1' })
    expect(written.value).toBe('ok-1')
  }, 30_000)

  it('rede fora por um tempo: fica offline e volta SOZINHO quando a rede volta', async () => {
    await proxy.down()
    expect(await waitFor(() => lifecycle.status().state === 'postgres-offline', 40_000)).toBe(true)
    await proxy.up()
    expect(await waitFor(() => lifecycle.status().state === 'postgres-ready', 40_000)).toBe(true)
    expect(lifecycle.status().writable).toBe(true)
    const written = await lifecycle.repository().setKv({ scope: 'device', key: 'reconnect-probe', value: 'ok-2' })
    expect(written.value).toBe('ok-2')
  }, 90_000)

  it('lease vencido durante a suspensão: renovação revive só se ninguém assumiu (escritor único)', async () => {
    const repository = lifecycle.repository()
    const conversationId = `conv-${randomUUID()}`
    await repository.upsertConversation({ id: conversationId, payload: { id: conversationId, title: 'A' } })
    const lease = await repository.acquireConversationLease(conversationId)
    const otherInstallation = randomUUID()
    // O PC dormiu além dos 60s: o lease venceu no servidor e os sockets morreram.
    const admin = new Client({ ...upstream, user: 'postgres', database: 'agent-code' })
    await admin.connect()
    try {
      await admin.query(
        "UPDATE conversation_leases SET expires_at = clock_timestamp() - interval '5 minutes' WHERE conversation_id = $1",
        [conversationId]
      )
      proxy.cut()
      // Uma consulta disparada no MESMO instante da queda pode pegar a conexão
      // morta do pool e falhar — o keeper trata como transitória e tenta de novo
      // em LEASE_RETRY_MS. Aqui só damos ao pool o tempo de descartar as mortas.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      // Ninguém assumiu: o mesmo token volta a valer (heartbeat do keeper).
      const renewed = await lifecycle.repository().renewConversationLease(lease)
      expect(renewed.fencingEpoch).toBe(lease.fencingEpoch)

      // Outro dispositivo assumiu enquanto este dormia: o fence antigo é recusado.
      await admin.query("INSERT INTO installations(installation_id, app_version) VALUES($1, 'other')", [
        otherInstallation
      ])
      await admin.query(
        `UPDATE conversation_leases SET owner_installation_id = $2, token = $3, fencing_epoch = fencing_epoch + 1,
           expires_at = clock_timestamp() + interval '60 seconds' WHERE conversation_id = $1`,
        [conversationId, otherInstallation, randomUUID()]
      )
      await expect(lifecycle.repository().renewConversationLease(lease)).rejects.toMatchObject({
        code: 'LEASE_HELD_BY_OTHER_DEVICE'
      })
    } finally {
      await admin.end()
    }
  }, 30_000)

  it('volta da suspensão: o aviso de resume reconecta na hora, sem esperar o backoff', async () => {
    await proxy.down()
    expect(await waitFor(() => lifecycle.status().state === 'postgres-offline', 40_000)).toBe(true)
    await proxy.up()
    const started = Date.now()
    lifecycle.resumeReconnect()
    expect(await waitFor(() => lifecycle.status().state === 'postgres-ready', 15_000)).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 90_000)
})
