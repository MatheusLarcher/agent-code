import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocsIndex, buildProjectOutline, extractMarkdownHeadings, MAX_HEADINGS } from './projectOutline'

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

  it('envia Markdown da raiz completo e subpastas com exatamente as três primeiras linhas físicas', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested', 'empty'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'z.txt'), 'conteúdo que não deve entrar')
    await writeFile(join(cwd, 'docs', 'A.MD'), '# Principal\n## Detalhe\ncorpo completo da raiz')
    await writeFile(join(cwd, 'docs', 'nested', 'guia.md'), '# Guia interno\n## Passo\nterceira linha\nquarta linha privada')
    await writeFile(join(cwd, 'docs', 'nested', 'b.json'), '{"secret":true}')

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('[PROJECT_DOCS_CONTEXT]')
    expect(outline).toContain('--- PROJECT DOC FILE: docs/A.MD ---')
    expect(outline).toContain('# Principal\n## Detalhe\ncorpo completo da raiz')
    expect(outline).toContain('nested/')
    expect(outline).toContain('empty/')
    expect(outline).toContain('guia.md')
    expect(outline).toContain('--- PROJECT DOC PREVIEW (first 3 physical lines): docs/nested/guia.md ---\n# Guia interno\n## Passo\nterceira linha\n--- END PROJECT DOC PREVIEW: docs/nested/guia.md ---')
    expect(outline).not.toContain('quarta linha privada')
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

  it('limita preview aninhado sem truncar Markdown da raiz', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested'), { recursive: true })
    const large = `# Início\n${'x'.repeat(70 * 1024)}\n# Depois`
    await writeFile(join(cwd, 'docs', 'completo.md'), large)
    await writeFile(join(cwd, 'docs', 'nested', 'grande.md'), large)
    await writeFile(join(cwd, 'docs', 'sempre-listado.bin'), Buffer.from([0, 1, 2]))
    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('--- PROJECT DOC FILE: docs/completo.md ---')
    expect(outline).toContain('# Depois')
    expect(outline).toContain('grande.md [first 3 physical lines exceed 64 KiB read limit]')
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

/**
 * O índice existe para o gate `noul` responder "isso já está documentado?".
 * Um corte SILENCIOSO ali é pior que um índice curto: o gate lê a lista parcial
 * como se fosse completa e conclui "não está documentado" sobre uma seção que
 * existe — e aí o memorista grava memória do que o docs/ já cobre.
 */
describe('buildDocsIndex — todo corte é anunciado', () => {
  /** Um .md com `count` seções, para estourar o teto por arquivo. */
  function comSecoes(count: number): string {
    return Array.from({ length: count }, (_, i) => `## Secao ${i}`).join('\n\nparágrafo\n\n')
  }

  it('lista as seções e NÃO anuncia corte quando o arquivo cabe', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'curto.md'), comSecoes(MAX_HEADINGS))

    const index = await buildDocsIndex(cwd)

    expect(index).toContain('## Secao 0')
    expect(index).toContain(`## Secao ${MAX_HEADINGS - 1}`)
    expect(index).not.toContain('omitidas)')
  })

  it('arquivo com mais seções que o teto ganha marcador, logo abaixo das que couberam', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'longo.md'), comSecoes(MAX_HEADINGS + 5))

    const index = await buildDocsIndex(cwd)
    const lines = index.split('\n')

    expect(index).toContain(`## Secao ${MAX_HEADINGS - 1}`)
    // A seção 32 não entrou — e é por isso que o marcador precisa existir.
    expect(index).not.toContain(`## Secao ${MAX_HEADINGS}`)
    const marker = lines.findIndex((line) => line.includes(`seções além das ${MAX_HEADINGS} primeiras omitidas`))
    expect(marker).toBeGreaterThan(-1)
    expect(lines[marker - 1]).toContain(`## Secao ${MAX_HEADINGS - 1}`)
  })

  it('um marcador por arquivo: o arquivo curto ao lado do longo continua sem ele', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'a-longo.md'), comSecoes(MAX_HEADINGS + 1))
    await writeFile(join(cwd, 'docs', 'b-curto.md'), '# So uma\n')

    const index = await buildDocsIndex(cwd)
    const lines = index.split('\n')
    const curto = lines.findIndex((line) => line.trim().startsWith('b-curto.md'))

    expect(index.match(/primeiras omitidas/g)).toHaveLength(1)
    // O marcador ficou no arquivo que cortou, não na vizinhança dele.
    expect(lines.slice(curto).join('\n')).not.toContain('primeiras omitidas')
  })

  it('o índice continua sendo o MAPA: caminhos e títulos sim, conteúdo nunca', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested'), { recursive: true })
    await writeFile(join(cwd, 'docs', 'nested', 'guia.md'), '# Guia\n\ncorpo secreto do guia\n\n## Passo')

    const index = await buildDocsIndex(cwd)

    expect(index).toContain('guia.md')
    expect(index).toContain('# Guia')
    expect(index).toContain('## Passo')
    expect(index).not.toContain('corpo secreto do guia')
  })
})
