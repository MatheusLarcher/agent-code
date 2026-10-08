// @vitest-environment node
// Backup, restauração e cópia entre dois PostgreSQL de verdade, com os binários
// embutidos (pg_dump/pg_restore de out/postgres) e dois clusters descartáveis em
// pastas temporárias. Ligado por AGENT_CODE_LOCAL_PG_BIN; sem ela, pulado.
//
//   $env:AGENT_CODE_LOCAL_PG_BIN='out/postgres/bin'; npx vitest run src/main/persistence/backup/databaseBackups.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { BootstrapStore, POSTGRES_DATABASE } from '../bootstrapStore'
import { LocalPostgres } from '../localPostgres'
import { postgresClientConfig, provisionPostgres } from '../postgresProvisioning'
import { PostgresRepository } from '../postgresRepository'
import { prepareConversation } from '../writeQueue/conversationPrepare'
import { DatabaseBackups } from './databaseBackups'
import { PgToolAbortedError } from './pgTools'

const binDir = process.env.AGENT_CODE_LOCAL_PG_BIN ? resolve(process.env.AGENT_CODE_LOCAL_PG_BIN) : ''
const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8')
}
const PROJECT_ID = randomUUID()

describe.skipIf(!binDir)('backups do banco com pg_dump/pg_restore de verdade', () => {
  let root: string
  const servers: LocalPostgres[] = []
  const repos: PostgresRepository[] = []
  let a: PostgresConnectionDraft
  let b: PostgresConnectionDraft
  let repoA: PostgresRepository
  let backups: DatabaseBackups
  const logs: string[] = []

  /** Um cluster descartável numa pasta temporária, com o mesmo código do embutido. */
  async function cluster(name: string, port: number): Promise<PostgresConnectionDraft> {
    const dir = join(root, name)
    const bootstrap = new BootstrapStore(join(dir, 'userdata'), secureStorage)
    await bootstrap.saveLocalPort(port)
    const server = new LocalPostgres(() => ({ binDir, dataDir: join(dir, 'pgdata'), logFile: join(dir, 'postgres.log') }))
    servers.push(server)
    return server.ensure(bootstrap)
  }

  async function repository(draft: PostgresConnectionDraft): Promise<PostgresRepository> {
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    const repo = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    repos.push(repo)
    return repo
  }

  async function write(repo: PostgresRepository, id: string, text: string): Promise<void> {
    const doc = { id, title: id, cwd: 'C:/proj', createdAt: 1, updatedAt: 2, projectId: PROJECT_ID, projectSignature: 'sig', messages: [{ kind: 'user', id: 'm1', text }] }
    await repo.writeConversation({ id, prepared: prepareConversation(doc, 'shared') })
  }

  const ids = async (repo: PostgresRepository): Promise<string[]> =>
    (await repo.loadConversations()).filter((row) => !row.deletedAt).map((row) => row.id).sort()

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-code-backup-live-'))
    a = await cluster('a', 46_432)
    b = await cluster('b', 46_532)
    repoA = await repository(a)
    await write(repoA, 'c1', 'primeira')
    await write(repoA, 'c2', 'segunda')
    backups = new DatabaseBackups({
      binDir: () => binDir,
      backupsDir: () => join(root, 'cache', 'backups'),
      tempDir: () => join(root, 'local', 'backups-tmp'),
      appVersion: 'test',
      activeSource: async () => ({ side: 'local', draft: a }),
      sides: async () => ({ activeSide: 'local', cloudEnabled: false }),
      log: (line) => logs.push(line),
      changed: () => undefined
    })
  }, 240_000)

  afterAll(async () => {
    backups?.dispose()
    for (const repo of repos) await repo.close().catch(() => undefined)
    for (const server of servers) await server.stop().catch(() => undefined)
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }, 120_000)

  it('backup com as contagens do mesmo snapshot; restaurar volta o banco ao estado do backup', async () => {
    const meta = await backups.create({ side: 'local', draft: a }, 'diario')
    expect(meta).toMatchObject({ side: 'local', reason: 'diario', conversations: 2 })
    expect(meta.tables.conversations).toBe(2)
    expect(meta.sizeBytes).toBeGreaterThan(1000)
    expect((await backups.list()).items.map((item) => item.file)).toEqual([meta.file])

    await write(repoA, 'c3', 'depois do backup')
    expect(await ids(repoA)).toEqual(['c1', 'c2', 'c3'])
    await repoA.close()
    const { path } = await backups.read(meta.file)
    expect(await backups.restoreInto(path, a, meta.tables)).toMatch(/tabelas conferidas, todas iguais/)
    repoA = await repository(a)
    expect(await ids(repoA)).toEqual(['c1', 'c2'])
  }, 240_000)

  it('cópia de um servidor para outro (a troca): o destino fica igual à origem', async () => {
    const repoB = await repository(b)
    await write(repoB, 'so-no-b', 'vai sumir')
    const dumped = await backups.dumpForTransfer({ side: 'local', draft: a })
    try {
      await repoB.close()
      await backups.restoreInto(dumped.file, b, dumped.counts.tables)
    } finally {
      await rm(dumped.file, { force: true })
    }
    const copy = await repository(b)
    expect(await ids(copy)).toEqual(await ids(repoA))
    const [original] = await repoA.loadConversations({ ids: ['c1'] })
    const [copied] = await copy.loadConversations({ ids: ['c1'] })
    expect(copied).toMatchObject({ revision: original.revision, contentHash: original.contentHash })
  }, 240_000)

  it('arquivo corrompido: pg_restore falha e o destino continua como estava (transação única)', async () => {
    const bad = join(root, 'corrompido.dump')
    await writeFile(bad, 'PGDMP isto não é um dump')
    const before = await ids(repoA)
    await expect(backups.restoreInto(bad, a, { conversations: 99 })).rejects.toMatchObject({ code: 'BACKUP_FAILED' })
    expect(await ids(repoA)).toEqual(before)
  }, 120_000)

  it('cancelado no meio (fechamento do app): nada pela metade na pasta nem na lista', async () => {
    const controller = new AbortController()
    const running = backups.create({ side: 'local', draft: a }, 'diario', controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expect(running).rejects.toBeInstanceOf(PgToolAbortedError)
    const dir = join(root, 'cache', 'backups')
    expect((await readdir(dir)).filter((name) => name.endsWith('.partial'))).toEqual([])
    expect((await backups.list()).items.every((item) => existsSync(join(dir, item.file)))).toBe(true)
    expect(await readdir(join(root, 'local', 'backups-tmp'))).toEqual([])
  }, 120_000)
})
