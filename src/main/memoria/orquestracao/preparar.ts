/**
 * Monta tudo o que a busca nova precisa a partir da pasta de memórias: fichas, vetores
 * (mesmo cache do ordenador), sentido, catálogo e grafos — e, se pedido, a 1ª passada do
 * bibliotecário (só simulação: muda o tema em memória, não grava nada).
 * Feito uma vez; refeito quando as memórias mudam (no app: a cada passada do bibliotecário).
 */
import { listMemoryFiles } from '../../memoryIndex'
import { embedderFor, memoryVectors, type EmbedFn } from '../../memoryRanker'
import { aplicarSugestoes, sugerirTemas, type OpcoesBibliotecario, type SugestaoTema } from './bibliotecarioTemas'
import { montarCatalogo } from './catalogo'
import { lerFichas, ligacoesDasFichas, type DatasDoBanco } from './fichas'
import { montarGrafos, type LigacaoDeclarada, type OpcoesGrafo } from './grafo'
import { montarSentido } from './sentido'
import type { ContextoBusca } from './busca'

export interface OpcoesPreparo {
  hoje?: number
  cacheDir?: string
  embed?: EmbedFn
  /** Datas que o banco guarda (D42), por caminho. */
  datas?: ReadonlyMap<string, DatasDoBanco>
  ligacoes?: readonly LigacaoDeclarada[]
  grafo?: OpcoesGrafo
  /** Roda a 1ª passada do bibliotecário (simulação) antes de montar a busca. */
  bibliotecario?: OpcoesBibliotecario | false
}

export interface BuscaPreparada {
  ctx: ContextoBusca
  sugestoes: SugestaoTema[]
}

export async function prepararBusca(dir: string, o: OpcoesPreparo = {}): Promise<BuscaPreparada> {
  const hoje = o.hoje ?? Date.now()
  const embed = embedderFor({ embed: o.embed })
  const files = listMemoryFiles(dir)
  let fichas = lerFichas(dir, files, hoje, o.datas)
  const vetores = await memoryVectors(dir, files, { cacheDir: o.cacheDir, embed })
  // Layout novo: um vetor por gatilho (a busca compara o pedido com cada um).
  const comGatilhos = fichas.filter((f) => f.gatilhos.length)
  const todos = comGatilhos.flatMap((f) => f.gatilhos)
  const vg = todos.length ? await embed(todos) : []
  const vetoresGatilhos = new Map<string, number[][]>()
  let k = 0
  for (const f of comGatilhos) vetoresGatilhos.set(f.id, f.gatilhos.map(() => vg[k++] ?? []))
  let sentido = montarSentido(fichas, vetores, embed, vetoresGatilhos)
  let sugestoes: SugestaoTema[] = []
  if (o.bibliotecario) {
    sugestoes = sugerirTemas(fichas, sentido, o.bibliotecario)
    fichas = aplicarSugestoes(fichas, sugestoes)
    sentido = montarSentido(fichas, vetores, embed, vetoresGatilhos)
  }
  return {
    ctx: { fichas, catalogo: montarCatalogo(fichas), sentido, grafos: montarGrafos(fichas, sentido, [...ligacoesDasFichas(fichas), ...(o.ligacoes ?? [])], o.grafo), hoje },
    sugestoes
  }
}
