/**
 * 1ª passada do bibliotecário (spec §7, checklist E2/E4, P23): pôr cada memória SOLTA no
 * tema certo. Só simulação — devolve sugestões; nada é gravado (E2: o Erick aprova antes).
 *
 * Mecânico primeiro (D6): compara a memória com o perfil de sentido de cada tema e só move
 * com vitória clara (nota mínima e folga sobre o 2º). Quem não tem tema claro fica em
 * `geral` — e é o que vale para tudo (idioma, jeito de responder) que deve ficar lá (D33).
 * Louvain (com semente fixa: mesma entrada → mesma saída) aponta grupos de soltas que
 * podem virar um tema novo.
 */
import louvain from 'graphology-communities-louvain'
import type Graph from 'graphology'
import { TEMA_GERAL, type FichaMemoria } from './fichas'
import type { Sentido } from './sentido'

export interface SugestaoTema {
  id: string
  de: string
  /** Tema sugerido; null = fica onde está (sem vitória clara). */
  para: string | null
  nota: number
  segundo: { tema: string; nota: number } | null
}

export interface OpcoesBibliotecario {
  /** Cosseno mínimo com o perfil do tema (padrão 0,40). */
  corte?: number
  /** Vantagem mínima sobre o 2º tema (padrão 0,04). */
  folga?: number
  /** Pastas genéricas demais para serem tema (ex.: "projetos"): suas memórias também são avaliadas. */
  pastasGenericas?: readonly string[]
  /** Mínimo de memórias para um tema servir de destino (padrão 2). */
  minimoPorTema?: number
}

/** Quem precisa de tema: soltas (geral) e as de pasta genérica — nunca as com `tema:` declarado. */
export function precisaDeTema(f: FichaMemoria, genericas: ReadonlySet<string>): boolean {
  return !f.temaDeclarado && (f.tema === TEMA_GERAL || genericas.has(f.tema))
}

export function sugerirTemas(fichas: readonly FichaMemoria[], sentido: Sentido, o: OpcoesBibliotecario = {}): SugestaoTema[] {
  const genericas = new Set(o.pastasGenericas ?? [])
  const contagem = new Map<string, number>()
  for (const f of fichas) if (!precisaDeTema(f, genericas)) contagem.set(f.tema, (contagem.get(f.tema) ?? 0) + 1)
  const destinos = [...contagem].filter(([t, n]) => t !== TEMA_GERAL && n >= (o.minimoPorTema ?? 2)).map(([t]) => t).sort()
  const out: SugestaoTema[] = []
  for (const f of fichas) {
    if (!precisaDeTema(f, genericas)) continue
    const v = sentido.vetor(f.id)
    const notas = destinos
      .map((tema) => ({ tema, nota: sentido.cos(v, sentido.perfil(tema)) }))
      .sort((a, b) => b.nota - a.nota || a.tema.localeCompare(b.tema))
    const [primeiro, segundo] = notas
    const claro = !!primeiro && primeiro.nota >= (o.corte ?? 0.4) && primeiro.nota - (segundo?.nota ?? 0) >= (o.folga ?? 0.04)
    out.push({ id: f.id, de: f.tema, para: claro ? primeiro.tema : null, nota: primeiro?.nota ?? 0, segundo: segundo ?? null })
  }
  return out
}

/** As fichas como ficariam com as sugestões aplicadas (simulação, em memória). */
export function aplicarSugestoes(fichas: readonly FichaMemoria[], sugestoes: readonly SugestaoTema[]): FichaMemoria[] {
  const para = new Map(sugestoes.filter((s) => s.para).map((s) => [s.id, s.para!]))
  return fichas.map((f) => (para.has(f.id) ? { ...f, tema: para.get(f.id)! } : f))
}

/** Gerador pseudoaleatório com semente (mulberry32): o Louvain fica determinístico. */
function rngComSemente(semente: number): () => number {
  let a = semente >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Grupos de memórias que continuaram sem tema e estão ligadas entre si (Louvain sobre o
 * grafo de memórias): candidatos a tema novo. Só grupos com pelo menos `minimo` memórias.
 */
export function gruposSemTema(grafoMemorias: Graph, semTema: ReadonlySet<string>, minimo = 3): string[][] {
  const sub = grafoMemorias.copy()
  sub.forEachNode((n) => {
    if (!semTema.has(n)) sub.dropNode(n)
  })
  if (sub.order === 0 || sub.size === 0) return []
  const comunidade = louvain(sub, { rng: rngComSemente(42), getEdgeWeight: 'peso' })
  const grupos = new Map<number, string[]>()
  for (const [n, c] of Object.entries(comunidade)) grupos.set(c, [...(grupos.get(c) ?? []), n])
  return [...grupos.values()].filter((g) => g.length >= minimo).map((g) => g.sort()).sort((a, b) => b.length - a.length)
}
