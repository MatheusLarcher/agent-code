/**
 * Formato de `dados.js` (`window.GRAFO`), escrito pelo `gerar.ts` e lido pela página.
 * Índices numéricos em vez de caminhos para o arquivo ficar pequeno.
 */
import type { Nivel } from './dados'

export interface TemaVisual {
  nome: string
  total: number
  porNivel: Record<Nivel, number>
  /** Palavras que aparecem muito neste tema e pouco nos outros. */
  palavras: string[]
  cor: string
  x: number
  y: number
}

export interface LigacaoTemaVisual {
  a: number
  b: number
  /** 0–1, reescalado entre as ligações mostradas. */
  forca: number
  cosseno: number
  /** Pares de memórias parecidas que cruzam os dois temas. */
  pares: number
  motivo: string
}

export interface MemoriaVisual {
  caminho: string
  titulo: string
  gancho: string
  tema: number
  nivel: Exclude<Nivel, 'observacoes'>
  /** AAAA-MM-DD ou null quando o texto não traz data. */
  data: string | null
  /** De onde veio a data: o cabeçalho da memória ou o corpo do texto. */
  origemData: 'cabecalho' | 'texto' | null
  sempre: boolean
  x: number
  y: number
}

export interface Grafo {
  geradoEm: string
  hoje: string
  modelo: string
  parecida: { vizinhos: number; limiar: number }
  temas: TemaVisual[]
  ligacoesTemas: LigacaoTemaVisual[]
  memorias: MemoriaVisual[]
  /** [i, j, cosseno] entre memórias (i < j). */
  parecidas: Array<[number, number, number]>
}
