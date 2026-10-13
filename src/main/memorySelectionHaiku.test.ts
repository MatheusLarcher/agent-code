import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseTurnMemories,
  HAIKU_MEMORY_CANDIDATES,
  HAIKU_MEMORY_MODEL,
  InjectedMemoryLedger,
  narrowHaikuCandidates,
  parseHaikuMemoryChoice,
  selectMemoriesWithHaiku,
  type MemoryQuery
} from './memorySelectionHaiku'
import { listMemoryFiles } from './memoryIndex'

async function memories(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-haiku-'))
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, 'utf8')
  return dir
}

/** Um `query` falso que responde `text` e guarda o que recebeu. */
function fakeQuery(text: string): { run: MemoryQuery; seen: Array<{ prompt: string; options: Record<string, unknown> }> } {
  const seen: Array<{ prompt: string; options: Record<string, unknown> }> = []
  const run: MemoryQuery = ({ prompt, options }) =>
    (async function* () {
      for await (const message of prompt) {
        const content = (message.message as { content: Array<{ text: string }> }).content
        seen.push({ prompt: content.map((block) => block.text).join(''), options: options as Record<string, unknown> })
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }
      yield { type: 'result', is_error: false }
    })()
  return { run, seen }
}

const base = {
  'deploy.md': '---\ndescription: como publicar o app\n---\n# Deploy\nRode npm run package:portable.',
  'banco.md': '---\ndescription: senha do banco\n---\n# Banco\npassword: hunter2\nPostgres na porta 5433.',
  'cafe.md': '# Café\nO usuário gosta de café coado.'
}

describe('parseHaikuMemoryChoice', () => {
  it('lê o primeiro objeto JSON, com texto e cerca em volta', () => {
    expect(parseHaikuMemoryChoice('Claro:\n```json\n{"memorias":["a.md","b/c.md"]}\n```')).toEqual(['a.md', 'b/c.md'])
    expect(parseHaikuMemoryChoice('{"memorias":[]}')).toEqual([])
    expect(parseHaikuMemoryChoice('{"nota":"chave } dentro"} {"memorias":["x.md"]}')).toBeNull()
  })

  it('lixo, JSON quebrado ou sem a lista é null (sem decisão)', () => {
    expect(parseHaikuMemoryChoice('não sei')).toBeNull()
    expect(parseHaikuMemoryChoice('{"memorias": ["a.md"')).toBeNull()
    expect(parseHaikuMemoryChoice('{"outra":["a.md"]}')).toBeNull()
    expect(parseHaikuMemoryChoice('{"memorias":"a.md"}')).toBeNull()
  })

  it('descarta itens que não são texto', () => {
    expect(parseHaikuMemoryChoice('{"memorias":["a.md",3,null]}')).toEqual(['a.md'])
  })
})

