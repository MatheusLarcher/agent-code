import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { listMockups, openMockup } from './planningMockups'
import { setPlanningDataRoot } from './planningRoot'

let cwd: string

function put(rel: string, when: number): string {
  const file = path.join(cwd, 'docs', 'spec', 'plano-a', rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '<html></html>')
  utimesSync(file, when, when)
  return file
}

beforeEach(() => {
  setPlanningDataRoot(null)
  cwd = mkdtempSync(path.join(os.tmpdir(), 'mockups-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe('planningMockups', () => {
  it('lista os .html do _sandbox e de midia/, o mais novo primeiro', async () => {
    put('_sandbox/velho.html', 1000)
    put('_sandbox/telas/novo.htm', 3000)
    put('midia/painel.html', 2000)
    put('_sandbox/script.mjs', 4000)
    put('_sandbox/node_modules/x/index.html', 5000)
    const list = await listMockups(cwd, 'plano-a')
    expect(list.map((m) => [m.origem, m.rel])).toEqual([
      ['sandbox', 'telas/novo.htm'],
      ['midia', 'painel.html'],
      ['sandbox', 'velho.html']
    ])
  })

  it('plano sem pastas = lista vazia', async () => {
    expect(await listMockups(cwd, 'plano-a')).toEqual([])
  })

  it('só abre arquivo que está na lista do plano', async () => {
    const file = put('_sandbox/tela.html', 1000)
    const open = vi.fn(async () => undefined)
    expect(await openMockup(cwd, 'plano-a', file, open)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(file)

    const fora = path.join(cwd, 'fora.html')
    writeFileSync(fora, '<html></html>')
    const res = await openMockup(cwd, 'plano-a', fora, open)
    expect(res.ok).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
