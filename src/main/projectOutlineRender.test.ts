// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProjectOutline } from './projectOutline'
import {
  docsBudgetFor,
  firstTitle,
  HOOK_CONTEXT_MAX_CHARS,
  MAX_DOCS_CONTEXT_BYTES,
  MIN_DOCS_CONTEXT_BYTES,
  renderOutlineBlock,
  ROOT_BUDGET_MARKER
} from './projectOutlineRender'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('bloco [PROJECT_DOCS_CONTEXT] — cabe no teto do hook (10.000 caracteres), regras inteiras, o resto como índice', () => {
  it('teto padrão de 9 KiB; o marcador não promete um número', () => {
    expect(MAX_DOCS_CONTEXT_BYTES).toBe(9 * 1024)
    expect(HOOK_CONTEXT_MAX_CHARS).toBe(10_000)
    expect(ROOT_BUDGET_MARKER).toBe('[full content omitted: docs context cap]')
  })

  it('docsBudgetFor: docs + memória cabem nos 10.000 caracteres; memória enorme não zera as regras (piso de 2 KiB)', () => {
    expect(docsBudgetFor('')).toBe(MAX_DOCS_CONTEXT_BYTES)
    const lexical = 'm'.repeat(4_300) // o teto do caminho lexical (3 trechos, 4.000 caracteres + cabeçalhos)
    expect(docsBudgetFor(lexical) + lexical.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS)
    expect(docsBudgetFor('m'.repeat(50_000))).toBe(MIN_DOCS_CONTEXT_BYTES)
  })

  it('projeto com AGENTS.md, CLAUDE.md, README.md e 50 docs: regras inteiras, README e docs como índice, abaixo do teto', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-code-outline-render-'))
    dirs.push(cwd)
    const agents = '# agent-code\n\n## Rules\n\n- ALWAYS respond in Portuguese.\n- Keep files under 500 lines.\n'
    await writeFile(join(cwd, 'AGENTS.md'), agents)
    await writeFile(join(cwd, 'CLAUDE.md'), '# Config\n\nRegra só do CLAUDE.md.\n')
    await writeFile(join(cwd, 'README.md'), `# Agent Code\n\n${'texto longo do readme '.repeat(500)}`)
    await mkdir(join(cwd, 'docs', 'specs'), { recursive: true })
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        writeFile(join(cwd, 'docs', 'specs', `spec-${String(i).padStart(2, '0')}.md`), `# Especificação ${i}\n${'corpo '.repeat(300)}`)
      )
    )

    const block = await buildProjectOutline(cwd)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThan(MAX_DOCS_CONTEXT_BYTES)
    expect(block).toContain(`--- PROJECT DOC FILE: AGENTS.md ---\n${agents}\n--- END PROJECT DOC FILE: AGENTS.md ---`)
    expect(block).toContain('--- PROJECT DOC FILE: CLAUDE.md ---')
    expect(block).toContain('Regra só do CLAUDE.md.')
    expect(block).toContain('\nREADME.md — Agent Code\n')
    expect(block).not.toContain('texto longo do readme')
    expect(block).not.toContain('PROJECT DOC FILE: README.md')
    expect(block).toContain('spec-00.md — Especificação 0\n')
    expect(block).toContain('spec-49.md — Especificação 49')
    expect(block).not.toContain('corpo corpo')
    expect(block).not.toContain('PROJECT DOC PREVIEW')
    expect(block).toContain('are an INDEX (path — first title)')
  })

  it('no hook: com a memória lexical cheia, o bloco de docs + memória fica abaixo de 10.000 caracteres e ainda leva AGENTS.md inteiro', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-code-outline-hook-'))
    dirs.push(cwd)
    await writeFile(join(cwd, 'AGENTS.md'), `# Regras\n${'- regra do projeto\n'.repeat(80)}`)
    await mkdir(join(cwd, 'docs'))
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(cwd, 'docs', `d-${i}.md`), `# Documento ${i}\n`)))
    const memory = 'm'.repeat(4_300)
    const block = await buildProjectOutline(cwd, docsBudgetFor(memory))
    expect(`${block}\n\n${memory}`.length).toBeLessThan(HOOK_CONTEXT_MAX_CHARS)
    expect(block).toContain('--- END PROJECT DOC FILE: AGENTS.md ---')
    expect(block).toMatch(/arquivos omitidos/)
  })

  it('o render corta com aviso quando passa do teto e nunca o ultrapassa', () => {
    const entries = Array.from({ length: 2000 }, (_, i) => ({
      path: `docs/a/arquivo-${i}.md`,
      depth: 2,
      kind: 'file' as const,
      title: `Título do arquivo ${i}`
    }))
    const block = renderOutlineBlock(entries)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(MAX_DOCS_CONTEXT_BYTES)
    expect(block).toMatch(/\.\.\. \d+ arquivos omitidos \(e 0 pastas\): teto de 9 KiB do bloco/)
  })

  it('firstTitle: o primeiro título ATX sem os #; sem título, a primeira linha não vazia', () => {
    expect(firstTitle('\n\n## Seção  ##\ncorpo')).toBe('Seção')
    expect(firstTitle('linha solta\n# Depois')).toBe('Depois')
    expect(firstTitle('\n  só texto  \n')).toBe('só texto')
    expect(firstTitle('')).toBeUndefined()
  })
})