describe('selectMemoriesWithHaiku', () => {
  it('JSON válido: devolve as escolhidas inteiras, relidas do disco e redigidas', async () => {
    const dir = await memories(base)
    const { run, seen } = fakeQuery('{"memorias":["deploy.md","banco.md"]}')
    const chosen = await selectMemoriesWithHaiku(dir, 'como publico e qual a porta do banco?', { query: run })
    expect(chosen?.relPaths).toEqual(['deploy.md', 'banco.md'])
    expect(chosen?.block).toContain('--- Memória relevante: deploy.md ---\n---\ndescription: como publicar o app')
    expect(chosen?.block).toContain('Rode npm run package:portable.')
    expect(chosen?.block).toContain('password: [redacted]')
    expect(chosen?.block).not.toContain('hunter2')
    // O Haiku vê só os cabeçalhos — nunca o corpo.
    expect(seen).toHaveLength(1)
    expect(seen[0].prompt).toContain('- deploy.md: Deploy — como publicar o app')
    expect(seen[0].prompt).not.toContain('package:portable')
    expect(seen[0].prompt).not.toContain('5433')
    expect(seen[0].options).toMatchObject({ model: HAIKU_MEMORY_MODEL, tools: [], maxTurns: 1, persistSession: false })
  })

  it('lista vazia é decisão: bloco vazio, não null', async () => {
    const dir = await memories(base)
    const chosen = await selectMemoriesWithHaiku(dir, 'oi', { query: fakeQuery('{"memorias":[]}').run })
    expect(chosen).toEqual({ block: '', relPaths: [], entries: [] })
  })

  it('resposta sem JSON é null: o chamador cai na busca lexical', async () => {
    const dir = await memories(base)
    expect(await selectMemoriesWithHaiku(dir, 'deploy', { query: fakeQuery('Acho que deploy.md serve.').run })).toBeNull()
  })

  it('caminho inventado ou fora da pasta é descartado', async () => {
    const dir = await memories(base)
    const { run } = fakeQuery('{"memorias":["inventada.md","../fora.md","cafe.md"]}')
    const chosen = await selectMemoriesWithHaiku(dir, 'café', { query: run })
    expect(chosen?.relPaths).toEqual(['cafe.md'])
    expect(chosen?.block).not.toContain('inventada')
  })

  it('tempo esgotado é null e aborta a chamada', async () => {
    const dir = await memories(base)
    let signal: AbortSignal | undefined
    const run: MemoryQuery = ({ options }) => {
      signal = options.abortController?.signal
      return (async function* () {
        await new Promise(() => {})
      })()
    }
    expect(await selectMemoriesWithHaiku(dir, 'deploy', { query: run, timeoutMs: 20 })).toBeNull()
    expect(signal?.aborted).toBe(true)
  })

  it('erro do SDK ou exceção do query é null, nunca lança', async () => {
    const dir = await memories(base)
    const failing: MemoryQuery = () =>
      (async function* () {
        yield { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: '{"memorias":["cafe.md"]}' }] } }
      })()
    expect(await selectMemoriesWithHaiku(dir, 'café', { query: failing })).toBeNull()
    const throwing: MemoryQuery = () => {
      throw new Error('sem login')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await selectMemoriesWithHaiku(dir, 'café', { query: throwing })).toBeNull()
  })

  it('teto de 50.000 caracteres: a memória que estoura é pulada inteira', async () => {
    const dir = await memories({
      'a.md': `# A\n${'a'.repeat(30_000)}`,
      'b.md': `# B\n${'b'.repeat(30_000)}`,
      'c.md': `# C\n${'c'.repeat(1_000)}`
    })
    const chosen = await selectMemoriesWithHaiku(dir, 'tudo', { query: fakeQuery('{"memorias":["a.md","b.md","c.md"]}').run })
    expect(chosen?.relPaths).toEqual(['a.md', 'c.md'])
    expect(chosen!.block.length).toBeLessThanOrEqual(50_000)
    expect(chosen?.block).toContain('a'.repeat(30_000))
  })

  it('no máximo 10, mesmo que o Haiku peça mais', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`m${i}.md`] = `# M${i}\ncorpo ${i}`
    const dir = await memories(files)
    const picked = Object.keys(files).sort()
    const chosen = await selectMemoriesWithHaiku(dir, 'tudo', { query: fakeQuery(JSON.stringify({ memorias: picked })).run })
    expect(chosen?.relPaths).toEqual(picked.slice(0, 10))
  })

  it('pasta vazia ou mensagem vazia não chama o modelo', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mem-haiku-'))
    const run = vi.fn(fakeQuery('{"memorias":[]}').run)
    expect(await selectMemoriesWithHaiku(empty, 'deploy', { query: run })).toEqual({ block: '', relPaths: [], entries: [] })
    expect(await selectMemoriesWithHaiku(await memories(base), '   ', { query: run })).toEqual({ block: '', relPaths: [], entries: [] })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('narrowHaikuCandidates', () => {
  it('abaixo do teto vão TODAS: memória sem palavra em comum com a mensagem também chega ao Haiku', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 70; i++) files[`m${String(i).padStart(2, '0')}.md`] = `# Nota ${i}\ntexto`
    files['zz-gerar-exe.md'] = '# Sempre gerar o instalador\nao terminar mudanças'
    const dir = await memories(files)
    const narrowed = narrowHaikuCandidates(dir, 'terminei de alterar o app', listMemoryFiles(dir))
    expect(HAIKU_MEMORY_CANDIDATES).toBeGreaterThanOrEqual(1_000)
    expect(narrowed).toHaveLength(71)
    expect(narrowed.map((f) => f.relPath)).toContain('zz-gerar-exe.md')
  })
})

describe('InjectedMemoryLedger / chooseTurnMemories', () => {
  it('a mesma memória, igual, não vai duas vezes; editada, volta', () => {
    const ledger = new InjectedMemoryLedger()
    expect(ledger.admit([{ relPath: 'a.md', body: 'um' }])).toBe('--- Memória relevante: a.md ---\num')
    expect(ledger.admit([{ relPath: 'a.md', body: 'um' }])).toBe('')
    expect(ledger.admit([{ relPath: 'a.md', body: 'dois' }])).toContain('dois')
    ledger.reset()
    expect(ledger.admit([{ relPath: 'a.md', body: 'dois' }])).toContain('dois')
  })

  it('Haiku decidiu: usa a escolha; relPaths do turno incluem a repetida', async () => {
    const dir = await memories(base)
    const ledger = new InjectedMemoryLedger()
    const select = async (d: string, q: string) => selectMemoriesWithHaiku(d, q, { query: fakeQuery('{"memorias":["cafe.md"]}').run })
    const first = await chooseTurnMemories(dir, 'café', ledger, select)
    expect(first.block).toContain('Memória relevante: cafe.md')
    const second = await chooseTurnMemories(dir, 'café de novo', ledger, select)
    expect(second).toEqual({ block: '', relPaths: ['cafe.md'] })
  })

  it('Haiku decidiu zero: não compensa com a busca lexical', async () => {
    const dir = await memories(base)
    const chosen = await chooseTurnMemories(dir, 'deploy', new InjectedMemoryLedger(), async () => ({ block: '', relPaths: [], entries: [] }))
    expect(chosen).toEqual({ block: '', relPaths: [] })
  })

  it('Haiku sem decisão (null ou exceção): cai na busca lexical', async () => {
    const dir = await memories(base)
    const viaNull = await chooseTurnMemories(dir, 'deploy publicar', new InjectedMemoryLedger(), async () => null)
    expect(viaNull.relPaths).toEqual(['deploy.md'])
    expect(viaNull.block).toContain('npm run package:portable')
    const viaThrow = await chooseTurnMemories(dir, 'deploy publicar', new InjectedMemoryLedger(), async () => {
      throw new Error('x')
    })
    expect(viaThrow.relPaths).toEqual(['deploy.md'])
  })
})
