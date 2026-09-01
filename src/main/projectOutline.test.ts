import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProjectOutline, extractMarkdownHeadings } from './projectOutline'

const dirs: string[] = []

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-outline-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('extractMarkdownHeadings', () => {
  it('extrai ATX e Setext sem aceitar headings dentro de fences', () => {
    expect(extractMarkdownHeadings('# Um\n\nDois\n----\n```md\n# Ignorado\n```\n### Três')).toEqual([
      '# Um',
      '## Dois',
      '### Três'
    ])
  })
})

describe('buildProjectOutline', () => {
  it('informa quando docs não existe', async () => {
    const cwd = await fixture()
    expect(await buildProjectOutline(cwd)).toContain('docs/ [not present]')
  })

  it('envia Markdown da raiz completo e subpastas apenas por cabeçalhos', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested', 'empty'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'z.txt'), 'conteúdo que não deve entrar')
    await writeFile(join(cwd, 'docs', 'A.MD'), '# Principal\n## Detalhe\ncorpo completo da raiz')
    await writeFile(join(cwd, 'docs', 'nested', 'guia.md'), '# Guia interno\n## Passo\ncorpo secreto aninhado')
    await writeFile(join(cwd, 'docs', 'nested', 'b.json'), '{"secret":true}')

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('[PROJECT_DOCS_CONTEXT]')
    expect(outline).toContain('--- PROJECT DOC FILE: docs/A.MD ---')
    expect(outline).toContain('# Principal\n## Detalhe\ncorpo completo da raiz')
    expect(outline).toContain('nested/')
    expect(outline).toContain('empty/')
    expect(outline).toContain('guia.md')
    expect(outline).toContain('# Guia interno')
    expect(outline).toContain('## Passo')
    expect(outline).not.toContain('corpo secreto aninhado')
    expect(outline).toContain('b.json [json]')
    expect(outline).toContain('z.txt [text]')
    expect(outline).not.toContain('conteúdo que não deve entrar')
    expect(outline.indexOf('A.MD')).toBeLessThan(outline.indexOf('nested/'))
    expect(await buildProjectOutline(cwd)).toBe(outline)
  })

  it('recalcula o índice em cada chamada', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    expect(await buildProjectOutline(cwd)).not.toContain('novo.md')
    await writeFile(join(cwd, 'docs', 'novo.md'), '# Novo')
    expect(await buildProjectOutline(cwd)).toContain('novo.md')
  })

  it('limita cabeçalhos aninhados, mas não trunca Markdown da raiz', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested'), { recursive: true })
    const large = `# Início\n${'x'.repeat(70 * 1024)}\n# Depois`
    await writeFile(join(cwd, 'docs', 'completo.md'), large)
    await writeFile(join(cwd, 'docs', 'nested', 'grande.md'), large)
    await writeFile(join(cwd, 'docs', 'sempre-listado.bin'), Buffer.from([0, 1, 2]))
    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('--- PROJECT DOC FILE: docs/completo.md ---')
    expect(outline).toContain('# Depois')
    expect(outline).toContain('grande.md [heading metadata limited: first 64 KiB scanned]')
    expect(outline).toContain('sempre-listado.bin [bin]')
  })

  it('marca Markdown da raiz que ultrapassa o teto agregado', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'docs', 'enorme.md'), `# Enorme\n${'x'.repeat(8 * 1024 * 1024)}`)

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('enorme.md [full content omitted: 8 MiB root Markdown budget]')
    expect(outline).not.toContain('xxxxxxxxxxxxxxxx')
  })

  it('arquivo Markdown binário também consome o teto agregado', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'docs', 'a-binario.md'), Buffer.alloc(7 * 1024 * 1024, 0))
    await writeFile(join(cwd, 'docs', 'b-texto.md'), `# Texto\n${'x'.repeat(2 * 1024 * 1024)}`)

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('a-binario.md [binary markdown omitted]')
    expect(outline).toContain('b-texto.md [full content omitted: 8 MiB root Markdown budget]')
  })

  it('lista symlink sem atravessá-lo', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    const outside = join(cwd, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'fora.md'), '# Fora')
    try {
      await symlink(outside, join(cwd, 'docs', 'link'), 'junction')
    } catch {
      return
    }
    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('link [symlink]')
    expect(outline).not.toContain('fora.md')
  })
})
