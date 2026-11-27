/**
 * Busca nova de memórias por mensagem, SEM IA (spec §6, D36): etapas 0–5.
 *   0 tema da conversa · 1 direto (sempre/observações/fast do tema) · 2 busca no tema
 *   (palavras + sentido por RRF, peso por nível, recência e importância) · 3 espalhar no
 *   grafo (PageRank personalizado) · 4 temas ligados (peso menor) · 5 decisão.
 * A etapa 6 (IA em degraus quando a confiança é baixa) fica fora daqui (F5).
 */
import { TEMA_GERAL, type FichaMemoria, type Nivel } from './fichas'
import type { Catalogo } from './catalogo'
import type { Sentido } from './sentido'
import { pagerankPersonalizado, type Grafos } from './grafo'

export type ComoEntrou = 'sempre' | 'direto' | 'busca' | 'grafo' | 'tema-ligado'

export interface ContextoBusca {
  fichas: readonly FichaMemoria[]
  catalogo: Catalogo
  sentido: Sentido
  grafos: Grafos
  hoje: number
}

/** O que a conversa carrega de uma mensagem para a outra (D32: a conversa emenda no tema). */
export interface EstadoConversa {
  tema: string | null
}

export interface OpcoesBusca {
  max?: number
  /** Fica quem tem nota ≥ corteRelativo × a melhor (padrão 0,35). */
  corteRelativo?: number
  /** Cosseno mínimo para entrar só pelo sentido, sem palavra em comum (padrão 0,40). */
  corteSentido?: number
  /** Vantagem que um tema novo precisa sobre o atual para trocar (padrão 0,10). */
  folgaTema?: number
  /** Nota mínima para a conversa ganhar um tema (padrão 0,30). */
  notaMinimaTema?: number
  /** Força mínima da ligação para um tema ligado entrar na etapa 4 (padrão 0,55). */
  forcaTemaLigado?: number
  /** Quantas das melhores viram semente do PageRank (padrão 3). */
  sementes?: number
  /**
   * 'filtro' (D36, padrão): procura só no tema da conversa (+ ligados fortes).
   * 'peso': procura no acervo todo e só dá vantagem ao tema — em teste: com memórias
   * bagunçadas, o filtro escondia as soltas, as regras gerais e o 2º assunto do pedido.
   */
  modoTema?: 'filtro' | 'peso'
}

export interface ResultadoBusca {
  tema: string | null
  escolhidas: string[]
  comoEntrou: Record<string, ComoEntrou>
  /** Maior cosseno entre as escolhidas pela busca (base da etapa 6, F5). 0 = nada achado. */
  confianca: number
  /** Maior semelhança do pedido com QUALQUER memória, contando os gatilhos. */
  melhorSentido: number
  /**
   * Maior semelhança só com o TEXTO das memórias (sem gatilhos). Decide se vale chamar a IA:
   * gatilhos curtos e informais "parecem" com quase todo pedido e borram essa separação.
   */
  melhorSentidoTexto: number
  /** As melhores candidatas por sentido (até 20), para a IA de retaguarda decidir na dúvida. */
  candidatas: string[]
}

// Nível, data e importância só AJUSTAM a relevância (±10%): com pesos grandes, a ordem do RRF
// (notas muito próximas) se perdia e uma memória antiga e certa caía atrás de uma nova e errada.
const PESO_NIVEL: Record<Nivel, number> = { fast: 1.1, curto: 1.05, medio: 1, longo: 0.95, observacao: 1 }
// k pequeno separa mais as posições (1/11 × 1/14) do que o k = 60 da literatura (1/61 × 1/64).
const RRF_K = 10
const DIA_MS = 86_400_000

/** Posição (1 = melhor) de cada id pela nota, maior primeiro. */
function posicoes(itens: Array<[string, number]>): Map<string, number> {
  return new Map([...itens].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id], i) => [id, i + 1]))
}

/** Recência: 1 hoje, ~0,95 com 60 dias, 0,9 sem data ou muito antiga. */
function recencia(f: FichaMemoria, hoje: number): number {
  const t = Math.max(f.ultimoUsoEm ?? -Infinity, f.modificadaEm ?? -Infinity, f.criadaEm ?? -Infinity)
  if (!Number.isFinite(t)) return 0.9
  return 0.9 + 0.1 * Math.exp(-Math.max(0, hoje - t) / DIA_MS / 120)
}

