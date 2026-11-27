/**
 * Monta o `Grafo` (tipos.ts) a partir das memórias já lidas e dos seus vetores:
 * perfis de tema, ligações entre temas, ligações "parecida" entre memórias e as
 * posições (ForceAtlas2) dos dois grafos. Roda no Node, dentro do `gerar.ts`.
 */
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { cosineOf } from '../../src/main/memoryRanker'
import {
  NIVEIS,
  TEMA_GERAL,
  aleatorio,
  centralizar,
  escalar,
  media,
  palavrasCaracteristicas,
  percentil,
  vizinhosMaisProximos,
  type Nivel
} from './dados'
import type { Grafo, LigacaoTemaVisual, MemoriaVisual, TemaVisual } from './tipos'

export interface MemoriaLida {
  caminho: string
  titulo: string
  gancho: string
  tema: string
  nivel: Exclude<Nivel, 'observacoes'>
  data: string | null
  origemData: 'cabecalho' | 'texto' | null
  sempre: boolean
  /** Texto usado nas palavras características (título + gancho + corpo). */
  texto: string
  vetor: number[]
}

export interface OpcoesMontagem {
  hoje: string
  modelo: string
  /** Vizinhos "parecida" por memória. */
  vizinhos?: number
  /** Percentil do melhor vizinho de cada memória que vira o limiar da ligação. */
  percentilLimiar?: number
  /** Temas vizinhos por tema no grafo de temas. */
  vizinhosTema?: number
}

/** Cores sóbrias para os temas, por ordem de tamanho; `geral` fica cinza. */
const CORES = ['#2f5d8a', '#3f7f6e', '#8c6a2a', '#7b4f6e', '#56702f', '#9b4e3f', '#2f7a8c', '#6e6a3a', '#4a5f9a', '#8a5a3c']
const COR_GERAL = '#6b7280'

const r2 = (x: number): number => Math.round(x * 100) / 100
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const virgula = (x: number, casas = 2): string => x.toFixed(casas).replace('.', ',')

function nivelVazio(): Record<Nivel, number> {
  return Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>
}

/** Posições de um grafo pequeno ou médio, sempre as mesmas para a mesma entrada. */
function posicionar(graph: Graph, iteracoes: number, extra: Record<string, number | boolean> = {}): void {
  const settings = { ...forceAtlas2.inferSettings(graph), ...extra }
  forceAtlas2.assign(graph, { iterations: iteracoes, settings, getEdgeWeight: 'weight' })
}

