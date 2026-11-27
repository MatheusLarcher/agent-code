/**
 * Ordenador híbrido de memórias (local, sem IA remota): funde por RRF três sinais
 *  - o ranking lexical que o app já usa (`rankMemoriesByQuery`);
 *  - o cosseno entre o pedido e a memória em embeddings locais
 *    (transformers.js, modelo público baixado uma vez; o texto não sai do PC);
 *  - um peso pequeno de recência (frontmatter updated/created, senão mtime).
 *
 * Usado pelo avaliador (scripts/medicoes) e por quem passar `ranker` a
 * `selectMemoriesWithHaiku`. O app não importa este arquivo por padrão.
 * Memórias `sempre` ficam fora: elas já vão em toda conversa.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPinnedMemory, rankMemoriesByQuery, redactMemorySecrets, type MemoryFile } from './memoryIndex'
import { memoryFileIndex } from './memory/memoryFileCache'

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
/** Constante clássica do RRF: amortece a diferença entre 1º e 2º lugar. */
export const DEFAULT_RRF_K = 60
export const DEFAULT_RANK_WEIGHTS = { lexical: 1, semantic: 1, recency: 0.2 } as const
/** Caracteres do texto de cada memória que viram vetor (título + descrição + início). */
export const EMBED_TEXT_MAX_CHARS = 800
const EMBED_BATCH = 16
const QUERY_MAX_CHARS = 2_000

/** Recebe textos, devolve um vetor por texto, na mesma ordem. Injetável nos testes. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

export interface HybridRankOptions {
  embed?: EmbedFn
  /** Pasta do cache de vetores em disco. Sem ela, os vetores só ficam na memória do processo. */
  cacheDir?: string
  model?: string
  rrfK?: number
  weights?: Partial<{ lexical: number; semantic: number; recency: number }>
  /** Hora de referência (testes). Só desempata; a recência entra por posição. */
  now?: number
}

export interface HybridRankedMemory {
  file: MemoryFile
  /** Nota RRF fundida (maior = melhor). */
  score: number
  /** Cosseno pedido × memória, de -1 a 1. Dá para cortar por ele (o RRF não tem escala absoluta). */
  cosine: number
  lexicalScore: number
  /** Posição (1 = primeiro) em cada lista; `null` quando fora da lista lexical. */
  lexicalRank: number | null
  semanticRank: number
  recencyRank: number
}

interface Doc {
  file: MemoryFile
  text: string
  hash: string
  time: number
}

/** Ordena `files` (menos as `sempre`) para o pedido, melhor primeiro. Lança só se o embed lançar. */
export async function rankMemoriesHybrid(
  dir: string,
  query: string,
  files: readonly MemoryFile[],
  opts: HybridRankOptions = {}
): Promise<HybridRankedMemory[]> {
  const input = query.slice(0, QUERY_MAX_CHARS).trim()
  if (!input || files.length === 0) return []
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL
  const embed = opts.embed ?? defaultEmbed(model)
  const k = opts.rrfK ?? DEFAULT_RRF_K
  const w = { ...DEFAULT_RANK_WEIGHTS, ...opts.weights }

  const docs = memoryDocs(dir, files, model)
  if (docs.length === 0) return []

  const vectors = await docVectors(docs, embed, model, opts.cacheDir)
  const [queryVector] = await embed([input])
  if (!queryVector) throw new Error('embed não devolveu o vetor do pedido')

  const cosine = new Map(docs.map((doc) => [doc.file.relPath, cosineOf(queryVector, vectors.get(doc.hash) ?? [])]))
  const lexical = rankMemoriesByQuery(dir, input, docs.map((doc) => doc.file)).filter((r) => r.score > 0)
  const lexicalScore = new Map(lexical.map((r) => [r.file.relPath, r.score]))
  const lexicalRank = positions(lexical.map((r) => [r.file.relPath, r.score]))
  const semanticRank = positions(docs.map((doc) => [doc.file.relPath, cosine.get(doc.file.relPath)!]))
  const recencyRank = positions(docs.map((doc) => [doc.file.relPath, doc.time]))

  const ranked = docs.map((doc): HybridRankedMemory => {
    const rel = doc.file.relPath
    const lex = lexicalRank.get(rel) ?? null
    const sem = semanticRank.get(rel)!
    const rec = recencyRank.get(rel)!
    const score = (lex === null ? 0 : w.lexical / (k + lex)) + w.semantic / (k + sem) + w.recency / (k + rec)
    return { file: doc.file, score, cosine: cosine.get(rel)!, lexicalScore: lexicalScore.get(rel) ?? 0, lexicalRank: lex, semanticRank: sem, recencyRank: rec }
  })
  ranked.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath))
  return ranked
}

/** O calculador de sentido: o injetado (testes) ou o transformers.js, carregado na 1ª chamada. */
export function embedderFor(opts: Pick<HybridRankOptions, 'embed' | 'model'> = {}): EmbedFn {
  return opts.embed ?? defaultEmbed(opts.model ?? DEFAULT_EMBEDDING_MODEL)
}