/** Etapa 0: o tema do pedido (palavras + sentido); mantém o da conversa salvo vitória clara. */
export function escolherTema(
  pedido: string,
  q: readonly number[],
  ctx: ContextoBusca,
  estado: EstadoConversa,
  o: OpcoesBusca = {}
): string | null {
  const palavras = ctx.catalogo.buscarTemas(pedido)
  const maxPal = palavras[0]?.nota ?? 0
  const pal = new Map(palavras.map((p) => [p.id, maxPal > 0 ? p.nota / maxPal : 0]))
  const notas = ctx.sentido
    .temas()
    .filter((t) => t !== TEMA_GERAL)
    .map((t) => ({ t, nota: 0.5 * (pal.get(t) ?? 0) + 0.5 * Math.max(0, ctx.sentido.cos(q, ctx.sentido.perfil(t))) }))
    .sort((a, b) => b.nota - a.nota || a.t.localeCompare(b.t))
  const melhor = notas[0]
  if (estado.tema) {
    const atual = notas.find((n) => n.t === estado.tema)?.nota ?? 0
    if (!melhor || melhor.t === estado.tema || melhor.nota < atual + (o.folgaTema ?? 0.1)) return estado.tema
  }
  return melhor && melhor.nota >= (o.notaMinimaTema ?? 0.3) ? melhor.t : estado.tema
}

/** Etapa 2/4: notas das fichas de `temas` para o pedido (RRF de palavras e sentido × pesos). */
function notasNosTemas(pedido: string, q: readonly number[], temas: ReadonlySet<string> | null, ctx: ContextoBusca, o: OpcoesBusca) {
  const pool = ctx.fichas.filter((f) => !f.sempre && (!temas || temas.has(f.tema)))
  const lex = ctx.catalogo.buscarMemorias(pedido, temas ?? undefined)
  const comPalavra = new Set(lex.map((l) => l.id))
  const cos = new Map(pool.map((f) => [f.id, ctx.sentido.relevancia(q, f.id)]))
  const rLex = posicoes(lex.filter((l) => cos.has(l.id)).map((l) => [l.id, l.nota]))
  const rSem = posicoes([...cos])
  const out = new Map<string, { nota: number; cos: number }>()
  for (const f of pool) {
    const c = cos.get(f.id) ?? 0
    // Piso de sentido: palavra em comum sozinha não basta ("conta" ≠ "prestação de contas").
    const piso = o.corteSentido ?? 0.4
    if (c < (comPalavra.has(f.id) ? piso * 0.75 : piso)) continue
    const rrf = (rLex.has(f.id) ? 1 / (RRF_K + rLex.get(f.id)!) : 0) + 1 / (RRF_K + rSem.get(f.id)!)
    const peso = PESO_NIVEL[f.nivel] * recencia(f, ctx.hoje) * (0.95 + 0.025 * (f.importancia - 1))
    out.set(f.id, { nota: rrf * peso, cos: c })
  }
  return out
}

/**
 * `contexto` = as mensagens anteriores da conversa. Pedido real costuma ser curto e depender
 * delas ("só o de domingo", "me dá o link"): a busca procura pelo pedido JUNTO com o contexto
 * (palavras e sentido) e o tema da conversa sai dos dois.
 */
