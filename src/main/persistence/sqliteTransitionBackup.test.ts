import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupSqliteForTransition } from './sqliteTransitionBackup'

describe('backupSqliteForTransition', () => {
  it('copies global/project SQLite sources and writes a hash manifest atomically', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'agent-code-transition-backup-'))
    const data = join(cache, 'data')
    await mkdir(data)
    const globalDb = join(cache, 'agent-code.db')
    await writeFile(globalDb, 'global')
    await writeFile(join(data, 'project.db'), 'project')
    await writeFile(join(data, 'ignore.txt'), 'not a database')

    const manifestPath = await backupSqliteForTransition(
      cache,
      globalDb,
      '00000000-0000-4000-8000-000000000001'
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.sources).toHaveLength(2)
    expect(manifest.sources.every((item: { sha256: string }) => item.sha256.length === 64)).toBe(true)
  })
})
