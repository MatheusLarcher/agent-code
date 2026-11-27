/**
 * Catálogo da busca nova (spec §5, D36/D37): índice por palavras das fichas de memória e
 * de tema, com MiniSearch — tolera erro de digitação, prefixo e acento. É a porta de entrada
 * da busca: a etapa 0 acha o tema, a etapa 2 procura dentro dele.
 */
import MiniSearch from 'minisearch'
import type { FichaMemoria } from './fichas'

/** Minúsculo e sem acento: "Fácil" e "facil" são a mesma palavra. */
export function normalizarTermo(termo: string): string {
  return termo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const STOP = new Set(
  'a o e de da do das dos em no na nos nas um uma uns umas para pra por com sem que se ao aos as os isso esse essa este esta meu minha voce vc eu ele ela ja nao sim mais muito bom dia'
    .split(' ')
)

const opcoes = {
  processTerm: (t: string): string | null => {
    const n = normalizarTermo(t)
    return n.length < 2 || STOP.has(n) ? null : n
  }
}

export interface Achado {
  id: string
  nota: number
}

export interface Catalogo {
  /** Memórias por palavras, opcionalmente só dos temas dados. Melhor primeiro. */
  buscarMemorias(texto: string, temas?: ReadonlySet<string>): Achado[]
  /** Temas por palavras (nome + títulos + ganchos das memórias do tema). Melhor primeiro. */
  buscarTemas(texto: string): Achado[]
}

export function montarCatalogo(fichas: readonly FichaMemoria[]): Catalogo {
  const memorias = new MiniSearch<FichaMemoria>({
    fields: ['titulo', 'gancho', 'texto', 'tema', 'gatilhos', 'termos'],
    storeFields: ['tema'],
    // Gatilhos e termos (layout novo) são listas: entram como texto corrido.
    extractField: (doc, campo) => {
      const v = (doc as unknown as Record<string, unknown>)[campo]
      return Array.isArray(v) ? v.join(' ') : String(v ?? '')
    },
    ...opcoes,
    searchOptions: { boost: { titulo: 2, gancho: 1.5, tema: 1.5, gatilhos: 2, termos: 2 }, fuzzy: 0.2, prefix: true, combineWith: 'OR' }
  })
  memorias.addAll(fichas)

  const porTema = new Map<string, string[]>()
  for (const f of fichas) porTema.set(f.tema, [...(porTema.get(f.tema) ?? []), f.titulo, f.gancho])
  const temas = new MiniSearch<{ id: string; nome: string; resumo: string }>({
    fields: ['nome', 'resumo'],
    ...opcoes,
    searchOptions: { boost: { nome: 3 }, fuzzy: 0.2, prefix: true, combineWith: 'OR' }
  })
  temas.addAll([...porTema].map(([nome, textos]) => ({ id: nome, nome, resumo: textos.join('. ') })))

  return {
    buscarMemorias(texto, filtro) {
      return memorias
        .search(texto, filtro ? { filter: (r) => filtro.has(r.tema as string) } : undefined)
        .map((r) => ({ id: String(r.id), nota: r.score }))
    },
    buscarTemas(texto) {
      return temas.search(texto).map((r) => ({ id: String(r.id), nota: r.score }))
    }
  }
}
