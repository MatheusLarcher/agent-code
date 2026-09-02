// @vitest-environment node
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rtkBinDir, pathWithRtk } from './rtk'

const EXE = process.platform === 'win32' ? 'rtk.exe' : 'rtk'

describe('rtk binary resolution', () => {
  let dir = ''
  let empty = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rtk-'))
    empty = mkdtempSync(join(tmpdir(), 'nortk-'))
    writeFileSync(join(dir, EXE), '')
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  })

  it('finds the binary through a PATH entry', () => {
    expect(rtkBinDir({ PATH: [empty, dir].join(delimiter) })).toBe(dir)
  })

  it('returns null when the binary is not installed anywhere', () => {
    // No PATH and no well-known dir — must not fall back to a guess.
    expect(rtkBinDir({ PATH: empty })).toBeNull()
  })

  it('prepends the directory to PATH', () => {
    const next = pathWithRtk({ PATH: [empty, dir].join(delimiter) })
    expect(next).toBe([dir, empty].join(delimiter))
  })

  it('does not duplicate the entry when it is already first', () => {
    expect(pathWithRtk({ PATH: [dir, empty].join(delimiter) })).toBeNull()
  })

  it('leaves PATH alone when rtk is missing', () => {
    expect(pathWithRtk({ PATH: empty })).toBeNull()
  })

  it('survives an unreadable candidate directory', () => {
    const bogus = process.platform === 'win32' ? 'Q:\\nope' : '/proc/nope/nope'
    expect(rtkBinDir({ PATH: [bogus, dir].join(delimiter) })).toBe(dir)
  })
})
