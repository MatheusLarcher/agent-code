/**
 * Etapa 6 da busca nova (spec §6, D36/D41): IA de RETAGUARDA. A busca sem IA decide o que é
 * claro; a IA só entra na zona de dúvida e vê apenas as ~10 melhores candidatas (não o acervo
 * inteiro, como o seletor de hoje). "Como perguntar" vem de fora: no avaliador, o SDK direto;
 * no app, o caminho dos observadores (login do Claude, sem chave de API).
 */
import type { ContextoBusca, OpcoesBusca, ResultadoBusca } from './busca'
import { buscarMemorias, type EstadoConversa } from './busca'

export interface RespostaIA {
  texto: string
  /** Tokens de entrada gastos na pergunta (a medida de custo do projeto). */
  tokens: number
}

export type PerguntarIA = (prompt: string) => Promise<RespostaIA>

export interface OpcoesDegraus extends OpcoesBusca {
  /**
   * Melhor sentido ≥ isto: a busca decide sozinha (padrão 0,80 — quase nunca). Medido nos
   * pedidos reais: semelhança alta não garante acerto (a busca sozinha acertou 2 de 8).
   */
  confiante?: number
  /** Melhor sentido < isto: nada parecido, nenhuma memória e nenhuma IA (padrão 0,40: 16 de 21 já certos assim). */
  nadaParecido?: number
  /** Quantas candidatas a IA vê (padrão 20: a certa entra em 29 de 37, contra 25 de 37 com 10). */
  candidatas?: number
}

export interface ResultadoDegraus extends ResultadoBusca {
  decidiu: 'busca' | 'nada' | 'ia'
  tokensIA: number
}

/** Pergunta curta à IA: o pedido, o contexto e só as candidatas (título + gancho + início). */
export function montarPerguntaIA(pedido: string, contexto: string | undefined, candidatas: ReadonlyArray<{ id: string; titulo: string; gancho: string; texto: string }>): string {
  const lista = candidatas.map((c) => `- ${c.id}: ${c.titulo} — ${c.gancho} | ${c.texto.slice(0, 120)}`).join('\n')
  return [
    'Escolha quais memórias do usuário são NECESSÁRIAS para responder bem a mensagem abaixo.',
    'Só as que mudam a resposta (regra, decisão ou fato do projeto). Se nenhuma for necessária, responda [].',
    'Responda SOMENTE com uma lista JSON de caminhos, ex.: ["pasta/arquivo.md"].',
    contexto?.trim() ? `\nMensagens anteriores:\n${contexto.slice(-600)}` : '',
    `\nMensagem: ${pedido}`,
    `\nCandidatas:\n${lista}`
  ].join('\n')
}

/** Lê a lista JSON da resposta; só caminhos que estavam entre as candidatas. */
export function lerEscolhaIA(texto: string, permitidas: ReadonlySet<string>): string[] {
  const json = /\[[\s\S]*?\]/.exec(texto)?.[0]
  if (!json) return []
  try {
    const lista = JSON.parse(json) as unknown
    return Array.isArray(lista) ? [...new Set(lista.filter((x): x is string => typeof x === 'string' && permitidas.has(x)))] : []
  } catch {
    return []
  }
}

export async function buscarComRetaguarda(
  pedido: string,
  ctx: ContextoBusca,
  estado: EstadoConversa,
  perguntar: PerguntarIA,
  o: OpcoesDegraus = {},
  contexto?: string
): Promise<ResultadoDegraus> {
  const r = await buscarMemorias(pedido, ctx, estado, o, contexto)
  const sempre = r.escolhidas.filter((id) => r.comoEntrou[id] === 'sempre')
  // A decisão de chamar a IA olha só o texto das memórias; as candidatas usam também os gatilhos.
  if (r.melhorSentidoTexto >= (o.confiante ?? 0.8)) return { ...r, decidiu: 'busca', tokensIA: 0 }
  if (r.melhorSentidoTexto < (o.nadaParecido ?? 0.4)) return { ...r, escolhidas: sempre, decidiu: 'nada', tokensIA: 0 }
  const porId = new Map(ctx.fichas.map((f) => [f.id, f]))
  const candidatas = r.candidatas.slice(0, o.candidatas ?? 20).map((id) => porId.get(id)!).filter(Boolean)
  try {
    const resposta = await perguntar(montarPerguntaIA(pedido, contexto, candidatas))
    const escolha = lerEscolhaIA(resposta.texto, new Set(candidatas.map((c) => c.id)))
    const comoEntrou = { ...Object.fromEntries(sempre.map((id) => [id, 'sempre' as const])), ...Object.fromEntries(escolha.map((id) => [id, 'busca' as const])) }
    return { ...r, escolhidas: [...sempre, ...escolha.filter((id) => !sempre.includes(id))], comoEntrou, decidiu: 'ia', tokensIA: resposta.tokens }
  } catch {
    // IA fora do ar: fica com o que a busca achou (nunca trava a mensagem).
    return { ...r, decidiu: 'busca', tokensIA: 0 }
  }
}
