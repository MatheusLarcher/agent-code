import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDynamicMemoryContext, buildMemoryIndexContext, listMemoryFiles, renderMemoryIndex } from './memoryIndex'

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
})
