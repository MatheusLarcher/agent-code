/**
 * Sentido local da busca nova (spec §5, D36): vetores das memórias (transformers.js, pelo
 * mesmo cache do ordenador — `memoryVectors`) e o perfil de cada tema (média dos vetores
 * das memórias dele, D37). Nada de IA generativa: só o modelo de embeddings local.
 */
import { cosineOf, type EmbedFn } from '../../memoryRanker'
import type { FichaMemoria } from './fichas'

export interface Sentido {
  vetor(id: string): readonly number[] | undefined
  perfil(tema: string): readonly number[] | undefined
  temas(): string[]
  /** Vetor de um texto livre (o pedido). */
  consulta(texto: string): Promise<number[]>
  cos(a: readonly number[] | undefined, b: readonly number[] | undefined): number
  /** Relevância de uma memória para o pedido: a maior semelhança entre o texto dela e cada gatilho. */
  relevancia(q: readonly number[], id: string): number
}

/** Média dos vetores, normalizada (vetor vazio quando não há nenhum). */
export function media(vetores: readonly (readonly number[])[]): number[] {
  const validos = vetores.filter((v) => v.length > 0)
  if (!validos.length) return []
  const soma = new Array<number>(validos[0].length).fill(0)
  for (const v of validos) for (let i = 0; i < soma.length; i++) soma[i] += v[i] ?? 0
  const norma = Math.hypot(...soma) || 1
  return soma.map((x) => x / norma)
}

export function montarSentido(
  fichas: readonly FichaMemoria[],
  vetores: ReadonlyMap<string, readonly number[]>,
  embed: EmbedFn,
  /** Vetores dos gatilhos de cada memória (layout novo), por id. */
  vetoresGatilhos: ReadonlyMap<string, readonly (readonly number[])[]> = new Map()
): Sentido {
  const porTema = new Map<string, (readonly number[])[]>()
  for (const f of fichas) {
    const v = vetores.get(f.id)
    if (v?.length) porTema.set(f.tema, [...(porTema.get(f.tema) ?? []), v])
  }
  const perfis = new Map([...porTema].map(([t, vs]) => [t, media(vs)]))
  const memo = new Map<string, Promise<number[]>>()
  return {
    vetor: (id) => vetores.get(id),
    perfil: (tema) => perfis.get(tema),
    temas: () => [...perfis.keys()],
    consulta(texto) {
      let p = memo.get(texto)
      if (!p) {
        p = embed([texto]).then((vs) => vs[0] ?? [])
        memo.set(texto, p)
      }
      return p
    },
    cos: (a, b) => (a && b ? cosineOf(a, b) : 0),
    relevancia(q, id) {
      const base = vetores.get(id)
      let melhor = base?.length ? cosineOf(q, base) : 0
      for (const g of vetoresGatilhos.get(id) ?? []) melhor = Math.max(melhor, cosineOf(q, g))
      return melhor
    }
  }
}
