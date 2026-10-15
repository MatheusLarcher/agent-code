// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disposeMemoryFileCache,
  memoryFileIndex,
  memoryFileIndexVersion,
  SMALL_TREE_MAX_FILES,
  warmMemoryFileCache
} from './memoryFileCache'
import { listMemoryFiles, memoryCatalogFilesystemVersion, rankMemoriesByQuery, readMemoryBody } from '../memoryIndex'

const dirs: string[] = []

afterEach(async () => {
  disposeMemoryFileCache()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const name = (i: number): string => `m${String(i).padStart(4, '0')}.md`

/** Uma árvore GRANDE (acima do teto da revarredura síncrona): quem a mantém é o vigia. */
async function bigTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-cache-'))
  dirs.push(dir)
  await writeFile(join(dir, 'MEMORY.md'), '# Memórias\n', 'utf8')
  await mkdir(join(dir, '2D'))
  await writeFile(join(dir, '2D', 'erp.md'), '---\ndescription: ERP da 2D usa FALCAO\n---\n# ERP da 2D\ncorpo\n', 'utf8')
  for (let i = 0; i < SMALL_TREE_MAX_FILES + 20; i++) {
    await writeFile(join(dir, name(i)), `---\ndescription: assunto ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
  }
  return dir
}

/** O índice acompanha o disco em até ~2 s — sem ninguém pedir para reler. */
const within2s = { timeout: 2_000, interval: 25 }

describe('memoryFileCache', () => {
  it('árvore grande: o índice fica com o vigia e responde do que já leu', async () => {
    const dir = await bigTree()
    const index = memoryFileIndex(dir)

    expect(index.watched).toBe(true)
    expect(index.rootExists).toBe(true)
    expect(index.files).toHaveLength(SMALL_TREE_MAX_FILES + 22)
    // Ordem da varredura, como a leitura direta: pasta "2D" antes de "MEMORY.md" e "m0000.md".
    expect(index.files.slice(0, 3).map((file) => file.relPath)).toEqual(['2D/erp.md', 'm0000.md', 'm0001.md'])
    // Sem mudança no disco, a mesma geração volta — os derivados não são refeitos.
    expect(memoryFileIndex(dir)).toBe(index)
    expect(listMemoryFiles(dir).map((file) => file.relPath)).not.toContain('MEMORY.md')
  })

  it('editar uma memória aparece no índice em até ~2 s', async () => {
    const dir = await bigTree()
    const before = memoryCatalogFilesystemVersion(dir)
    expect(readMemoryBody(dir, '2D/erp.md')).toContain('corpo')

    await writeFile(join(dir, '2D', 'erp.md'), '---\ndescription: ERP da 2D usa GAVIAO\n---\n# ERP novo\ntexto trocado\n', 'utf8')

    await vi.waitFor(() => expect(readMemoryBody(dir, '2D/erp.md')).toContain('texto trocado'), within2s)
    expect(listMemoryFiles(dir).find((file) => file.relPath === '2D/erp.md')).toMatchObject({ title: 'ERP novo', hook: 'ERP da 2D usa GAVIAO' })
    expect(rankMemoriesByQuery(dir, 'gaviao', listMemoryFiles(dir))[0]!.file.relPath).toBe('2D/erp.md')
    expect(memoryCatalogFilesystemVersion(dir)).not.toBe(before)
  })

  it('criar uma memória aparece no índice em até ~2 s', async () => {
    const dir = await bigTree()
    expect(listMemoryFiles(dir).map((file) => file.relPath)).not.toContain('2D/nova.md')

    await writeFile(join(dir, '2D', 'nova.md'), '# Nova\nrecém criada\n', 'utf8')

    await vi.waitFor(() => expect(listMemoryFiles(dir).map((file) => file.relPath)).toContain('2D/nova.md'), within2s)
    expect(readMemoryBody(dir, '2D/nova.md')).toBe('# Nova\nrecém criada')
  })

  it('apagar uma memória some do índice em até ~2 s', async () => {
    const dir = await bigTree()
    expect(readMemoryBody(dir, name(3))).not.toBeNull()

    await unlink(join(dir, name(3)))

    await vi.waitFor(() => expect(listMemoryFiles(dir).map((file) => file.relPath)).not.toContain(name(3)), within2s)
    expect(readMemoryBody(dir, name(3))).toBeNull()
  })

  it('troca de conteúdo com o mesmo tamanho e timestamp também chega (o vigia força a releitura)', async () => {
    const dir = await bigTree()
    const file = join(dir, name(7))
    const metadata = await stat(file)
    const before = memoryCatalogFilesystemVersion(dir)

    await writeFile(file, `---\ndescription: assunto X\n---\n# MX\ncorpo X\n`, 'utf8')
    await utimes(file, metadata.atime, metadata.mtime)

    await vi.waitFor(() => expect(memoryCatalogFilesystemVersion(dir)).not.toBe(before), within2s)
    expect(readMemoryBody(dir, name(7))).toContain('corpo X')
  })

  it('aquecimento assíncrono: monta o índice sem leitura síncrona e a consulta seguinte é a mesma geração', async () => {
    const dir = await bigTree()

    const warmed = await warmMemoryFileCache(dir)

    expect(warmed.files).toHaveLength(SMALL_TREE_MAX_FILES + 22)
    expect(memoryFileIndex(dir)).toBe(warmed)
    // A assinatura já sai pronta e é a mesma de uma leitura síncrona do zero.
    const version = memoryFileIndexVersion(warmed)
    disposeMemoryFileCache(dir)
    expect(memoryCatalogFilesystemVersion(dir)).toBe(version)
  })

  it('árvore pequena: gravar e consultar em seguida enxerga a mudança na hora', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-cache-small-'))
    dirs.push(dir)
    await writeFile(join(dir, 'a.md'), '# A\n', 'utf8')
    expect(memoryFileIndex(dir).watched).toBe(false)
    expect(listMemoryFiles(dir).map((file) => file.relPath)).toEqual(['a.md'])

    await writeFile(join(dir, 'b.md'), '# B\n', 'utf8')
    expect(listMemoryFiles(dir).map((file) => file.relPath)).toEqual(['a.md', 'b.md'])
  })

  it('pasta inexistente não explode e não tem raiz', () => {
    const index = memoryFileIndex(join(tmpdir(), 'mem-cache-nao-existe-' + Date.now()))
    expect(index.rootExists).toBe(false)
    expect(index.files).toEqual([])
  })
})
