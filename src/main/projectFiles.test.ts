import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listProjectDir, PROJECT_DIR_MAX, safeRelDir } from './projectFiles'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pf-'))
  for (const d of ['src', 'node_modules', '.git', 'dist', 'Zeta', 'alpha', 'big', 'empty']) await mkdir(join(root, d))
  for (const f of ['b.ts', 'A.md', '.env', 'dist.txt']) await writeFile(join(root, f), 'x')
  await writeFile(join(root, 'src', 'main.ts'), 'x')
  await mkdir(join(root, 'src', 'deep'))
  for (let i = 0; i < PROJECT_DIR_MAX + 3; i++) await writeFile(join(root, 'big', `f${i}.txt`), '')
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('safeRelDir', () => {
  it('normaliza barras e recusa absoluto/..', () => {
    expect(safeRelDir('')).toBe('')
    expect(safeRelDir('src\\deep/')).toBe('src/deep')
    expect(safeRelDir('./src')).toBe('src')
    for (const bad of ['..', 'src/../..', 'a/../b', '/etc', 'C:\\Windows', 'c:/x', 42, null]) expect(safeRelDir(bad)).toBeNull()
  })
})

describe('listProjectDir', () => {
  it('raiz: pastas antes de arquivos, ordem alfabética, sem as ignoradas', async () => {
    const r = await listProjectDir(root, '')
    expect(r.error).toBeNull()
    expect(r.entries.map((e) => `${e.isDir ? 'd' : 'f'}:${e.path}`)).toEqual(['d:alpha', 'd:big', 'd:empty', 'd:src', 'd:Zeta', 'f:.env', 'f:A.md', 'f:b.ts', 'f:dist.txt'])
    expect(r.truncated).toBe(false)
  })

  it('subpasta: caminhos relativos com barra normal', async () => {
    const r = await listProjectDir(root, 'src')
    expect(r.entries).toEqual([
      { path: 'src/deep', name: 'deep', isDir: true },
      { path: 'src/main.ts', name: 'main.ts', isDir: false }
    ])
  })

  it('pasta vazia e teto de entradas', async () => {
    expect(await listProjectDir(root, 'empty')).toEqual({ entries: [], truncated: false, error: null })
    const big = await listProjectDir(root, 'big')
    expect([big.entries.length, big.truncated]).toEqual([PROJECT_DIR_MAX, true])
  })

  it('recusa escapar do root e root inválido, sem lançar', async () => {
    for (const rel of ['..', '../x', 'src/../../x', join(root, 'src'), '/']) {
      const r = await listProjectDir(root, rel)
      expect([r.entries, r.error]).toEqual([[], 'Caminho fora da pasta do projeto.'])
    }
    expect((await listProjectDir('relativo', '')).error).toBe('Pasta do projeto inválida.')
    expect((await listProjectDir('', '')).error).toBe('Pasta do projeto inválida.')
    expect((await listProjectDir(join(root, 'nao-existe'), '')).error).toBe('A pasta do projeto não existe.')
  })

  it('erro de leitura vira mensagem', async () => {
    expect((await listProjectDir(root, 'sumiu')).error).toBe('A pasta não existe mais.')
    expect((await listProjectDir(root, 'b.ts')).error).toBe('Não é uma pasta.')
  })
})
