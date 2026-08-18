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

  it('lista recursivamente arquivos, subpastas vazias e headings em ordem estável', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested', 'empty'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'z.txt'), 'conteúdo que não deve entrar')
    await writeFile(join(cwd, 'docs', 'A.MD'), '# Principal\n## Detalhe\ncorpo secreto')
    await writeFile(join(cwd, 'docs', 'nested', 'b.json'), '{"secret":true}')

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('docs/')
    expect(outline).toContain('A.MD')
    expect(outline).toContain('# Principal')
    expect(outline).toContain('## Detalhe')
    expect(outline).toContain('nested/')
    expect(outline).toContain('empty/')
    expect(outline).toContain('b.json [json]')
    expect(outline).toContain('z.txt [text]')
    expect(outline).not.toContain('corpo secreto')
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

  it('limita leitura de heading sem omitir caminhos', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'docs', 'grande.md'), `# Início\n${'x'.repeat(70 * 1024)}\n# Depois`)
    await writeFile(join(cwd, 'docs', 'sempre-listado.bin'), Buffer.from([0, 1, 2]))
    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('grande.md [heading metadata limited: first 64 KiB scanned]')
    expect(outline).toContain('sempre-listado.bin [bin]')
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
