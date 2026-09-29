import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// store.ts puxa node:sqlite e electron; aqui só a pasta local importa.
vi.mock('./store', () => ({ getCacheInfo: () => ({ localDir: 'C:\\local' }) }))

import { createSandboxDirIn, isInsideSandbox, sandboxDirName, sandboxRoot } from './sandbox'

describe('sandboxRoot', () => {
  it('fica em <localDir>\\sandbox', () => {
    expect(sandboxRoot()).toMatch(/local[\\/]sandbox$/)
  })
})

describe('sandboxDirName', () => {
  it('usa AAAA-MM-DD_HH-MM_<4 hex>', () => {
    const name = sandboxDirName(new Date(2026, 8, 29, 7, 5), () => 'a1b2')
    expect(name).toBe('2026-09-29_07-05_a1b2')
  })

  it('o sufixo aleatório padrão tem 4 hex e varia', () => {
    const now = new Date(2026, 0, 1, 0, 0)
    const names = new Set(Array.from({ length: 20 }, () => sandboxDirName(now)))
    for (const n of names) expect(n).toMatch(/^2026-01-01_00-00_[0-9a-f]{4}$/)
    expect(names.size).toBeGreaterThan(1)
  })
})

describe('isInsideSandbox', () => {
  const root = 'C:\\Users\\x\\AppData\\agent-code-local\\sandbox'

  it('subpasta conta', () => {
    expect(isInsideSandbox(root, `${root}\\2026-09-29_07-05_a1b2`)).toBe(true)
  })
  it('a própria raiz não conta', () => {
    expect(isInsideSandbox(root, root)).toBe(false)
    expect(isInsideSandbox(root, `${root}\\`)).toBe(false)
  })
  it('fora não conta, nem prefixo parecido', () => {
    expect(isInsideSandbox(root, 'C:\\GitHub\\agent-code')).toBe(false)
    expect(isInsideSandbox(root, `${root}-2\\a`)).toBe(false)
  })
  it('caixa diferente conta no Windows', () => {
    const upper = `${root.toUpperCase()}\\ABC`
    expect(isInsideSandbox(root, upper)).toBe(process.platform === 'win32')
  })
  it('.. que sai da raiz não conta', () => {
    expect(isInsideSandbox(root, `${root}\\a\\..\\..\\fora`)).toBe(false)
    expect(isInsideSandbox(root, `${root}\\a\\..`)).toBe(false)
  })
  it('vazio não conta', () => {
    expect(isInsideSandbox(root, '')).toBe(false)
  })
})

describe('createSandboxDirIn', () => {
  let base = ''
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true })
  })

  it('cria a raiz e a subpasta de forma recursiva e devolve o caminho absoluto', async () => {
    base = await mkdtemp(join(tmpdir(), 'sbx-'))
    const root = join(base, 'nao', 'existe', 'sandbox')
    const path = await createSandboxDirIn(root, new Date(2026, 8, 29, 10, 30))
    expect(path.startsWith(root)).toBe(true)
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(isInsideSandbox(root, path)).toBe(true)
  })

  it('duas criações no mesmo minuto dão pastas diferentes', async () => {
    base = await mkdtemp(join(tmpdir(), 'sbx-'))
    const now = new Date(2026, 8, 29, 10, 30)
    const a = await createSandboxDirIn(base, now)
    const b = await createSandboxDirIn(base, now)
    expect(a).not.toBe(b)
  })
})
