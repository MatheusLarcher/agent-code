import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSyncData } from './storageMigration'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('sync-root switching', () => {
  it('moves only memories and skills despite unrelated local files', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-store-'))
    roots.push(root)
    const from = join(root, 'from'), target = join(root, 'target')
    mkdirSync(join(from, 'memories'), { recursive: true })
    mkdirSync(join(from, 'skills'), { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(from, 'memories', 'fact.md'), 'memory', { flag: 'w' })
    writeFileSync(join(from, 'skills', 'skill.md'), 'skill', { flag: 'w' })
    writeFileSync(join(from, 'agent-code.db'), 'database')
    writeFileSync(join(target, 'unrelated.db'), 'local database')

    moveSyncData(from, target)

    expect(readFileSync(join(target, 'memories', 'fact.md'), 'utf8')).toBe('memory')
    expect(readFileSync(join(target, 'skills', 'skill.md'), 'utf8')).toBe('skill')
    expect(existsSync(join(target, 'agent-code.db'))).toBe(false)
  })
})
