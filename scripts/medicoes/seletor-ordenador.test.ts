import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMemoryFiles, type MemoryFile } from '../../src/main/memoryIndex'
import { clearVectorMemo, cosineOf, type EmbedFn, type HybridRankedMemory } from '../../src/main/memoryRanker'
import {
  escolherHibrido,
  escolherMMR,
  HIBRIDO_CORTE_PADRAO,
  HIBRIDO_TETO,
  interpretarSeletor,
  opcoesHibrido,
  ordenadorMedido,
  vetoresDasMemorias
} from './seletor-ordenador'

const APELIDOS = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }

describe('interpretarSeletor', () => {
  it('lê o local-hibrido e os de sempre', () => {
    expect(interpretarSeletor('sonnet', APELIDOS)).toEqual({ tipo: 'modelo', modelo: 'claude-sonnet-5-5' })
    expect(interpretarSeletor('claude-haiku-5-5', APELIDOS)).toEqual({ tipo: 'modelo', modelo: 'claude-haiku-5-5' })
    expect(interpretarSeletor('local-hibrido', APELIDOS)).toEqual({ tipo: 'hibrido' })
    expect(interpretarSeletor('lexical', APELIDOS)).toEqual({ tipo: 'lexical' })
  })

  it('recusa "<modelo>-k<N>" (fora do escopo) e o que não conhece', () => {
    expect(interpretarSeletor('sonnet-k20', APELIDOS)).toBeNull()
    expect(interpretarSeletor('claude-haiku-5-5-k10', APELIDOS)).toBeNull()
    expect(interpretarSeletor('gpt-k20', APELIDOS)).toBeNull()
    expect(interpretarSeletor('lexical-k5', APELIDOS)).toBeNull()
    expect(interpretarSeletor('gpt', APELIDOS)).toBeNull()
  })
})

describe('opcoesHibrido', () => {
  it('padrão: corte no cosseno, até 6, sem MMR', () => {
    expect(opcoesHibrido()).toEqual({ corte: HIBRIDO_CORTE_PADRAO, max: 6 })
    expect(opcoesHibrido('0.35', '4')).toEqual({ corte: 0.35, max: 4 })
    expect(opcoesHibrido('-1', '8', '0.7')).toEqual({ corte: -1, max: 8, mmr: 0.7 })
  })

  it('recusa corte fora de -1..1, máximo acima do teto e λ fora de 0..1', () => {
    expect(() => opcoesHibrido('2')).toThrow(/corte-hibrido/)
    expect(() => opcoesHibrido('abc')).toThrow(/corte-hibrido/)
    expect(() => opcoesHibrido(undefined, String(HIBRIDO_TETO + 1))).toThrow(/max-hibrido/)
    expect(() => opcoesHibrido(undefined, '2.5')).toThrow(/max-hibrido/)
    expect(() => opcoesHibrido(undefined, undefined, '1.5')).toThrow(/--mmr/)
    expect(() => opcoesHibrido(undefined, undefined, '')).toThrow(/--mmr/)
  })
})

const item = (relPath: string, cosine: number): HybridRankedMemory => ({
  file: { relPath } as MemoryFile,
  score: 0,
  cosine,
  lexicalScore: 0,
  lexicalRank: null,
  semanticRank: 1,
  recencyRank: 1
})

describe('escolherHibrido', () => {
  it('mantém a ordem do ordenador, corta pelo cosseno e para em N', () => {
    const ranked = [item('a.md', 0.9), item('b.md', 0.3), item('c.md', 0.7), item('d.md', 0.6)]
    expect(escolherHibrido(ranked, 0.5)).toEqual(['a.md', 'c.md', 'd.md'])
    expect(escolherHibrido(ranked, 0.5, 2)).toEqual(['a.md', 'c.md'])
    expect(escolherHibrido(ranked, 0.95)).toEqual([])
  })

  it('nunca passa do teto, mesmo pedindo mais; mede 8', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => item(`m${i}.md`, 0.9))
    expect(escolherHibrido(ranked, 0, 50)).toHaveLength(HIBRIDO_TETO)
    expect(escolherHibrido(ranked, -1, 8)).toHaveLength(8)
  })
})

