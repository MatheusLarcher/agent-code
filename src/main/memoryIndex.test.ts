import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMemoryFiles, renderMemoryIndex } from './memoryIndex'

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'))
  await writeFile(join(dir, 'MEMORY.md'), '# Memórias\n\n- [Raiz](raiz.md) — na raiz\n', 'utf8')
  await writeFile(join(dir, 'raiz.md'), '---\ndescription: fato solto\n---\n# Raiz\n', 'utf8')
  await mkdir(join(dir, '2D'))
  await writeFile(join(dir, '2D', 'erp.md'), '---\ndescription: ERP da 2D usa X\n---\n# ERP da 2D\n', 'utf8')
  await writeFile(join(dir, '2D', 'nota.md'), '# Nota fiscal\n', 'utf8')
  return dir
}

describe('memoryIndex', () => {
  it('varre subpastas e guarda o grupo de cada memória', async () => {
    const files = listMemoryFiles(await fixture())
    expect(files.map((f) => f.relPath)).toEqual(['2D/erp.md', '2D/nota.md', 'raiz.md'])
    expect(files.find((f) => f.relPath === '2D/erp.md')?.folders).toEqual(['2D'])
    expect(files.find((f) => f.relPath === 'raiz.md')?.folders).toEqual([])
  })

  it('não trata o MEMORY.md da raiz como memória', async () => {
    expect(listMemoryFiles(await fixture()).some((f) => f.relPath === 'MEMORY.md')).toBe(false)
  })

  it('o bloco do prompt nomeia a pasta e lista os cabeçalhos dela', async () => {
    const dir = await fixture()
    const block = renderMemoryIndex(dir, '# Memórias\n\n- [Raiz](raiz.md) — na raiz')
    expect(block).toContain('- [Raiz](raiz.md) — na raiz') // índice da raiz preservado
    expect(block).toContain('--- Pasta "2D" (memórias sobre 2D) ---')
    expect(block).toContain('- [ERP da 2D](2D/erp.md) — ERP da 2D usa X')
    expect(block).toContain('- [Nota fiscal](2D/nota.md)') // sem description, cai no padrão
  })

  it('sem subpasta, o bloco é só o índice da raiz', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-'))
    expect(renderMemoryIndex(dir, '# Memórias')).toBe('--- MEMORY.md (índice da raiz) ---\n# Memórias')
  })

  it('pasta inexistente não explode', () => {
    expect(listMemoryFiles(join(tmpdir(), 'nao-existe-mem-xyz'))).toEqual([])
  })
})
