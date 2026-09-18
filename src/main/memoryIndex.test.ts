import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDynamicMemoryContext,
  buildMemoryIndexContext,
  createMemoryCatalogSnapshot,
  listMemoryFiles,
  memoryCatalogFilesystemVersion,
  MIN_LEXICAL_SCORE,
  rankMemoriesByQuery,
  readMemoryBody,
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

  it('redige referências e atribuições de segredo nos excertos automáticos', async () => {
    const dir = await fixture()
    await writeFile(join(dir, 'raiz.md'), '# Credencial ERP\napi_key: valor-real-nunca-vaza\n{{secret:erp-token}}', 'utf8')

    const context = buildDynamicMemoryContext(dir, 'credencial ERP raiz', false)
    expect(context).toContain('Memória relevante: raiz.md')
    expect(context).toContain('api_key: [redacted]')
    expect(context).toContain('[secret reference withheld]')
    expect(context).not.toContain('valor-real-nunca-vaza')
    expect(context).not.toContain('{{secret:erp-token}}')
  })

  it('carrega apenas MEMORY.md e referencia a pasta para leitura sob demanda', async () => {
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
    expect(snapshot.catalog).not.toContain('--- MEMORY FILE: 2D/erp.md ---')
    expect(snapshot.catalog).not.toContain('ERP da 2D usa X')
    expect(snapshot.catalog).not.toContain('--- MEMORY FILE: raiz.md ---')
    expect(snapshot.catalog).toContain('read them from the configured memories directory')
    expect(snapshot.filesystemVersion).toBe(memoryCatalogFilesystemVersion(dir))
  })

  it('redige marcadores de segredo do catálogo inicial e da substituição sem perder o índice útil', async () => {
    const dir = await fixture()
    await writeFile(
      join(dir, 'MEMORY.md'),
      '# Preferências\n\n- [ERP](raiz.md) — usar fluxo real\nToken no cofre: {{secret:erp-token}}',
      'utf8'
    )

    const snapshot = createMemoryCatalogSnapshot(dir)
    const update = renderMemoryCatalogUpdate(snapshot)
    for (const prompt of [snapshot.catalog, update]) {
      expect(prompt).toContain('- [ERP](raiz.md) — usar fluxo real')
      expect(prompt).toContain('[secret reference withheld]')
      expect(prompt).not.toMatch(/\{\{secret:/iu)
      expect(prompt).not.toContain('erp-token')
    }
  })

  it('a versão por conteúdo acompanha adição, alteração e remoção', async () => {
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

  it('detecta troca de conteúdo com o mesmo tamanho e timestamp', async () => {
    const dir = await fixture()
    const file = join(dir, 'raiz.md')
    await writeFile(file, '# Valor AAAA\n', 'utf8')
    const metadata = await stat(file)
    const before = memoryCatalogFilesystemVersion(dir)

    await writeFile(file, '# Valor BBBB\n', 'utf8')
    await utimes(file, metadata.atime, metadata.mtime)

    expect(memoryCatalogFilesystemVersion(dir)).not.toBe(before)
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

  it('o ranqueamento lexical ordena todas as candidatas — o seletor do TypeSafe usa o mesmo', async () => {
    const dir = await fixture()
    await writeFile(join(dir, '2D', 'erp.md'), '---\ndescription: ERP da 2D usa X\n---\n# ERP da 2D\nO banco chama FALCAO.', 'utf8')

    const ranked = rankMemoriesByQuery(dir, 'ERP FALCAO')

    expect(ranked[0].file.relPath).toBe('2D/erp.md')
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_LEXICAL_SCORE)
    // Diferente do caminho de excertos, aqui nada é filtrado: o pré-filtro das
    // >255 candidatas precisa de uma ordem sobre a lista inteira.
    expect(ranked.map((match) => match.file.relPath).sort()).toEqual(['2D/erp.md', '2D/nota.md', 'raiz.md'])
  })

  it('sem palavra aproveitável na mensagem, o ranqueamento é vazio', async () => {
    expect(rankMemoriesByQuery(await fixture(), 'a de o')).toEqual([])
  })

  it('readMemoryBody devolve o arquivo INTEIRO e atual, redigido', async () => {
    const dir = await fixture()
    const corpo = `# Longa\n${'linha de conteúdo. '.repeat(300)}\napi_key: nunca-vaza\n`
    await writeFile(join(dir, 'raiz.md'), corpo, 'utf8')

    const body = readMemoryBody(dir, 'raiz.md')

    expect(body!.length).toBeGreaterThan(1_600)
    expect(body).toContain('api_key: [redacted]')
    expect(body).not.toContain('nunca-vaza')
  })

  it('readMemoryBody recusa caminho fora da pasta, arquivo ausente e arquivo grande demais', async () => {
    const dir = await fixture()
    await writeFile(join(dir, 'grande.md'), `# Gigante\n${'x '.repeat(40_000)}`, 'utf8')

    expect(readMemoryBody(dir, '../segredo.md')).toBeNull()
    expect(readMemoryBody(dir, 'nao-existe.md')).toBeNull()
    expect(readMemoryBody(dir, 'grande.md')).toBeNull()
  })
})