/** Vetor de cada memória (menos as `sempre`), por caminho, pelo MESMO cache em disco do ordenador. */
export async function memoryVectors(
  dir: string,
  files: readonly MemoryFile[],
  opts: Pick<HybridRankOptions, 'embed' | 'model' | 'cacheDir'> = {}
): Promise<Map<string, number[]>> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL
  const docs = memoryDocs(dir, files, model)
  const vectors = await docVectors(docs, embedderFor(opts), model, opts.cacheDir)
  return new Map(docs.map((doc) => [doc.file.relPath, vectors.get(doc.hash) ?? []]))
}

/** Posição por valor, maior primeiro; empates dividem a posição (1, 1, 3). */
function positions(items: Array<[string, number]>): Map<string, number> {
  const sorted = [...items].sort((a, b) => b[1] - a[1])
  const out = new Map<string, number>()
  sorted.forEach(([key, value], i) => {
    out.set(key, i > 0 && sorted[i - 1][1] === value ? out.get(sorted[i - 1][0])! : i + 1)
  })
  return out
}

/** Cosseno de verdade (não supõe vetor normalizado). 0 para vetor vazio ou de tamanho diferente. */
export function cosineOf(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Texto, hash e data de cada memória; fora as `sempre`, binárias e ilegíveis. */
function memoryDocs(dir: string, files: readonly MemoryFile[], model: string): Doc[] {
  const index = memoryFileIndex(dir)
  const docs: Doc[] = []
  for (const file of files) {
    const cached = index.byRelPath.get(file.relPath)
    if (!cached || cached.hasNul) continue
    if (isPinnedMemory(cached.content)) continue
    const text = embedText(file, cached.content)
    const hash = createHash('sha256').update(`${model}\n${text}`).digest('hex')
    docs.push({ file, text, hash, time: memoryTime(cached.content) ?? cached.mtimeMs })
  }
  return docs
}

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Título + descrição + início do corpo (sem frontmatter), com segredos tapados. */
export function embedText(file: Pick<MemoryFile, 'title' | 'hook'>, content: string): string {
  const body = content.replace(FRONT, '').replace(/\s+/g, ' ').trim()
  return redactMemorySecrets(`${file.title}. ${file.hook}. ${body}`).slice(0, EMBED_TEXT_MAX_CHARS)
}

/** Data do frontmatter (updated/atualizado/modificada antes de created/criado/criada), em ms. */
export function memoryTime(content: string): number | null {
  const front = FRONT.exec(content)?.[1]
  if (!front) return null
  for (const key of ['updated', 'atualizado', 'atualizada', 'modificado', 'modificada', 'created', 'criado', 'criada']) {
    const raw = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\r\\n]+)`, 'im').exec(front)?.[1]
    const time = raw ? Date.parse(raw.trim()) : NaN
    if (Number.isFinite(time)) return time
  }
  return null
}

// ---- cache de vetores: hash do texto -> vetor, um JSON por modelo ----

const memo = new Map<string, Map<string, number[]>>()

/** Esquece o cache em memória (testes: força reler o disco). */
export function clearVectorMemo(): void {
  memo.clear()
}

function cacheFile(cacheDir: string, model: string): string {
  return join(cacheDir, `${model.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`)
}

function loadCache(cacheDir: string | undefined, model: string): Map<string, number[]> {
  const key = cacheDir ? cacheFile(cacheDir, model) : `:memoria:${model}`
  let map = memo.get(key)
  if (map) return map
  map = new Map()
  if (cacheDir) {
    try {
      const raw = JSON.parse(readFileSync(key, 'utf8')) as unknown
      if (raw && typeof raw === 'object') {
        for (const [hash, vec] of Object.entries(raw as Record<string, unknown>)) {
          if (Array.isArray(vec) && vec.every((x) => typeof x === 'number')) map.set(hash, vec as number[])
        }
      }
    } catch {
      // sem cache ainda (ou corrompido): recalcula
    }
  }
  memo.set(key, map)
  return map
}

function saveCache(cacheDir: string, model: string, map: Map<string, number[]>): void {
  const file = cacheFile(cacheDir, model)
  mkdirSync(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)))
  renameSync(tmp, file)
}

async function docVectors(docs: Doc[], embed: EmbedFn, model: string, cacheDir?: string): Promise<Map<string, number[]>> {
  const cache = loadCache(cacheDir, model)
  const missing = [...new Map(docs.filter((d) => !cache.has(d.hash)).map((d) => [d.hash, d.text]))]
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH)
    const vecs = await embed(batch.map(([, text]) => text))
    if (vecs.length !== batch.length) throw new Error(`embed devolveu ${vecs.length} vetores para ${batch.length} textos`)
    batch.forEach(([hash], j) => cache.set(hash, vecs[j]))
  }
  if (missing.length > 0 && cacheDir) saveCache(cacheDir, model, cache)
  return cache
}

// ---- embed padrão: transformers.js, carregado sob demanda e uma vez ----

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
const extractors = new Map<string, Promise<Extractor>>()

function defaultEmbed(model: string): EmbedFn {
  return async (texts) => {
    let extractor = extractors.get(model)
    if (!extractor) {
      extractor = import('@huggingface/transformers').then(
        (mod) => (mod.pipeline as unknown as (task: string, model: string) => Promise<Extractor>)('feature-extraction', model)
      )
      extractor.catch(() => extractors.delete(model))
      extractors.set(model, extractor)
    }
    const run = await extractor
    return (await run(texts, { pooling: 'mean', normalize: true })).tolist()
  }
}
