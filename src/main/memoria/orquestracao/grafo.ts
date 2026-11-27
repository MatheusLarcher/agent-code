/**
 * Grafos da busca nova (spec §3/§5, D32): grafo de MEMÓRIAS (ligação `parecida` pelos
 * vizinhos de sentido; `contradiz`/`substitui`/`relacionada` quando o memorista as gravar)
 * e grafo de TEMAS (força = semelhança entre perfis). Estrutura em graphology.
 *
 * PageRank personalizado escrito aqui: o `pagerank` do graphology-metrics não aceita um
 * ponto de partida (personalização), que é o que a etapa 3 precisa (HippoRAG).
 */
import Graph from 'graphology'
import type { FichaMemoria } from './fichas'
import type { Sentido } from './sentido'

export type TipoLigacao = 'parecida' | 'relacionada' | 'contradiz' | 'substitui' | 'usadas_juntas'

export interface LigacaoDeclarada {
  origem: string
  destino: string
  tipo: Exclude<TipoLigacao, 'parecida'>
  peso?: number
}

export interface OpcoesGrafo {
  /** Vizinhos de sentido por memória (padrão 3). */
  vizinhos?: number
  /** Cosseno mínimo da ligação `parecida` (padrão 0,55). */
  corteParecida?: number
  /** Cosseno mínimo entre perfis para ligar dois temas (padrão 0,35). */
  corteTemas?: number
}

export interface Grafos {
  memorias: Graph
  temas: Graph
  /** Temas ligados a `tema`, mais forte primeiro. */
  temasLigados(tema: string): Array<{ tema: string; forca: number }>
  /** Pares em conflito declarado (para trazer os dois juntos na decisão). */
  contradiz(id: string): string[]
  /** Memórias aposentadas por outra (`substitui`): ficam fora da escolha. */
  aposentadas(): Set<string>
}

export function montarGrafos(
  fichas: readonly FichaMemoria[],
  sentido: Sentido,
  declaradas: readonly LigacaoDeclarada[] = [],
  o: OpcoesGrafo = {}
): Grafos {
  const k = o.vizinhos ?? 3
  const corte = o.corteParecida ?? 0.55
  const memorias = new Graph({ type: 'undirected', multi: false })
  for (const f of fichas) memorias.addNode(f.id, { tema: f.tema, nivel: f.nivel })

  // Ligação "parecida": cada memória aos seus k vizinhos mais próximos acima do corte.
  for (const a of fichas) {
    const va = sentido.vetor(a.id)
    if (!va?.length) continue
    const vizinhos = fichas
      .filter((b) => b.id !== a.id)
      .map((b) => ({ id: b.id, c: sentido.cos(va, sentido.vetor(b.id)) }))
      .filter((x) => x.c >= corte)
      .sort((x, y) => y.c - x.c || x.id.localeCompare(y.id))
      .slice(0, k)
    for (const v of vizinhos) {
      if (!memorias.hasEdge(a.id, v.id)) memorias.addEdge(a.id, v.id, { tipo: 'parecida', peso: v.c })
    }
  }
  const conflitos = new Map<string, string[]>()
  const aposentadas = new Set<string>()
  for (const l of declaradas) {
    if (!memorias.hasNode(l.origem) || !memorias.hasNode(l.destino)) continue
    if (memorias.hasEdge(l.origem, l.destino)) memorias.dropEdge(l.origem, l.destino)
    memorias.addEdge(l.origem, l.destino, { tipo: l.tipo, peso: l.peso ?? 1 })
    if (l.tipo === 'contradiz') {
      conflitos.set(l.origem, [...(conflitos.get(l.origem) ?? []), l.destino])
      conflitos.set(l.destino, [...(conflitos.get(l.destino) ?? []), l.origem])
    }
    if (l.tipo === 'substitui') aposentadas.add(l.destino)
  }

  const temas = new Graph({ type: 'undirected', multi: false })
  const nomes = sentido.temas()
  for (const t of nomes) temas.addNode(t)
  for (let i = 0; i < nomes.length; i++) {
    for (let j = i + 1; j < nomes.length; j++) {
      const forca = sentido.cos(sentido.perfil(nomes[i]), sentido.perfil(nomes[j]))
      if (forca >= (o.corteTemas ?? 0.35)) temas.addEdge(nomes[i], nomes[j], { forca, motivo: 'parecidas' })
    }
  }

  return {
    memorias,
    temas,
    temasLigados: (tema) =>
      temas.hasNode(tema)
        ? temas
            .mapEdges(tema, (_e, at, s, d) => ({ tema: s === tema ? d : s, forca: at.forca as number }))
            .sort((a, b) => b.forca - a.forca || a.tema.localeCompare(b.tema))
        : [],
    contradiz: (id) => conflitos.get(id) ?? [],
    aposentadas: () => aposentadas
  }
}

/**
 * PageRank personalizado: passeio que volta às `sementes` com prob. 1−α a cada passo.
 * Determinístico (mesma entrada → mesma saída). Devolve a nota de cada nó (soma 1).
 */
export function pagerankPersonalizado(
  g: Graph,
  sementes: ReadonlyMap<string, number>,
  { alpha = 0.85, iteracoes = 30 }: { alpha?: number; iteracoes?: number } = {}
): Map<string, number> {
  const nos = g.nodes()
  const totalSemente = [...sementes.values()].reduce((s, v) => s + v, 0)
  if (!nos.length || totalSemente <= 0) return new Map()
  const reinicio = new Map(nos.map((n) => [n, (sementes.get(n) ?? 0) / totalSemente]))
  const pesoSaida = new Map(nos.map((n) => [n, g.reduceEdges(n, (s, _e, at) => s + ((at.peso as number) ?? 1), 0)]))
  let nota = new Map(reinicio)
  for (let it = 0; it < iteracoes; it++) {
    const prox = new Map(nos.map((n) => [n, (1 - alpha) * reinicio.get(n)!]))
    let semSaida = 0
    for (const n of nos) {
      const p = nota.get(n)!
      const total = pesoSaida.get(n)!
      if (total <= 0) {
        semSaida += p
        continue
      }
      g.forEachEdge(n, (_e, at, s, d) => {
        const viz = s === n ? d : s
        prox.set(viz, prox.get(viz)! + (alpha * p * ((at.peso as number) ?? 1)) / total)
      })
    }
    // Quem não tem saída devolve a nota às sementes (mantém a soma 1).
    if (semSaida > 0) for (const n of nos) prox.set(n, prox.get(n)! + alpha * semSaida * reinicio.get(n)!)
    nota = prox
  }
  return nota
}
