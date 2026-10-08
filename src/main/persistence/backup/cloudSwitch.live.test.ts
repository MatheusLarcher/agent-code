// @vitest-environment node
// A troca entre versões: o PostgreSQL embutido (18, binários de out/postgres) e um
// servidor "da nuvem" MAIS ANTIGO, descartável (ex.: Docker postgres:16 numa porta
// livre). Ligado por AGENT_CODE_LOCAL_PG_BIN + AGENT_CODE_PG_OLD_PORT; sem eles, pulado.
//
//   docker run -d --rm --name agentcode-pg16-teste -e POSTGRES_PASSWORD=<senha> -p 55416:5432 postgres:16-alpine
//   $env:AGENT_CODE_LOCAL_PG_BIN='out/postgres/bin'; $env:AGENT_CODE_PG_OLD_PORT='55416'; $env:AGENT_CODE_PG_OLD_PASSWORD='<senha>'
//   npx vitest run src/main/persistence/backup/cloudSwitch.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { BootstrapStore, POSTGRES_DATABASE } from '../bootstrapStore'
import { LocalPostgres } from '../localPostgres'
import { postgresClientConfig, provisionPostgres } from '../postgresProvisioning'
import { PostgresRepository } from '../postgresRepository'
import { prepareConversation } from '../writeQueue/conversationPrepare'
import { readSide } from './cloudSwitch'
import { DatabaseBackups } from './databaseBackups'

const binDir = process.env.AGENT_CODE_LOCAL_PG_BIN ? resolve(process.env.AGENT_CODE_LOCAL_PG_BIN) : ''
const oldPort = Number(process.env.AGENT_CODE_PG_OLD_PORT ?? 0)
const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8')
}

describe.skipIf(!binDir || !oldPort)('troca com uma nuvem de PostgreSQL mais antigo', () => {
  let root: string
  let server: LocalPostgres
  let local: PostgresConnectionDraft
  const cloud: PostgresConnectionDraft = {
    host: '127.0.0.1',
    port: oldPort,
    user: 'postgres',
    password: process.env.AGENT_CODE_PG_OLD_PASSWORD ?? '',
    maintenanceDatabase: 'postgres',
    tlsMode: 'disable',
    ca: ''
  }
  const installationId = randomUUID()
  let backups: DatabaseBackups

  async function repository(draft: PostgresConnectionDraft): Promise<PostgresRepository> {
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    const repo = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    return repo
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-code-cloud-live-'))
    const bootstrap = new BootstrapStore(join(root, 'userdata'), secureStorage)
    await bootstrap.saveLocalPort(46_632)
    server = new LocalPostgres(() => ({ binDir, dataDir: join(root, 'pgdata'), logFile: join(root, 'postgres.log') }))
    local = await server.ensure(bootstrap)
    const admin = new Client(postgresClientConfig(cloud, 'postgres'))
    await admin.connect()
    await admin.query('DROP DATABASE IF EXISTS "agent-code"')
    await admin.end()
    const repo = await repository(local)
    const projectId = randomUUID()
    for (const id of ['c1', 'c2', 'c3']) {
      const doc = { id, title: id, cwd: 'C:/proj', createdAt: 1, updatedAt: 2, projectId, projectSignature: 'sig', messages: [{ kind: 'user', id: 'm1', text: `oi ${id}` }] }
      await repo.writeConversation({ id, prepared: prepareConversation(doc, 'shared') })
    }
    await repo.close()
    backups = new DatabaseBackups({
      binDir: () => binDir,
      backupsDir: () => join(root, 'backups'),
      tempDir: () => join(root, 'tmp'),
      appVersion: 'test',
      activeSource: async () => null,
      sides: async () => ({ activeSide: 'local', cloudEnabled: true }),
      log: () => undefined,
      changed: () => undefined
    })
  }, 240_000)

  afterAll(async () => {
    backups?.dispose()
    await server?.stop().catch(() => undefined)
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }, 120_000)

  it('o diálogo lê os dois lados sem criar nada: a nuvem vazia e a versão dela', async () => {
    const before = await readSide('nuvem', cloud, installationId)
    expect(before.summary).toMatchObject({ reachable: true, exists: false, conversations: 0 })
    expect(Number.parseInt(before.summary.serverVersion ?? '0', 10)).toBeLessThan(18)
    const mine = await readSide('local', local, installationId)
    expect(mine.summary).toMatchObject({ reachable: true, exists: true, conversations: 3 })
  }, 120_000)

  it('local (18) → nuvem mais antiga: pg_restore 18 entra inteiro, contagens conferidas', async () => {
    await (await repository(cloud)).close()
    const dumped = await backups.dumpForTransfer({ side: 'local', draft: local })
    try {
      const checked = await backups.restoreInto(dumped.file, cloud, dumped.counts.tables)
      expect(checked).toMatch(/todas iguais/)
    } finally {
      await rm(dumped.file, { force: true })
    }
    const after = await readSide('nuvem', cloud, installationId)
    expect(after.summary).toMatchObject({ exists: true, conversations: 3 })
  }, 240_000)

  it('arquivo corrompido para a nuvem antiga (caminho do psql): nada é confirmado, a nuvem fica como estava', async () => {
    const bad = join(root, 'corrompido.dump')
    await writeFile(bad, 'PGDMP isto não é um dump')
    await expect(backups.restoreInto(bad, cloud, { conversations: 99 })).rejects.toMatchObject({ code: 'BACKUP_FAILED' })
    expect((await readSide('nuvem', cloud, installationId)).summary).toMatchObject({ exists: true, conversations: 3 })
  }, 120_000)

  it('nuvem mais antiga → local (18): o caminho de quem desliga a nuvem', async () => {
    const dumped = await backups.dumpForTransfer({ side: 'nuvem', draft: cloud })
    try {
      expect(await backups.restoreInto(dumped.file, local, dumped.counts.tables)).toMatch(/todas iguais/)
    } finally {
      await rm(dumped.file, { force: true })
    }
  }, 240_000)
})
