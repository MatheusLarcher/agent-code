// Parte do avaliar-escolha-memorias.ts que usa o ordenador local
// (src/main/memoryRanker.ts): lê o nome do seletor, mede o tempo do ordenador e
// escolhe SEM IA no seletor "local-hibrido" (nenhum modelo no caminho da escolha).
//
// local-hibrido: as primeiras do ordenador com cosseno >= corte, até N; com --mmr λ,
// a escolha passa a ser gulosa por MMR (relevância menos parecença com as já escolhidas).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryFile } from '../../src/main/memoryIndex'
import { memoryFileIndex } from '../../src/main/memory/memoryFileCache'
import {
  cosineOf,
  DEFAULT_EMBEDDING_MODEL,
  embedText,
  rankMemoriesHybrid,
  type HybridRankedMemory,
  type HybridRankOptions
} from '../../src/main/memoryRanker'

/** Padrão de memórias do local-hibrido. */
export const HIBRIDO_MAX = 6
/** Teto do --max-hibrido (o mesmo teto da busca por palavras do app). */
export const HIBRIDO_TETO = 10
/**
 * Corte padrão do local-hibrido, no COSSENO (de -1 a 1). O corte não é na nota
 * RRF porque ela é por posição e não tem escala absoluta: a 1ª sempre "passa".
 */
export const HIBRIDO_CORTE_PADRAO = 0.5

export type Seletor = { tipo: 'lexical' } | { tipo: 'hibrido' } | { tipo: 'grafo' } | { tipo: 'grafo-ia'; modelo: string } | { tipo: 'modelo'; modelo: string }

/** Nome do seletor -> o que rodar; null se desconhecido. "<modelo>-k<N>" não existe mais (fora do escopo). */
export function interpretarSeletor(nome: string, apelidos: Readonly<Record<string, string>>): Seletor | null {
  if (nome === 'lexical') return { tipo: 'lexical' }
  if (nome === 'local-hibrido') return { tipo: 'hibrido' }
  if (nome === 'grafo') return { tipo: 'grafo' }
  // grafo-ia: a busca nova com a IA de retaguarda (Sonnet) só na dúvida.
  if (nome === 'grafo-ia') return { tipo: 'grafo-ia', modelo: apelidos.sonnet ?? 'claude-sonnet-5-5' }
  if (/-k\d+$/.test(nome)) return null
  const modelo = apelidos[nome] ?? (nome.startsWith('claude-') ? nome : null)
  return modelo ? { tipo: 'modelo', modelo } : null
}

export interface OpcoesHibrido {
  corte: number
  max: number
  /** λ do MMR (0 a 1); ausente = sem MMR, na ordem do ordenador. */
  mmr?: number
}

/** Valida --corte-hibrido, --max-hibrido e --mmr (texto da linha de comando). */
export function opcoesHibrido(corte?: string, max?: string, mmr?: string): OpcoesHibrido {
  const c = corte === undefined ? HIBRIDO_CORTE_PADRAO : Number(corte)
  const m = max === undefined ? HIBRIDO_MAX : Number(max)
  if (!Number.isFinite(c) || c < -1 || c > 1) throw new Error('--corte-hibrido precisa ser um número de -1 a 1 (é um cosseno)')
  if (!Number.isInteger(m) || m < 1 || m > HIBRIDO_TETO) throw new Error(`--max-hibrido precisa ser um inteiro de 1 a ${HIBRIDO_TETO}`)
  if (mmr === undefined) return { corte: c, max: m }
  const l = Number(mmr)
  if (mmr.trim() === '' || !Number.isFinite(l) || l < 0 || l > 1) throw new Error('--mmr precisa ser o λ, um número de 0 a 1 (1 = só relevância)')
  return { corte: c, max: m, mmr: l }
}

const teto = (max: number): number => Math.max(0, Math.min(HIBRIDO_TETO, Math.floor(max)))

/** local-hibrido: na ordem do ordenador, só as com cosseno >= corte, até `max` (nunca mais que o teto). */
export function escolherHibrido(ranked: readonly HybridRankedMemory[], corte: number, max: number = HIBRIDO_MAX): string[] {
  return ranked
    .filter((r) => r.cosine >= corte)
    .slice(0, teto(max))
    .map((r) => r.file.relPath)
}

/**
 * MMR guloso entre as que passam no corte: a cada passo, a de maior
 * λ·cos(pedido, d) − (1−λ)·max cos(d, já escolhidas). Empate: a que vem antes no ordenador.
 */
