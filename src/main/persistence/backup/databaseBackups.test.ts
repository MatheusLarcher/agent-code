// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { commitBackup, type BackupMeta } from './backupFiles'
import { DatabaseBackups } from './databaseBackups'
import { PgToolAbortedError } from './pgTools'

const draft: PostgresConnectionDraft = { host: '127.0.0.1', port: 45432, user: 'agentcode', password: 'x', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }

let root: string
let backups: DatabaseBackups | null = null
const logs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-code-daily-'))
  logs.length = 0
})
afterEach(async () => {
  backups?.dispose()
  backups = null
  await rm(root, { recursive: true, force: true })
})

function make(active: boolean, now = Date.now()): DatabaseBackups {
  backups = new DatabaseBackups({
    binDir: () => 'bin',
    backupsDir: () => join(root, 'backups'),
    tempDir: () => join(root, 'tmp'),
    appVersion: 't',
    activeSource: async () => (active ? { side: 'local', draft } : null),
    sides: async () => ({ activeSide: 'local', cloudEnabled: false }),
    log: (line) => logs.push(line),
    changed: () => undefined,
    now: () => now
  })
  return backups
}

async function existingDaily(createdAt: Date): Promise<void> {
  const file = '2026-10-07_0900_local_diario.dump'
  const temp = join(root, 'x.dump')
  await writeFile(temp, 'PGDMP')
  await commitBackup(join(root, 'backups'), temp, {
    version: 1, file, createdAt: createdAt.toISOString(), side: 'local', reason: 'diario', appVersion: 't',
    conversations: 1, lastUpdate: null, sizeBytes: 5, tables: {}, serverVersion: null
  } satisfies BackupMeta)
}

describe('backup diário', () => {
  it('sem diário nas últimas 24 h: roda em segundo plano, do lado em uso', async () => {
    const service = make(true)
    const create = vi.spyOn(service, 'create').mockResolvedValue({} as BackupMeta)
    service.startDaily(1)
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ side: 'local', draft }, 'diario', expect.any(AbortSignal)))
  })

  it('diário de menos de 24 h: não roda; banco fora do ar (sem lado em uso): não roda', async () => {
    await existingDaily(new Date(Date.now() - 3 * 60 * 60 * 1000))
    const recent = make(true)
    const create = vi.spyOn(recent, 'create')
    recent.startDaily(1)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(create).not.toHaveBeenCalled()
    recent.dispose()

    await rm(join(root, 'backups'), { recursive: true, force: true })
    const offline = make(false)
    const createOffline = vi.spyOn(offline, 'create')
    offline.startDaily(1)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(createOffline).not.toHaveBeenCalled()
  })

  it('uma troca/restauração começando cancela o diário em curso (refeito depois)', async () => {
    const service = make(true)
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    vi.spyOn(service, 'create').mockImplementation((_source, _reason, signal) => {
      started()
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new PgToolAbortedError())))
    })
    service.startDaily(1)
    await running
    await service.cancelDaily()
    expect(logs.at(-1)).toMatch(/backup diário: cancelado/)
  })
})
