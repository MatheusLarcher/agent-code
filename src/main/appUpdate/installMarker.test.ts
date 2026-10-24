import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeInstallOutcome, readAndClearInstallMarker, writeInstallMarker } from './installMarker'

describe('installMarker', () => {
  const dirs: string[] = []
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ac-marker-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('grava, lê uma vez e apaga', () => {
    const file = join(dir(), 'sub', 'atualizacao-em-curso.json')
    writeInstallMarker(file, '0.2.0', () => new Date('2026-10-24T03:00:00.000Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: '0.2.0', at: '2026-10-24T03:00:00.000Z' })
    expect(readAndClearInstallMarker(file)).toEqual({ version: '0.2.0', at: '2026-10-24T03:00:00.000Z' })
    expect(readAndClearInstallMarker(file)).toBeNull()
  })

  it('ilegível vira null e some; ausente é null', () => {
    const file = join(dir(), 'atualizacao-em-curso.json')
    writeFileSync(file, '{nope', 'utf8')
    expect(readAndClearInstallMarker(file)).toBeNull()
    expect(readAndClearInstallMarker(file)).toBeNull()
  })

  it('a frase do log distingue concluída de não concluída', () => {
    const marker = { version: '0.2.0', at: '2026-10-24T03:00:00.000Z' }
    expect(describeInstallOutcome(marker, '0.2.0')).toContain('concluída')
    expect(describeInstallOutcome(marker, '0.1.145')).toContain('não concluiu')
  })
})
