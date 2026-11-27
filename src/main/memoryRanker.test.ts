import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMemoryFiles } from './memoryIndex'
import { disposeMemoryFileCache } from './memory/memoryFileCache'
import { clearVectorMemo, cosineOf, memoryTime, rankMemoriesHybrid, type EmbedFn } from './memoryRanker'

async function memories(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-ranker-'))
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, 'utf8')
  return dir
}

/** Embedding falso por "assuntos": cada palavra-chave acende um eixo. Guarda os textos pedidos. */
function fakeEmbed(axes: string[][]): { embed: EmbedFn; seen: string[] } {
  const seen: string[] = []
  const embed: EmbedFn = async (texts) => {
    seen.push(...texts)
    return texts.map((text) => axes.map((words) => (words.some((w) => text.toLowerCase().includes(w)) ? 1 : 0)))
  }
  return { embed, seen }
}

const base = {
  'deploy.md': '# Deploy do site\ndescription: como fazer o deploy\n\nRode o script de deploy.\n',
  'publicacao.md': '# Subir versão\ndescription: publicar no servidor\n\nCopie para a máquina de produção e reinicie.\n',
  'cafe.md': '# Café\ndescription: gosto de café forte\n\nSem açúcar.\n'
}

describe('rankMemoriesHybrid', () => {
  it('funde lexical e sentido por RRF: o sinônimo sobe acima do assunto alheio', async () => {
    const dir = await memories(base)
    const { embed } = fakeEmbed([['deploy', 'publicar', 'produção'], ['café']])
    // Sem recência aqui: os mtimes dos arquivos recém-criados variam por milissegundos.
    const ranked = await rankMemoriesHybrid(dir, 'deploy', listMemoryFiles(dir), { embed, weights: { recency: 0 } })

    expect(ranked.map((r) => r.file.relPath)).toEqual(['deploy.md', 'publicacao.md', 'cafe.md'])
    const [deploy, publicacao, cafe] = ranked
    expect(deploy.lexicalRank).toBe(1)
    expect(deploy.lexicalScore).toBeGreaterThan(0)
    expect(publicacao.lexicalRank).toBeNull()
    expect(publicacao.cosine).toBeCloseTo(1)
    expect(cafe.cosine).toBeCloseTo(0)
    // RRF com k=60: o 1º lexical soma 1/61 ao que o sentido dá.
    expect(deploy.score - publicacao.score).toBeCloseTo(1 / 61, 5)
  })

  it('recência desempata, mas é leve: não vence uma memória claramente mais próxima', async () => {
    const dir = await memories({
      'nota-antiga.md': '---\nupdated: 2020-01-01\n---\n# Nota antiga\n\nchuva\n',
      'nota-nova.md': '---\nupdated: 2026-10-01\n---\n# Nota nova\n\nchuva\n',
      'velha-certa.md': '---\ncreated: 2019-01-01\n---\n# Velha\n\nchuva granizo\n'
    })
    const { embed } = fakeEmbed([['chuva'], ['granizo']])
    const ranked = await rankMemoriesHybrid(dir, 'granizo e chuva forte hoje', listMemoryFiles(dir), { embed, weights: { lexical: 0 } })

    expect(ranked.map((r) => r.file.relPath)).toEqual(['velha-certa.md', 'nota-nova.md', 'nota-antiga.md'])
    const nova = ranked.find((r) => r.file.relPath === 'nota-nova.md')!
    const antiga = ranked.find((r) => r.file.relPath === 'nota-antiga.md')!
    expect(nova.semanticRank).toBe(antiga.semanticRank)
    expect(nova.recencyRank).toBeLessThan(antiga.recencyRank)
  })

  it('lê a data do frontmatter (atualizado antes de criado) e cai no nada sem ela', () => {
    expect(memoryTime('---\ncreated: 2020-01-01\nupdated: 2024-05-02\n---\nx')).toBe(Date.parse('2024-05-02'))
    expect(memoryTime('---\ncriado: "2021-03-04"\n---\nx')).toBe(Date.parse('2021-03-04'))
    expect(memoryTime('# sem frontmatter')).toBeNull()
  })

  it('guarda os vetores em disco e só recalcula o que mudou', async () => {
    const dir = await memories(base)
    const cacheDir = await mkdtemp(join(tmpdir(), 'mem-vetores-'))
    const axes = [['deploy', 'publicar'], ['café']]

    clearVectorMemo()
    const first = fakeEmbed(axes)
    await rankMemoriesHybrid(dir, 'deploy', listMemoryFiles(dir), { embed: first.embed, cacheDir })
    expect(first.seen).toHaveLength(4) // 3 memórias + o pedido
    const file = join(cacheDir, 'Xenova_paraphrase-multilingual-MiniLM-L12-v2.json')
    expect(existsSync(file)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toHaveLength(3)

    clearVectorMemo() // força reler do disco
    const second = fakeEmbed(axes)
    await rankMemoriesHybrid(dir, 'deploy', listMemoryFiles(dir), { embed: second.embed, cacheDir })
    expect(second.seen).toEqual(['deploy']) // só o pedido

    await writeFile(join(dir, 'cafe.md'), '# Café\ndescription: gosto de café fraco\n\nCom leite.\n', 'utf8')
    disposeMemoryFileCache(dir)
    clearVectorMemo()
    const third = fakeEmbed(axes)
    await rankMemoriesHybrid(dir, 'deploy', listMemoryFiles(dir), { embed: third.embed, cacheDir })
    expect(third.seen).toHaveLength(2)
    expect(third.seen[0]).toContain('fraco')
  })

  it('deixa as memórias "sempre" fora do ranking (nem viram vetor)', async () => {
    const dir = await memories({ ...base, 'regra.md': '---\nsempre: true\n---\n# Regra fixa\n\ndeploy só às sextas\n' })
    const { embed, seen } = fakeEmbed([['deploy'], ['café']])
    const ranked = await rankMemoriesHybrid(dir, 'deploy', listMemoryFiles(dir), { embed })

    expect(ranked.map((r) => r.file.relPath)).not.toContain('regra.md')
    expect(ranked).toHaveLength(3)
    expect(seen.some((t) => t.includes('Regra fixa'))).toBe(false)
  })

  it('pedido vazio ou lista vazia: nada, sem chamar o embed', async () => {
    const dir = await memories(base)
    const { embed, seen } = fakeEmbed([['deploy']])
    expect(await rankMemoriesHybrid(dir, '   ', listMemoryFiles(dir), { embed })).toEqual([])
    expect(await rankMemoriesHybrid(dir, 'deploy', [], { embed })).toEqual([])
    expect(seen).toEqual([])
  })

  it('cosseno não supõe vetor normalizado', () => {
    expect(cosineOf([2, 0], [5, 0])).toBeCloseTo(1)
    expect(cosineOf([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosineOf([1], [1, 2])).toBe(0)
  })
})
