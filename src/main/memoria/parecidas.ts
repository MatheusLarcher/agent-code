/**
 * As memórias que o memorista vê antes de gravar (D26, REGRAS-MEMORIA §2): as ~10 mais
 * parecidas com o turno, em vez das 40 primeiras do índice — que era a causa das repetidas
 * (com 592 memórias, a parecida quase nunca estava entre as 40).
 *
 * Só palavras (MiniSearch, tolera erro de digitação e prefixo): roda em milissegundos e não
 * carrega o modelo de sentido na RAM (D44). O cabeçalho entra na busca, então os gatilhos e
 * termos do layout novo (D48) ajudam a achar.
 */
import MiniSearch from 'minisearch'
import { lerCampos } from './cabecalho'

export interface MemoriaParaComparar {
  relPath: string
  title: string
  hook: string
  body: string
  updatedAt?: string
}

export const MEMORISTA_PARECIDAS = 10

function semAcento(termo: string): string {
  return termo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * Até `n` memórias mais parecidas com `texto`, melhor primeiro. Sem nenhuma parecida (turno
 * de assunto novo, acervo vazio), completa com as modificadas por último: o modelo ainda vê
 * o estilo e os temas do acervo.
 */
export function memoriasParecidas<T extends MemoriaParaComparar>(memorias: readonly T[], texto: string, n = MEMORISTA_PARECIDAS): T[] {
  if (memorias.length <= n) return [...memorias]
  const ms = new MiniSearch<{ id: number; title: string; hook: string; body: string; path: string }>({
    fields: ['title', 'hook', 'body', 'path'],
    processTerm: (t) => (t.length < 3 ? null : semAcento(t)),
    searchOptions: { boost: { title: 2, hook: 2 }, fuzzy: 0.2, prefix: true, combineWith: 'OR' }
  })
  ms.addAll(memorias.map((m, id) => ({ id, title: m.title, hook: m.hook, body: m.body.slice(0, 4000), path: m.relPath.replace(/[/.-]/g, ' ') })))
  const achadas = ms.search(texto.slice(0, 4000)).slice(0, n).map((r) => memorias[r.id as number])
  if (achadas.length >= n) return achadas
  const ja = new Set(achadas)
  const recentes = [...memorias].filter((m) => !ja.has(m)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return [...achadas, ...recentes.slice(0, n - achadas.length)]
}

/** Tema de uma memória: o declarado no cabeçalho, senão a pasta, senão `geral` (D33). */
export function temaDaMemoria(m: Pick<MemoriaParaComparar, 'relPath' | 'body'>): string {
  return lerCampos(m.body).tema ?? (m.relPath.includes('/') ? m.relPath.split('/')[0] : 'geral')
}

/** Temas do acervo com a contagem, mais usados primeiro (para o memorista reusar). */
export function temasDoAcervo(memorias: readonly Pick<MemoriaParaComparar, 'relPath' | 'body'>[]): Array<{ tema: string; memorias: number }> {
  const conta = new Map<string, number>()
  for (const m of memorias) {
    const t = temaDaMemoria(m)
    conta.set(t, (conta.get(t) ?? 0) + 1)
  }
  return [...conta].map(([tema, n]) => ({ tema, memorias: n })).sort((a, b) => b.memorias - a.memorias || a.tema.localeCompare(b.tema))
}
