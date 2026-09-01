import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDynamicMemoryContext,
  buildMemoryIndexContext,
  createMemoryCatalogSnapshot,
  listMemoryFiles,
  memoryCatalogFilesystemVersion,
  renderMemoryCatalog,
  renderMemoryCatalogUpdate,
  renderMemoryIndex
} from './memoryIndex'

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

  it('relê o índice e seleciona somente memória relevante', async () => {
    const dir = await fixture()
    await writeFile(join(dir, '2D', 'erp.md'), '---\ndescription: ERP da 2D usa X\n---\n# ERP da 2D\nO banco exclusivo chama FALCAO.', 'utf8')
    const context = buildDynamicMemoryContext(dir, 'ERP FALCAO')
    expect(context).toContain('Memória relevante: 2D/erp.md')
    expect(context).toContain('FALCAO')
    expect(context).not.toContain('Memória relevante: 2D/nota.md')
  })

  it('pode emitir só os trechos sem repetir o índice', async () => {
    const dir = await fixture()
    const context = buildDynamicMemoryContext(dir, 'ERP 2D', false)
    expect(context).toContain('Memória relevante: 2D/erp.md')
    expect(context).not.toContain('MEMORY.md (índice da raiz)')
  })

  it('índice dinâmico acompanha alteração no disco', async () => {
    const dir = await fixture()
    expect(buildMemoryIndexContext(dir)).not.toContain('Nova memória')
    await mkdir(join(dir, 'nova'))
    await writeFile(join(dir, 'nova', 'fato.md'), '---\ndescription: nova\n---\n# Nova memória', 'utf8')
    expect(buildMemoryIndexContext(dir)).toContain('Nova memória')
  })

  it('ignora memória grande em vez de despejá-la no prompt', async () => {
    const dir = await fixture()
    await writeFile(join(dir, 'grande.md'), `# Gigante\n${'segredo '.repeat(10_000)}`, 'utf8')
    expect(buildDynamicMemoryContext(dir, 'segredo')).not.toContain('Memória relevante: grande.md')
  })

  it('carrega o índice e o conteúdo completo de todas as memórias no catálogo inicial', async () => {
    const dir = await fixture()
    const snapshot = createMemoryCatalogSnapshot(dir)

    expect(snapshot.files.map((file) => file.relPath)).toEqual([
      '2D/erp.md',
      '2D/nota.md',
      'MEMORY.md',
      'raiz.md'
    ])
    expect(snapshot.catalog).toContain('AUTHORITATIVE PERSISTENT MEMORY CATALOG')
    expect(snapshot.catalog).toContain(dir)
    expect(snapshot.catalog).toContain('--- MEMORY FILE: MEMORY.md ---')
    expect(snapshot.catalog).toContain('--- MEMORY FILE: 2D/erp.md ---')
    expect(snapshot.catalog).toContain('ERP da 2D usa X')
    expect(snapshot.catalog).toContain('--- MEMORY FILE: raiz.md ---')
  })

  it('a versão barata acompanha adição, alteração e remoção sem ler o conteúdo', async () => {
    const dir = await fixture()
    const initial = memoryCatalogFilesystemVersion(dir)
    await writeFile(join(dir, 'nova.md'), '# Nova memória com tamanho único', 'utf8')
    const added = memoryCatalogFilesystemVersion(dir)
    expect(added).not.toBe(initial)

    await writeFile(join(dir, 'nova.md'), '# Nova memória alterada e maior que antes', 'utf8')
    const changed = memoryCatalogFilesystemVersion(dir)
    expect(changed).not.toBe(added)

    await rm(join(dir, 'nova.md'))
    expect(memoryCatalogFilesystemVersion(dir)).toBe(initial)
  })

  it('a atualização declara substituição integral do catálogo anterior', async () => {
    const snapshot = createMemoryCatalogSnapshot(await fixture())
    const update = renderMemoryCatalogUpdate(snapshot)
    expect(update).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(update).toContain(snapshot.catalog)
    expect(update).toContain('Replace every earlier persistent-memory')
  })

  it('renderiza de forma explícita um catálogo vazio', () => {
    expect(renderMemoryCatalog([])).toContain('(no persistent memory files are currently available)')
  })

  it('trocar a pasta ativa invalida a versão mesmo com arquivos idênticos', async () => {
    const first = await fixture()
    const second = await fixture()
    expect(memoryCatalogFilesystemVersion(first)).not.toBe(memoryCatalogFilesystemVersion(second))
  })
})
