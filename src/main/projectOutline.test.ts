import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocsIndex, buildProjectOutline, extractMarkdownHeadings, MAX_DOCS_CONTEXT_BYTES, MAX_HEADINGS } from './projectOutline'

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

  it('envia Markdown da RAIZ do projeto completo e tudo em docs/ com exatamente as três primeiras linhas físicas', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested', 'empty'), { recursive: true })
    await writeFile(join(cwd, 'A.MD'), '# Principal\n## Detalhe\ncorpo completo da raiz')
    await writeFile(join(cwd, 'docs', 'z.txt'), 'conteúdo que não deve entrar')
    await writeFile(join(cwd, 'docs', 'topo.md'), '# Topo do docs\nlinha 2\nlinha 3\nquarta linha do topo')
    await writeFile(join(cwd, 'docs', 'nested', 'guia.md'), '# Guia interno\n## Passo\nterceira linha\nquarta linha privada')
    await writeFile(join(cwd, 'docs', 'nested', 'b.json'), '{"secret":true}')

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('[PROJECT_DOCS_CONTEXT]')
    expect(outline).toContain('--- PROJECT DOC FILE: A.MD ---\n# Principal\n## Detalhe\ncorpo completo da raiz\n--- END PROJECT DOC FILE: A.MD ---')
    // O topo de docs/ também é aninhado em relação à raiz do projeto.
    expect(outline).toContain('--- PROJECT DOC PREVIEW (first 3 physical lines): docs/topo.md ---\n# Topo do docs\nlinha 2\nlinha 3\n--- END PROJECT DOC PREVIEW: docs/topo.md ---')
    expect(outline).not.toContain('PROJECT DOC FILE: docs/')
    expect(outline).not.toContain('quarta linha do topo')
    expect(outline).toContain('nested/')
    expect(outline).toContain('empty/')
    expect(outline).toContain('--- PROJECT DOC PREVIEW (first 3 physical lines): docs/nested/guia.md ---\n# Guia interno\n## Passo\nterceira linha\n--- END PROJECT DOC PREVIEW: docs/nested/guia.md ---')
    expect(outline).not.toContain('quarta linha privada')
    expect(outline).toContain('b.json [json]')
    expect(outline).toContain('z.txt [text]')
    expect(outline).not.toContain('conteúdo que não deve entrar')
    expect(outline.indexOf('\nA.MD\n')).toBeLessThan(outline.indexOf('\ndocs/\n'))
    expect(await buildProjectOutline(cwd)).toBe(outline)
  })

  it('documento grande em docs/ (como um ARQUITETURA.md de 270 KB) entra só com caminho e três linhas', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'sub'), { recursive: true })
    const grande = `# Arquitetura\nlinha dois\nlinha três\n${'corpo-que-nao-entra '.repeat(14_000)}`
    await writeFile(join(cwd, 'docs', 'ARQUITETURA.md'), grande)
    await writeFile(join(cwd, 'docs', 'sub', 'REFERENCIA.md'), grande)

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('--- PROJECT DOC PREVIEW (first 3 physical lines): docs/ARQUITETURA.md ---\n# Arquitetura\nlinha dois\nlinha três\n--- END')
    expect(outline).toContain('docs/sub/REFERENCIA.md ---')
    expect(outline).not.toContain('corpo-que-nao-entra')
    expect(Buffer.byteLength(outline)).toBeLessThan(4 * 1024)
  })

  it('teto duro do bloco inteiro, com o corte anunciado, mesmo com muitos arquivos', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'specs'), { recursive: true })
    await writeFile(join(cwd, 'README.md'), `# Leia-me\n${'r'.repeat(20 * 1024)}`)
    await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(
      join(cwd, 'docs', 'specs', `spec-${String(i).padStart(3, '0')}.md`),
      `# Spec ${i}\n${'a'.repeat(400)}\n${'b'.repeat(400)}`
    )))

    const outline = await buildProjectOutline(cwd)
    expect(Buffer.byteLength(outline, 'utf8')).toBeLessThanOrEqual(MAX_DOCS_CONTEXT_BYTES)
    expect(outline).toContain('--- PROJECT DOC FILE: README.md ---')
    expect(outline).toMatch(/\.\.\. \d+ arquivos omitidos \(e 0 pastas\): teto de 48 KiB do bloco/)
    expect(outline).toContain('spec-000.md')
    expect(outline).not.toContain('spec-119.md')
    expect(outline.endsWith('[/PROJECT_DOCS_CONTEXT]')).toBe(true)
  })

  it('Markdown da raiz maior que o teto vira marcador + três linhas, e o bloco respeita o teto', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'a-pequeno.md'), '# Pequeno\ncabe inteiro')
    await writeFile(join(cwd, 'b-enorme.md'), `# Enorme\nsegunda\nterceira\n${'x'.repeat(200 * 1024)}`)
    await writeFile(join(cwd, 'c-medio.md'), `# Médio\n${'m'.repeat(40 * 1024)}`)
    await writeFile(join(cwd, 'd-medio.md'), `# Médio 2\n${'n'.repeat(40 * 1024)}`)

    const outline = await buildProjectOutline(cwd)
    expect(Buffer.byteLength(outline, 'utf8')).toBeLessThanOrEqual(MAX_DOCS_CONTEXT_BYTES)
    expect(outline).toContain('--- PROJECT DOC FILE: a-pequeno.md ---\n# Pequeno\ncabe inteiro')
    expect(outline).toContain('b-enorme.md [full content omitted: 48 KiB docs context cap]\n--- PROJECT DOC PREVIEW (first 3 physical lines): b-enorme.md ---\n# Enorme\nsegunda\nterceira\n')
    expect(outline).not.toContain('xxxxxxxxxxxxxxxx')
    // c cabe; d já não cabe no que sobrou e degrada para três linhas.
    expect(outline).toContain('--- PROJECT DOC FILE: c-medio.md ---')
    expect(outline).toContain('d-medio.md [full content omitted: 48 KiB docs context cap]')
    expect(outline).not.toContain('nnnnnnnnnnnnnnnn')
  })

  it('não entra nem percorre o que o .gitignore exclui, nem node_modules/out/dist/_sandbox/pastas ocultas', async () => {
    const cwd = await fixture()
    const pastas = [
      ['docs', 'node_modules', 'pkg'], ['docs', 'out'], ['docs', 'dist'], ['docs', 'build'],
      ['docs', 'spec', 'plano-1', '_sandbox', 'poc', '.venv', 'lib'], ['docs', '.uv-cache', 'x'],
      ['docs', 'bench', 'lora-7b'], ['docs', 'bench', 'keep'], ['docs', 'gerado']
    ]
    for (const p of pastas) await mkdir(join(cwd, ...p), { recursive: true })
    await writeFile(join(cwd, '.gitignore'), '# comentário\ndocs/bench/lora-*/\n/docs/gerado/\n*.log\nSEGREDO.md\n!docs/out/\n')
    await writeFile(join(cwd, 'SEGREDO.md'), '# não deve entrar')
    await writeFile(join(cwd, 'LEIAME.md'), '# entra')
    await writeFile(join(cwd, 'docs', 'node_modules', 'pkg', 'README.md'), '# dependência')
    await writeFile(join(cwd, 'docs', 'out', 'build.md'), '# saída')
    await writeFile(join(cwd, 'docs', 'dist', 'dist.md'), '# dist')
    await writeFile(join(cwd, 'docs', 'build', 'b.md'), '# build')
    await writeFile(join(cwd, 'docs', 'spec', 'plano-1', '_sandbox', 'poc', '.venv', 'lib', 'LICENSE.md'), '# licença')
    await writeFile(join(cwd, 'docs', 'spec', 'plano-1', 'roteiro.md'), '# roteiro')
    await writeFile(join(cwd, 'docs', '.uv-cache', 'x', 'cache.md'), '# cache')
    await writeFile(join(cwd, 'docs', 'bench', 'lora-7b', 'README.md'), '# pesos')
    await writeFile(join(cwd, 'docs', 'bench', 'keep', 'SPEC.md'), '# spec do bench')
    await writeFile(join(cwd, 'docs', 'gerado', 'g.md'), '# gerado')
    await writeFile(join(cwd, 'docs', 'run.log'), 'log')

    const outline = await buildProjectOutline(cwd)
    for (const fora of ['  node_modules/', '  out/', '  dist/', '  build/', '_sandbox', '.venv', '.uv-cache', 'lora-7b', 'gerado', 'run.log', 'SEGREDO', 'dependência', 'licença']) {
      expect(outline).not.toContain(fora)
    }
    expect(outline).toContain('--- PROJECT DOC FILE: LEIAME.md ---')
    expect(outline).toContain('docs/spec/plano-1/roteiro.md ---')
    expect(outline).toContain('docs/bench/keep/SPEC.md ---')
    // O índice do gate usa a mesma varredura e as mesmas regras.
    const index = await buildDocsIndex(cwd)
    expect(index).not.toContain('_sandbox')
    expect(index).not.toContain('lora-7b')
    expect(index).toContain('roteiro.md')
  })

  it('recalcula o índice em cada chamada', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    expect(await buildProjectOutline(cwd)).not.toContain('novo.md')
    await writeFile(join(cwd, 'docs', 'novo.md'), '# Novo')
    expect(await buildProjectOutline(cwd)).toContain('novo.md')
  })

  it('limita preview aninhado cuja primeira linha passa do limite de leitura', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs', 'nested'), { recursive: true })
    const large = `# Início\n${'x'.repeat(70 * 1024)}\n# Depois`
    await writeFile(join(cwd, 'docs', 'nested', 'grande.md'), large)
    await writeFile(join(cwd, 'docs', 'sempre-listado.bin'), Buffer.from([0, 1, 2]))
    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('grande.md [first 3 physical lines exceed 64 KiB read limit]')
    expect(outline).not.toContain('# Depois')
    expect(outline).toContain('sempre-listado.bin [bin]')
  })

  it('arquivo Markdown binário na raiz também consome o orçamento de leitura', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'a-binario.md'), Buffer.alloc(40 * 1024, 0))
    await writeFile(join(cwd, 'b-texto.md'), `# Texto\nlinha 2\nlinha 3\n${'x'.repeat(20 * 1024)}`)

    const outline = await buildProjectOutline(cwd)
    expect(outline).toContain('a-binario.md [binary markdown omitted]')
    expect(outline).toContain('b-texto.md [full content omitted: 48 KiB docs context cap]')
    expect(outline).not.toContain('xxxxxxxxxxxxxxxx')
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
