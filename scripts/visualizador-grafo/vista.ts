/**
 * Monta, no navegador, os grafos (graphology) das três visões a partir de `window.GRAFO`.
 * Chaves dos nós: `t:<i>` tema, `n:<nível>` nível da árvore, `m:<i>` memória.
 */
import Graph from 'graphology'
import type { Grafo, MemoriaVisual } from './tipos'
import type { Nivel } from './dados'

export const ORDEM_NIVEIS: readonly Nivel[] = ['fast', 'curto', 'medio', 'longo', 'observacoes']

export const NOME_NIVEL: Record<Nivel, string> = {
  fast: 'Fast',
  curto: 'Curto',
  medio: 'Médio',
  longo: 'Longo',
  observacoes: 'Observações'
}

export const REGRA_NIVEL: Record<Nivel, string> = {
  fast: 'últimas 24 horas',
  curto: 'até 7 dias',
  medio: 'até 60 dias',
  longo: 'mais antigas ou sem data',
  observacoes: 'ainda não existe no acervo'
}

export const COR_TINTA = '#1c2430'
export const COR_APAGADA = '#dfe3e8'
const COR_NIVEL = '#5b6573'
const COR_VAZIO = '#b8bfc8'
const COR_LINHA_TEMA = '#9aa3ae'
const COR_LINHA_MEM = '#c3c9d1'
const COR_LINHA_ARVORE = '#d3d8de'

export type Tipo = 'tema' | 'nivel' | 'memoria'
export const tipoDe = (chave: string): Tipo => (chave.startsWith('t:') ? 'tema' : chave.startsWith('n:') ? 'nivel' : 'memoria')
export const indiceDe = (chave: string): number => Number(chave.slice(2))

const plural = (n: number, um: string, varios: string): string => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`

/** Grafo dos temas: um nó por tema, ligações pela semelhança de assunto. */
export function grafoTemas(g: Grafo): Graph {
  const graph = new Graph({ type: 'undirected' })
  const maior = Math.max(...g.temas.map((t) => t.total), 1)
  g.temas.forEach((t, i) => {
    graph.addNode(`t:${i}`, {
      x: t.x,
      y: t.y,
      size: 7 + 17 * Math.sqrt(t.total / maior),
      color: t.cor,
      label: `${t.nome} (${t.total})`
    })
  })
  g.ligacoesTemas.forEach((l, i) => {
    graph.addEdgeWithKey(`l:${i}`, `t:${l.a}`, `t:${l.b}`, { size: 1 + 5 * l.forca, color: COR_LINHA_TEMA })
  })
  return graph
}

/** Memórias de um tema, separadas por nível e da mais nova para a mais antiga. */
export function memoriasPorNivel(g: Grafo, tema: number): Record<Nivel, number[]> {
  const grupos = Object.fromEntries(ORDEM_NIVEIS.map((n) => [n, [] as number[]])) as Record<Nivel, number[]>
  g.memorias.forEach((m, i) => {
    if (m.tema === tema) grupos[m.nivel].push(i)
  })
  const chave = (m: MemoriaVisual): string => m.data ?? ''
  for (const n of ORDEM_NIVEIS) grupos[n].sort((a, b) => chave(g.memorias[b]).localeCompare(chave(g.memorias[a])))
  return grupos
}

/** Árvore: tema à esquerda → cinco níveis → memórias de cada nível em grade. */
export function grafoArvore(g: Grafo, tema: number): Graph {
  const graph = new Graph({ type: 'directed' })
  const t = g.temas[tema]
  const grupos = memoriasPorNivel(g, tema)
  const porLinha = 10
  const passo = 1
  let topo = 0
  const centros: number[] = []

  for (const nivel of ORDEM_NIVEIS) {
    const lista = grupos[nivel]
    const linhas = Math.max(1, Math.ceil(lista.length / porLinha))
    centros.push(-(topo + ((linhas - 1) * passo) / 2))
    lista.forEach((m, k) => {
      const mem = g.memorias[m]
      graph.addNode(`m:${m}`, {
        x: 12 + (k % porLinha) * passo, // folga para o rótulo do nível não cobrir a 1ª coluna
        y: -(topo + Math.floor(k / porLinha) * passo),
        size: 5,
        color: t.cor,
        label: mem.titulo
      })
    })
    topo += linhas * passo + 1.6
  }

  const meio = (centros[0] + centros[centros.length - 1]) / 2
  graph.addNode(`t:${tema}`, { x: 0, y: meio, size: 18, color: t.cor, label: `${t.nome} (${t.total})` })
  ORDEM_NIVEIS.forEach((nivel, k) => {
    const n = grupos[nivel].length
    const vazio = nivel === 'observacoes'
    graph.addNode(`n:${nivel}`, {
      x: 5,
      y: centros[k],
      size: vazio ? 8 : 11,
      color: vazio ? COR_VAZIO : COR_NIVEL,
      label: vazio ? `${NOME_NIVEL[nivel]} · vazio` : `${NOME_NIVEL[nivel]} · ${plural(n, 'memória', 'memórias')}`
    })
    graph.addEdge(`t:${tema}`, `n:${nivel}`, { size: 1.5, color: COR_LINHA_TEMA })
    for (const m of grupos[nivel]) graph.addEdge(`n:${nivel}`, `m:${m}`, { size: 0.5, color: COR_LINHA_ARVORE })
  })
  return graph
}

/** Grafo das memórias: um ponto por memória, ligações "parecida". */
export function grafoMemorias(g: Grafo): Graph {
  const graph = new Graph({ type: 'undirected' })
  g.memorias.forEach((m, i) => {
    graph.addNode(`m:${i}`, { x: m.x, y: m.y, size: 4, color: g.temas[m.tema].cor, label: m.titulo })
  })
  g.parecidas.forEach(([a, b, c]) => {
    graph.addEdge(`m:${a}`, `m:${b}`, { size: 0.4 + 1.6 * Math.max(0, c), color: COR_LINHA_MEM })
  })
  return graph
}

/** Vizinhas "parecida" de uma memória, da mais para a menos parecida. */
export function parecidasDe(g: Grafo, m: number): Array<{ i: number; cosseno: number }> {
  const out: Array<{ i: number; cosseno: number }> = []
  for (const [a, b, c] of g.parecidas) {
    if (a === m) out.push({ i: b, cosseno: c })
    else if (b === m) out.push({ i: a, cosseno: c })
  }
  return out.sort((x, y) => y.cosseno - x.cosseno)
}

/** Texto sem acento e em minúsculas, para a busca. */
export const normalizar = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