export function montarGrafo(memorias: readonly MemoriaLida[], opcoes: OpcoesMontagem): Grafo {
  const k = opcoes.vizinhos ?? 3
  const kTema = opcoes.vizinhosTema ?? 3
  const centrados = centralizar(memorias.map((m) => m.vetor))

  // ---- temas: ordem por tamanho (geral por último), perfil = média dos vetores centrados ----
  const contagem = new Map<string, number>()
  for (const m of memorias) contagem.set(m.tema, (contagem.get(m.tema) ?? 0) + 1)
  const nomes = [...contagem.keys()].sort((a, b) => {
    if (a === TEMA_GERAL) return 1
    if (b === TEMA_GERAL) return -1
    return (contagem.get(b) ?? 0) - (contagem.get(a) ?? 0) || a.localeCompare(b)
  })
  const indiceTema = new Map(nomes.map((n, i) => [n, i]))
  const temaDe = memorias.map((m) => indiceTema.get(m.tema) ?? 0)
  const perfis = nomes.map((_, t) => media(centrados.filter((_, i) => temaDe[i] === t)))

  // ---- memórias parecidas: k vizinhos acima de um limiar tirado da própria distribuição ----
  const melhores = centrados.map((v, i) => {
    let melhor = -1
    centrados.forEach((w, j) => {
      if (j !== i) melhor = Math.max(melhor, cosineOf(v, w))
    })
    return melhor
  })
  const limiar = r3(percentil(melhores, opcoes.percentilLimiar ?? 20))
  const parecidas = vizinhosMaisProximos(centrados, k, limiar)

  const paresEntre = new Map<string, number>()
  for (const l of parecidas) {
    const ta = temaDe[l.a]
    const tb = temaDe[l.b]
    if (ta === tb) continue
    const chave = `${Math.min(ta, tb)}:${Math.max(ta, tb)}`
    paresEntre.set(chave, (paresEntre.get(chave) ?? 0) + 1)
  }

  // ---- ligações entre temas: cada tema liga aos seus vizinhos de sentido mais próximos ----
  const escolhidas = new Map<string, { a: number; b: number; cosseno: number }>()
  perfis.forEach((p, a) => {
    if (nomes[a] === TEMA_GERAL) return // geral é a gaveta do que não tem tema: não puxa ninguém
    const candidatos = perfis
      .map((q, b) => ({ b, c: b === a || nomes[b] === TEMA_GERAL ? -1 : cosineOf(p, q) }))
      .filter((x) => x.c > 0)
      .sort((x, y) => y.c - x.c)
      .slice(0, kTema)
    for (const { b, c } of candidatos) {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      escolhidas.set(`${lo}:${hi}`, { a: lo, b: hi, cosseno: c })
    }
  })
  const listaLig = [...escolhidas.values()].sort((x, y) => x.a - y.a || x.b - y.b)
  const forcas = escalar(listaLig.map((l) => l.cosseno))
  const ligacoesTemas: LigacaoTemaVisual[] = listaLig.map((l, i) => {
    const pares = paresEntre.get(`${l.a}:${l.b}`) ?? 0
    const motivoPares = pares === 0 ? 'nenhum par de memórias parecidas entre os dois' : pares === 1 ? '1 par de memórias parecidas entre os dois' : `${pares} pares de memórias parecidas entre os dois`
    return {
      a: l.a,
      b: l.b,
      forca: r3(0.15 + 0.85 * forcas[i]),
      cosseno: r3(l.cosseno),
      pares,
      motivo: `Assuntos próximos (semelhança ${virgula(l.cosseno)}); ${motivoPares}.`
    }
  })

  // ---- posições do grafo de temas ----
  const gTemas = new Graph({ type: 'undirected' })
  const giro = aleatorio(32)
  nomes.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / nomes.length
    gTemas.addNode(String(i), { x: Math.cos(ang) * 10 + giro(), y: Math.sin(ang) * 10 + giro(), size: 2 + Math.sqrt(contagem.get(n) ?? 1) })
  })
  for (const l of ligacoesTemas) gTemas.addEdge(String(l.a), String(l.b), { weight: l.forca })
  posicionar(gTemas, 800, { adjustSizes: true, gravity: 2 })

  // ---- palavras características e contagem por nível ----
  const grupos = new Map<string, string[]>(nomes.map((n) => [n, []]))
  const porNivel = nomes.map(() => nivelVazio())
  memorias.forEach((m, i) => {
    grupos.get(m.tema)?.push(m.texto)
    porNivel[temaDe[i]][m.nivel] += 1
  })
  const palavras = palavrasCaracteristicas(grupos, 6)

  const temas: TemaVisual[] = nomes.map((nome, i) => {
    const pos = gTemas.getNodeAttributes(String(i))
    return {
      nome,
      total: contagem.get(nome) ?? 0,
      porNivel: porNivel[i],
      palavras: palavras.get(nome) ?? [],
      cor: nome === TEMA_GERAL ? COR_GERAL : CORES[i % CORES.length],
      x: r2(pos.x),
      y: r2(pos.y)
    }
  })

  // ---- posições do grafo de memórias: partem da posição do tema, depois ForceAtlas2 ----
  const gMem = new Graph({ type: 'undirected' })
  const sorte = aleatorio(592)
  memorias.forEach((_, i) => {
    const t = temas[temaDe[i]]
    gMem.addNode(String(i), { x: t.x * 4 + (sorte() - 0.5) * 6, y: t.y * 4 + (sorte() - 0.5) * 6, size: 1 })
  })
  for (const l of parecidas) gMem.addEdge(String(l.a), String(l.b), { weight: Math.max(0.05, l.cosseno) })
  posicionar(gMem, 600, { barnesHutOptimize: true, gravity: 1, scalingRatio: 4 })

  const saida: MemoriaVisual[] = memorias.map((m, i) => {
    const pos = gMem.getNodeAttributes(String(i))
    return {
      caminho: m.caminho,
      titulo: m.titulo,
      gancho: m.gancho,
      tema: temaDe[i],
      nivel: m.nivel,
      data: m.data,
      origemData: m.origemData,
      sempre: m.sempre,
      x: r2(pos.x),
      y: r2(pos.y)
    }
  })

  return {
    geradoEm: new Date().toISOString(),
    hoje: opcoes.hoje,
    modelo: opcoes.modelo,
    parecida: { vizinhos: k, limiar },
    temas,
    ligacoesTemas,
    memorias: saida,
    parecidas: parecidas.map((l) => [l.a, l.b, r3(l.cosseno)])
  }
}