export async function buscarMemorias(
  pedido: string,
  ctx: ContextoBusca,
  estado: EstadoConversa,
  o: OpcoesBusca = {},
  contexto?: string
): Promise<ResultadoBusca> {
  const max = o.max ?? 8
  // 600 caracteres de contexto bastam (medido: 1.200 não trouxe nenhuma memória certa a mais).
  const texto = contexto?.trim() ? `${pedido}\n${contexto.slice(-600)}` : pedido
  pedido = texto
  const q = await ctx.sentido.consulta(texto)
  const tema = escolherTema(texto, q, ctx, estado, o)
  estado.tema = tema
  const aposentadas = ctx.grafos.aposentadas()
  const como: Record<string, ComoEntrou> = {}
  const escolhidas: string[] = []
  const entra = (id: string, c: ComoEntrou): void => {
    if (escolhidas.length >= max || como[id] || aposentadas.has(id)) return
    como[id] = c
    escolhidas.push(id)
  }

  // Etapa 1: direto — sempre, e observações + fast do tema.
  for (const f of ctx.fichas) if (f.sempre) entra(f.id, 'sempre')
  if (tema) for (const f of ctx.fichas) if (f.tema === tema && (f.nivel === 'observacao' || f.nivel === 'fast')) entra(f.id, 'direto')

  // Etapa 2: busca no tema (sem tema, ou no modo 'peso': no acervo todo, com vantagem ao tema).
  const porPeso = o.modoTema === 'peso'
  const notas = notasNosTemas(pedido, q, tema && !porPeso ? new Set([tema]) : null, ctx, o)
  if (porPeso && tema) {
    const ligados = new Set(ctx.grafos.temasLigados(tema).filter((l) => l.forca >= (o.forcaTemaLigado ?? 0.55)).map((l) => l.tema))
    const temaDe = new Map(ctx.fichas.map((f) => [f.id, f.tema]))
    for (const [id, v] of notas) v.nota *= temaDe.get(id) === tema ? 1.25 : ligados.has(temaDe.get(id)!) ? 1.1 : 1
  }
  const candidatos = new Map<string, { nota: number; cos: number; como: ComoEntrou }>()
  for (const [id, v] of notas) candidatos.set(id, { ...v, como: 'busca' })

  // Etapa 3: espalhar pelo grafo a partir das melhores.
  const sementes = [...notas].sort((a, b) => b[1].nota - a[1].nota).slice(0, o.sementes ?? 3)
  if (sementes.length) {
    const pr = pagerankPersonalizado(ctx.grafos.memorias, new Map(sementes.map(([id, v]) => [id, v.nota])))
    const topoSemente = Math.max(...sementes.map(([id]) => pr.get(id) ?? 0))
    const melhorNota = sementes[0][1].nota
    for (const [id, p] of pr) {
      if (candidatos.has(id) || p <= 0 || topoSemente <= 0) continue
      const rel = p / topoSemente
      // Vizinho no grafo só entra se também tiver relação com o pedido (senão é o tema inteiro).
      const c = ctx.sentido.relevancia(q, id)
      if (rel >= 0.25 && c >= (o.corteSentido ?? 0.4) * 0.75) candidatos.set(id, { nota: 0.5 * rel * melhorNota, cos: c, como: 'grafo' })
    }
  }

  // Etapa 4: temas ligados fortes (inclui o geral, D33), com peso menor. (No modo 'peso' já entraram.)
  if (tema && !porPeso) {
    const ligados = ctx.grafos.temasLigados(tema).filter((l) => l.forca >= (o.forcaTemaLigado ?? 0.55))
    if (ligados.length) {
      for (const [id, v] of notasNosTemas(pedido, q, new Set(ligados.map((l) => l.tema)), ctx, o)) {
        if (!candidatos.has(id)) candidatos.set(id, { nota: 0.5 * v.nota, cos: v.cos, como: 'tema-ligado' })
      }
    }
  }

  // Etapa 5: decisão — corte relativo à melhor, até `max`; contradição entra em par.
  // Nada relevante de verdade (melhor sentido abaixo do piso) → só o que é `sempre`/direto.
  const melhorCos = Math.max(0, ...[...candidatos.values()].filter((v) => v.como === 'busca').map((v) => v.cos))
  const ordem = melhorCos < (o.corteSentido ?? 0.4) ? [] : [...candidatos].filter(([id]) => !aposentadas.has(id)).sort((a, b) => b[1].nota - a[1].nota || a[0].localeCompare(b[0]))
  const topo = ordem[0]?.[1].nota ?? 0
  for (const [id, v] of ordem) {
    if (v.nota < (o.corteRelativo ?? 0.35) * topo) break
    entra(id, v.como)
    for (const par of ctx.grafos.contradiz(id)) entra(par, v.como)
  }
  const confianca = Math.max(0, ...escolhidas.filter((id) => como[id] === 'busca').map((id) => candidatos.get(id)?.cos ?? 0))
  const porSentido = ctx.fichas
    .filter((f) => !f.sempre && !aposentadas.has(f.id))
    .map((f) => ({ id: f.id, c: ctx.sentido.relevancia(q, f.id) }))
    .sort((a, b) => b.c - a.c || a.id.localeCompare(b.id))
  const melhorSentidoTexto = Math.max(0, ...ctx.fichas.filter((f) => !f.sempre).map((f) => ctx.sentido.cos(q, ctx.sentido.vetor(f.id))))
  return { tema, escolhidas, comoEntrou: como, confianca, melhorSentido: porSentido[0]?.c ?? 0, melhorSentidoTexto, candidatas: porSentido.slice(0, 20).map((x) => x.id) }
}
