import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyStorage } from './storageMigration'

describe('storage migration', () => {
  it('moves databases deterministically and preserves sync-only files', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-migration-')), legacy = join(root, 'legacy'), local = join(root, 'local')
    mkdirSync(join(legacy, 'data'), { recursive: true }); writeFileSync(join(legacy, 'agent-code.db'), 'global'); writeFileSync(join(legacy, 'data', 'b.db'), 'b'); writeFileSync(join(legacy, 'data', 'a.db'), 'a'); writeFileSync(join(legacy, 'memories.md'), 'keep')
    const result = migrateLegacyStorage({ legacyRoot: legacy, localRoot: local })
    expect(result.failed).toEqual([]); expect(result.migrated).toEqual(['agent-code.db', 'data/a.db', 'data/b.db']); expect(existsSync(join(legacy, 'memories.md'))).toBe(true); expect(readFileSync(join(local, 'data', 'a.db'), 'utf8')).toBe('a')
  })

  it('creates the local root when no legacy directory exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-migration-')), legacy = join(root, 'absent'), local = join(root, 'local')
    expect(migrateLegacyStorage({ legacyRoot: legacy, localRoot: local })).toEqual({ migrated: [], skipped: [], failed: [] })
    expect(existsSync(local)).toBe(true)
  })

  it('does not accept a partial destination and resumes safely after recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-migration-')), legacy = join(root, 'legacy'), local = join(root, 'local')
    mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, 'agent-code.db'), 'complete')
    mkdirSync(local, { recursive: true }); writeFileSync(join(local, 'agent-code.db'), 'partial')
    writeFileSync(join(local, '.agent-code-migration.json'), JSON.stringify({ complete: false, members: {} }))
    const blocked = migrateLegacyStorage({ legacyRoot: legacy, localRoot: local })
    expect(blocked.failed).toEqual(['agent-code.db'])
    rmSync(join(local, 'agent-code.db'))
    const resumed = migrateLegacyStorage({ legacyRoot: legacy, localRoot: local })
    expect(resumed.failed).toEqual([])
    expect(readFileSync(join(local, 'agent-code.db'), 'utf8')).toBe('complete')
    expect(JSON.parse(readFileSync(join(local, '.agent-code-migration.json'), 'utf8')).complete).toBe(true)
  })
})