describe('escolherMMR', () => {
  // a e a2 são quase a mesma memória; b é diferente e um pouco menos relevante.
  const vet: Record<string, number[]> = { 'a.md': [1, 0], 'a2.md': [0.99, 0.14], 'b.md': [0, 1], 'c.md': [0.7, 0.7] }
  const sim = (x: string, y: string): number => cosineOf(vet[x], vet[y])
  const ranked = [item('a.md', 0.9), item('a2.md', 0.88), item('b.md', 0.8), item('c.md', 0.3)]

  it('com λ=1 é a ordem da relevância (cosseno)', () => {
    expect(escolherMMR(ranked, -1, 3, 1, sim)).toEqual(['a.md', 'a2.md', 'b.md'])
  })

  it('com λ<1 troca a repetida pela diferente', () => {
    expect(escolherMMR(ranked, -1, 2, 0.7, sim)).toEqual(['a.md', 'b.md'])
  })

  it('respeita o corte e o máximo', () => {
    expect(escolherMMR(ranked, 0.5, 10, 0.7, sim)).not.toContain('c.md')
    expect(escolherMMR(ranked, 0.95, 3, 0.7, sim)).toEqual([])
    expect(escolherMMR(ranked, -1, 1, 0.7, sim)).toEqual(['a.md'])
  })
})

describe('ordenadorMedido', () => {
  const embed: EmbedFn = async (texts) => texts.map((t) => [t.toLowerCase().includes('deploy') ? 1 : 0, t.includes('Café') ? 1 : 0, 0.1])

  async function pasta(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mem-ordenador-'))
    await writeFile(join(dir, 'deploy.md'), '# Deploy\n\nrode o deploy\n', 'utf8')
    await writeFile(join(dir, 'deploy2.md'), '# Deploy de novo\n\nde novo o deploy\n', 'utf8')
    await writeFile(join(dir, 'cafe.md'), '# Café\n\nforte\n', 'utf8')
    return dir
  }

  it('mede o tempo do ordenador e escolhe sem IA', async () => {
    const dir = await pasta()
    const ord = ordenadorMedido({ embed })
    expect(ord.tomarMs()).toBeUndefined()
    const ranked = await ord.ordenar(dir, 'deploy', listMemoryFiles(dir))
    expect(ranked.slice(0, 2).map((r) => r.file.relPath).sort()).toEqual(['deploy.md', 'deploy2.md'])
    const ms = ord.tomarMs()
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(ord.tomarMs()).toBeUndefined() // zerou ao ler
    expect(await ord.escolher(dir, 'deploy', listMemoryFiles(dir), { corte: -1, max: 2 })).toHaveLength(2)
    expect(typeof ord.tomarMs()).toBe('number')
  })

  it('MMR lê os vetores do cache em disco do ordenador (sem chamar o embed de novo)', async () => {
    const dir = await pasta()
    const cacheDir = await mkdtemp(join(tmpdir(), 'mem-vetores-'))
    clearVectorMemo()
    await ordenadorMedido({ embed, cacheDir }).ordenar(dir, 'aquecimento', listMemoryFiles(dir))
    const v = await vetoresDasMemorias(dir, listMemoryFiles(dir), { cacheDir }) // sem embed: só o disco
    expect([...v.keys()].sort()).toEqual(['cafe.md', 'deploy.md', 'deploy2.md'])
    expect(v.get('cafe.md')).toEqual([0, 1, 0.1])
    // Com MMR, as duas de deploy são iguais: a 2ª vira o café.
    const escolhidas = await ordenadorMedido({ embed, cacheDir }).escolher(dir, 'deploy', listMemoryFiles(dir), { corte: -1, max: 2, mmr: 0.3 })
    expect(escolhidas).toContain('cafe.md')
  })

  it('MMR sem vetor no cache e sem embed avisa em vez de inventar', async () => {
    const dir = await pasta()
    const cacheDir = await mkdtemp(join(tmpdir(), 'mem-vazio-'))
    await expect(vetoresDasMemorias(dir, listMemoryFiles(dir), { cacheDir })).rejects.toThrow(/sem vetor/)
  })
})
