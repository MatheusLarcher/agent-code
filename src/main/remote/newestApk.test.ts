import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newestApk } from './newestApk'

let dir = ''
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

describe('newestApk', () => {
  it('escolhe o APK mais novo da pasta, ignorando outros arquivos', () => {
    dir = mkdtempSync(join(tmpdir(), 'apk-'))
    const old = join(dir, 'agent-remote.apk')
    const neu = join(dir, 'Agent-Remote-0.1.128-release.apk')
    writeFileSync(old, 'a')
    writeFileSync(neu, 'b')
    writeFileSync(join(dir, 'leia.txt'), 'x')
    utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1))
    utimesSync(neu, new Date(2026, 9, 19), new Date(2026, 9, 19))
    expect(newestApk(dir)).toBe(neu)
  })

  it('sem APK (ou sem a pasta) devolve o caminho padrão', () => {
    expect(newestApk(join(tmpdir(), 'nao-existe-apk-xyz'))).toMatch(/agent-remote\.apk$/)
  })
})
