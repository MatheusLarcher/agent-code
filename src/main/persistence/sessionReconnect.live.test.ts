// @vitest-environment node
// Integração real: uma sessão de agente VIVA atravessa uma queda do PostgreSQL
// com reconexão automática. Antes, a sessão guardava o repositório da aquisição,
// que setOffline fecha com pool.end(): depois da volta, espelho, verificação do
// fim de turno e llm_calls falhavam com "Cannot use a pool after calling end on
// the pool". Aqui a sessão é montada como em index.ts (store/marcador/llm_calls
// pelo repositório ativo, keeper do lease no ativo, recuperação das sessões) e
// o teste derruba a rede com um proxy TCP no meio do turno.
// Ligada por AGENT_CODE_PG_INTEGRATION=1; sem ela os casos são pulados.
//
//   AGENT_CODE_PG_INTEGRATION=1 AGENT_CODE_PG_PORT=15533 npx vitest run src/main/persistence/sessionReconnect.live.test.ts
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
import { activeResumeMarker, activeSessionStore, activeTokenUsage } from './activeRepository'
import { ConversationLeaseKeeper } from './leaseKeeper'
import { upsertConversationWithLeaseRecovery } from './conversationWriteRecovery'
import { isTransientPostgresError } from './postgresRetry'
import { createSessionStorageRecovery, type RecoverableSession } from '../sessionStorageRecovery'
import type { PersistenceRepository } from './types'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const upstream = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'
}

/** Proxy TCP controlado pelo teste: `down()` derruba as conexões e recusa novas. */
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

  async down(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
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

const entry = (uuid: string, text: string) =>
  ({ type: 'user', uuid, sessionId: 's1', message: { role: 'user', content: text } }) as never

describe.skipIf(!integration)('sessão viva atravessando a reconexão do banco', () => {
  let proxy: FlakyProxy
  let dir: string
  let lifecycle: StorageLifecycleService

  beforeEach(async () => {
    await resetTarget()
    proxy = new FlakyProxy()
    await proxy.up()
    dir = await mkdtemp(join(tmpdir(), 'agent-code-session-reconnect-'))
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

  it('queda no meio do turno: a sessão segue viva e espelho, fim de turno, llm_calls, fila e gravação com fence funcionam depois', async () => {
    const convId = `conv-${randomUUID()}`
    const key = { projectKey: convId, sessionId: 's1' }
    const resolve = (): PersistenceRepository => lifecycle.repository()
    const acquired = lifecycle.repository()
    await acquired.upsertConversation({ id: convId, payload: { id: convId, title: 'antes da queda' } })
    const lease = await acquired.acquireConversationLease(convId)

    // A sessão, montada como em index.ts.
    const store = activeSessionStore(resolve, convId)
    const marker = activeResumeMarker(resolve)
    const usage = activeTokenUsage(resolve)
    const lost = vi.fn()
    const keeper = new ConversationLeaseKeeper(
      {
        renewConversationLease: async (held) => lifecycle.repository().renewConversationLease(held),
        releaseConversationLease: async (held) => lifecycle.repository().releaseConversationLease(held)
      },
      lease,
      { onLost: lost }
    ).start()
    let finishTurn!: () => void
    const turn = new Promise<void>((done) => (finishTurn = done))
    const session = {
      waitForIdle: () => turn,
      dispose: vi.fn<() => void>(),
      storageRestored: vi.fn<() => void>()
    }
    const sessions = new Map<string, RecoverableSession>([[convId, session]])
    const renewLeases = vi.fn(() => void keeper.renewNow())
    const onStatus = createSessionStorageRecovery({
      sessions,
      currentState: () => lifecycle.status().state,
      forget: vi.fn(),
      renewLeases
    })
    const unsubscribe = lifecycle.subscribe(onStatus)

    try {
      await store.append(key, [entry('e1', 'primeira')])

      // Rede fora com o turno ainda rodando.
      await proxy.down()
      expect(await waitFor(() => lifecycle.status().state === 'postgres-offline', 40_000)).toBe(true)
      const duringOutage = await store.append(key, [entry('e2', 'na queda')]).catch((error: unknown) => error)
      expect(isTransientPostgresError(duringOutage)).toBe(true)

      // O lease vence durante a queda (PC dormindo além dos 60s).
      const admin = new Client({ ...upstream, user: 'postgres', database: 'agent-code' })
      await admin.connect()
      try {
        await admin.query(
          "UPDATE conversation_leases SET expires_at = clock_timestamp() - interval '5 minutes' WHERE conversation_id = $1",
          [convId]
        )
      } finally {
        await admin.end()
      }

      await proxy.up()
      lifecycle.resumeReconnect()
      expect(await waitFor(() => lifecycle.status().state === 'postgres-ready', 30_000)).toBe(true)

      // A causa: o repositório da aquisição foi fechado pela queda.
      expect(lifecycle.repository()).not.toBe(acquired)
      await expect(acquired.createSessionStore(convId).append(key, [entry('x', 'velho')])).rejects.toThrow(
        /Cannot use a pool after calling end/
      )

      // A sessão NÃO foi descartada (o turno ainda roda) e a volta disparou
      // renovação de lease e o gatilho do reparo.
      expect(session.dispose).not.toHaveBeenCalled()
      expect(renewLeases).toHaveBeenCalled()
      expect(session.storageRestored).toHaveBeenCalled()

      // Espelho: o lote perdido na queda (o reparo reenvia) e um novo, pelo MESMO store.
      await store.append(key, [entry('e2', 'na queda')])
      await store.append(key, [entry('e3', 'depois')])
      const mirrored = (await store.load(key)) ?? []
      expect(mirrored.map((line) => (line as { uuid?: string }).uuid)).toEqual(['e1', 'e2', 'e3'])
      // Reenviar de novo (reparo repetido) não duplica.
      await store.append(key, [entry('e2', 'na queda')])
      expect(await store.load(key)).toHaveLength(3)

      // Fim de turno (resume_ready) e llm_calls pelo repositório ativo.
      await marker.markSessionResumeReady(convId, 's1', true, 'hash')
      expect(await lifecycle.repository().sessionResumeReady(convId, 's1')).toBe(true)
      await usage.insertLlmCall({
        convId,
        turnId: 't1',
        nodeId: 'n1',
        seq: 1,
        model: 'claude-test',
        inputTokens: 10,
        outputTokens: 5
      })
      expect(await usage.listLlmCalls(convId)).toHaveLength(1)

      // Fila de espera da conversa (outboxIpc resolve o repositório por chamada).
      await lifecycle.repository().replaceConversationOutbox(convId, [{ id: 'q1', payload: { text: 'na fila' } }])
      expect((await lifecycle.repository().listConversationOutbox()).filter((item) => item.conversationId === convId))
        .toHaveLength(1)

      // Gravação com fence logo após a volta: o lease estava vencido, é renovado
      // (ainda é desta instalação) e a gravação passa — sem falso "outro writer".
      const fence = () => ({ token: keeper.lease.token, fencingEpoch: keeper.lease.fencingEpoch })
      const stored = await upsertConversationWithLeaseRecovery(
        lifecycle.repository(),
        { id: convId, payload: { id: convId, title: 'depois da queda' }, lease: fence() },
        async () => ((await keeper.renewNow()) ? fence() : null)
      )
      expect(stored.payload).toMatchObject({ title: 'depois da queda' })
      expect(lost).not.toHaveBeenCalled()

      finishTurn()
      await new Promise((done) => setTimeout(done, 50))
      expect(session.dispose).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      await keeper.release()
    }
  }, 120_000)
})