export function escolherMMR(
  ranked: readonly HybridRankedMemory[],
  corte: number,
  max: number,
  lambda: number,
  parecenca: (a: string, b: string) => number
): string[] {
  const restantes = ranked.filter((r) => r.cosine >= corte).map((r) => ({ rel: r.file.relPath, rel2q: r.cosine, maxSim: -Infinity }))
  const out: string[] = []
  const n = teto(max)
  while (out.length < n && restantes.length > 0) {
    let melhor = 0
    let melhorNota = -Infinity
    restantes.forEach((c, i) => {
      const nota = lambda * c.rel2q - (1 - lambda) * (out.length ? c.maxSim : 0)
      if (nota > melhorNota) {
        melhorNota = nota
        melhor = i
      }
    })
    const [escolhida] = restantes.splice(melhor, 1)
    out.push(escolhida.rel)
    for (const c of restantes) c.maxSim = Math.max(c.maxSim, parecenca(c.rel, escolhida.rel))
  }
  return out
}

/**
 * Vetores das memórias para o MMR, sem mexer no ordenador: lê o cache em disco que o
 * ordenador grava (chave = sha256(modelo + "\n" + texto), texto = `embedText`) e, se
 * faltar algum e houver `embed` injetado, calcula. O teste cobre esse acoplamento.
 */
export async function vetoresDasMemorias(dir: string, files: readonly MemoryFile[], opts: HybridRankOptions): Promise<Map<string, number[]>> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL
  let disco: Record<string, unknown> = {}
  if (opts.cacheDir) {
    try {
      disco = JSON.parse(readFileSync(join(opts.cacheDir, `${model.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`), 'utf8')) as Record<string, unknown>
    } catch {
      disco = {}
    }
  }
  const index = memoryFileIndex(dir)
  const out = new Map<string, number[]>()
  const faltam: Array<[string, string]> = []
  for (const f of files) {
    const conteudo = index.byRelPath.get(f.relPath)?.content
    if (conteudo === undefined) continue
    const texto = embedText(f, conteudo)
    const v = disco[createHash('sha256').update(`${model}\n${texto}`).digest('hex')]
    if (Array.isArray(v)) out.set(f.relPath, v as number[])
    else faltam.push([f.relPath, texto])
  }
  if (faltam.length) {
    if (!opts.embed) throw new Error(`MMR: ${faltam.length} memória(s) sem vetor no cache (${opts.cacheDir ?? 'sem --cache-vetores'})`)
    const vs = await opts.embed(faltam.map(([, t]) => t))
    faltam.forEach(([rel], i) => out.set(rel, vs[i] ?? []))
  }
  return out
}

export interface OrdenadorMedido {
  ordenar(dir: string, query: string, files: readonly MemoryFile[]): Promise<HybridRankedMemory[]>
  /** Ordena e escolhe (com MMR se pedido), tudo no cronômetro do ordenador. */
  escolher(dir: string, query: string, files: readonly MemoryFile[], o: OpcoesHibrido): Promise<string[]>
  /** ms gastos no ordenador desde a última leitura (e zera); undefined se ele não rodou. */
  tomarMs(): number | undefined
}

/** O ordenador híbrido com cronômetro. */
export function ordenadorMedido(opts: HybridRankOptions): OrdenadorMedido {
  let gasto: number | undefined
  let vetores: Promise<Map<string, number[]>> | undefined
  const medir = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      gasto = (gasto ?? 0) + (performance.now() - t0)
    }
  }
  const ordenar = (dir: string, query: string, files: readonly MemoryFile[]): Promise<HybridRankedMemory[]> =>
    medir(() => rankMemoriesHybrid(dir, query, files, opts))
  return {
    ordenar,
    escolher: (dir, query, files, o) =>
      medir(async () => {
        const ranked = await rankMemoriesHybrid(dir, query, files, opts)
        if (o.mmr === undefined) return escolherHibrido(ranked, o.corte, o.max)
        // Os vetores das memórias não mudam numa rodada: lê o cache uma vez por processo.
        vetores ??= vetoresDasMemorias(dir, files, opts)
        const v = await vetores
        return escolherMMR(ranked, o.corte, o.max, o.mmr, (a, b) => cosineOf(v.get(a) ?? [], v.get(b) ?? []))
      }),
    tomarMs() {
      const v = gasto
      gasto = undefined
      return v === undefined ? undefined : Math.round(v)
    }
  }
}
