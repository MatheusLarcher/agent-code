// Compara quem escolhe melhor as memórias de cada pedido: o modelo atual do app
// (Sonnet), o Haiku e a busca por palavras (sem IA). Só LÊ a pasta de memórias.
// Resultados vão para fora do repositório (padrão: %USERPROFILE%\agent-code-ambiente\resultados).
//
// Rodar (da raiz do repositório):
//   npx esbuild scripts/medicoes/avaliar-escolha-memorias.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/.avaliar.tmp.mjs
//   node scripts/medicoes/.avaliar.tmp.mjs --pasta <memorias> --casos <casos.json> [--seletores sonnet,haiku,lexical] [--repeticoes 3] [--saida <pasta>] [--timeout 30000] [--sem-juiz]
//   (apague o .tmp.mjs depois)
//   node scripts/medicoes/.avaliar.tmp.mjs --preparar          cria %USERPROFILE%\agent-code-ambiente\{memorias,casos,resultados} + LEIAME
//   node scripts/medicoes/.avaliar.tmp.mjs --exemplo [destino]  copia as memórias fictícias (padrão: %TEMP%\agent-code-memorias-ficticias)
//   Nenhum dos dois sobrescreve o que já existe.
//
// Seletores: sonnet (o do app), haiku (claude-haiku-5-5), lexical (sem IA) ou
// qualquer id de modelo começando por "claude-". Com o ordenador local
// (src/main/memoryRanker.ts: palavras + embeddings locais + recência, por RRF):
//   local-hibrido: sem IA, as primeiras com cosseno >= --corte-hibrido (padrão 0.5, -1 = sem corte),
//   até --max-hibrido (padrão 6, teto 10); com --mmr <λ> (0 a 1, ex.: 0.7) escolhe por MMR
//   grafo: a busca nova (src/main/memoria/orquestracao, etapas 0–5), sem IA; --com-bibliotecario roda
//   antes a 1ª passada do bibliotecário (simulação: soltas no tema certo); --pastas-genericas projetos,regras;
//   ajuste: --max-grafo (8), --corte-relativo (0.35), --corte-sentido (0.40), --folga-bibliotecario (0.04), --modo-tema filtro|peso
//   (relevância menos parecença com as já escolhidas), para não trazer memórias repetidas.
// Vetores em cache em --cache-vetores (padrão <saida>/vetores-cache). O formato de casos.json está
// em LEIAME.md da pasta do ambiente e em lerCasos (avaliar-escolha-memorias-metricas.ts).
// Custo: o resumo mostra TOKENS de entrada por pedido primeiro; US$ é secundário.
//
// Juiz (padrão ligado; --sem-juiz desliga): cada memória escolhida fora das
// esperadas e das aceitáveis vai ao Sonnet (juiz-memorias.ts), que diz se ela é
// útil, neutra ou atrapalha. Vereditos ficam em <saida>/juiz-cache.json.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  HAIKU_MEMORY_MAX,
  HAIKU_MEMORY_TIMEOUT_MS,
  MEMORY_SELECTOR_MODEL,
  parseHaikuMemoryChoice,
  selectMemoriesWithHaiku,
  type MemoryQuery
} from '../../src/main/memorySelectionHaiku'
import {
  assembleMemories,
  listMemoryFiles,
  MAX_SELECTED_MEMORIES,
  MIN_LEXICAL_SCORE,
  pinnedMemoryPaths,
  rankMemoriesByQuery,
  readMemoryBody
} from '../../src/main/memoryIndex'
import {
  caminhosDoCaso,
  extrasDe,
  lerCasos,
  pontuar,
  resumir,
  resumoMarkdown,
  semConceitosSempre,
  type Caso,
  type ContagemExtras,
  type Execucao,
  type Veredito
} from './avaliar-escolha-memorias-metricas'
import { CacheDoJuiz, JUIZ_MODELO, julgarExtra, type JuizQuery } from './juiz-memorias'
import { prepararBusca, type BuscaPreparada } from '../../src/main/memoria/orquestracao/preparar'
import { buscarMemorias, type OpcoesBusca } from '../../src/main/memoria/orquestracao/busca'
import { buscarComRetaguarda, type OpcoesDegraus, type PerguntarIA } from '../../src/main/memoria/orquestracao/degraus'
import { interpretarSeletor, opcoesHibrido, ordenadorMedido, type OpcoesHibrido, type OrdenadorMedido, type Seletor } from './seletor-ordenador'

const AMBIENTE = join(homedir(), 'agent-code-ambiente')
const APELIDOS: Record<string, string> = { sonnet: MEMORY_SELECTOR_MODEL, haiku: 'claude-haiku-5-5' }

const SEM_VALOR = new Set(['com-bibliotecario', 'preparar', 'exemplo', 'juiz', 'sem-juiz'])

function argumentos(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`argumento inesperado: ${a}`)
    if (a.includes('=')) {
      out[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
      continue
    }
    const k = a.slice(2)
    const prox = argv[i + 1]
    if (prox === undefined || prox.startsWith('--')) {
      if (!SEM_VALOR.has(k)) throw new Error(`--${k} precisa de um valor`)
      out[k] = ''
      continue
    }
    out[k] = prox
    i++
  }
  return out
}

/** Os modelos do ambiente (LEIAME, casos de exemplo e memórias fictícias), versionados ao lado do script. */
const MODELOS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ambiente-memorias')

/** Copia sem sobrescrever nada que já exista no destino. */
function copiarSemSobrescrever(origem: string, destino: string): void {
  if (!existsSync(origem)) throw new Error(`modelo não encontrado: ${origem} (rode o script a partir de scripts/medicoes/)`)
  cpSync(origem, destino, { recursive: true, force: false, errorOnExist: false })
}

/** --preparar: cria %USERPROFILE%\agent-code-ambiente\{memorias,casos,resultados} com o LEIAME e os casos de exemplo. */
function preparar(): void {
  for (const sub of ['memorias', 'casos', 'resultados']) mkdirSync(join(AMBIENTE, sub), { recursive: true })
  copiarSemSobrescrever(join(MODELOS_DIR, 'LEIAME.md'), join(AMBIENTE, 'LEIAME.md'))
  copiarSemSobrescrever(join(MODELOS_DIR, 'casos-exemplo.json'), join(AMBIENTE, 'casos', 'casos-exemplo.json'))
  console.log(`Ambiente pronto em ${AMBIENTE} (nada que já existia foi sobrescrito). Leia ${join(AMBIENTE, 'LEIAME.md')}.`)
}

/** --exemplo [destino]: copia as memórias fictícias (para testar o script sem memórias de ninguém). */
function exemplo(destino: string): void {
  const alvo = resolve(destino || join(tmpdir(), 'agent-code-memorias-ficticias'))
  copiarSemSobrescrever(join(MODELOS_DIR, 'memorias-ficticias'), alvo)
  console.log(`Memórias fictícias em ${alvo}. Casos de exemplo: ${join(MODELOS_DIR, 'casos-exemplo.json')}`)
}

/** A pasta do repositório git que contém `p`, ou null. */
function repoDe(p: string): string | null {
  for (let d = resolve(p); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}

const dentro = (pai: string, filho: string): boolean => {
  const r = relative(resolve(pai), resolve(filho))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Resultado de uma pessoa nunca vai para dentro de um repositório (nem deste, nem de outro). */
function conferirSaida(saida: string): void {
  const aqui = dirname(fileURLToPath(import.meta.url))
  for (const repo of [repoDe(aqui), repoDe(process.cwd()), repoDe(saida)]) {
    if (repo && dentro(repo, saida)) throw new Error(`--saida está dentro do repositório ${repo}; use uma pasta fora dele (padrão: ${join(AMBIENTE, 'resultados')})`)
  }
}

interface Rodada {
  falhou: boolean
  erro?: string
  escolhidas: string[]
  entregues: string[]
  custoUsd?: number
  tokensEntrada?: number
  msOrdenador?: number
}

/** O seletor de IA do app com o modelo dado, guardando a resposta crua (a escolha antes do teto de caracteres). */
async function rodarModelo(dir: string, caso: Caso, modelo: string, timeoutMs: number, existentes: Set<string>): Promise<Rodada> {
  let texto = ''
  let custoUsd: number | undefined
  let tokensEntrada: number | undefined
  let erro: string | undefined
  const run: MemoryQuery = (args) => {
    const it = query(args as Parameters<typeof query>[0])
    return (async function* () {
      for await (const m of it) {
        const x = m as { type?: string; is_error?: boolean; error?: unknown; total_cost_usd?: number; result?: unknown; usage?: Record<string, number>; message?: { content?: Array<{ type: string; text?: string }> } }
        if (x.type === 'assistant') {
          if (x.error) erro = String(x.error)
          for (const b of x.message?.content ?? []) if (b.type === 'text' && b.text) texto += b.text
        }
        if (x.type === 'result') {
          custoUsd = x.total_cost_usd
          const u = x.usage ?? {}
          tokensEntrada = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
          if (x.is_error) erro = typeof x.result === 'string' ? x.result.slice(0, 200) : 'erro do SDK'
        }
        yield m
      }
    })()
  }
  const conversa = caso.conversa
  const r = await selectMemoriesWithHaiku(dir, caso.pedido, {
    query: run,
    model: modelo,
    timeoutMs,
    ...(conversa ? { conversation: (max: number) => conversa.slice(-max) } : {})
  })
  if (r === null) {
    const motivo = erro ?? (texto ? 'resposta sem JSON' : `sem resposta em ${timeoutMs} ms`)
    return { falhou: true, erro: motivo, escolhidas: [], entregues: [], custoUsd, tokensEntrada }
  }
  const pedidas = [...new Set((parseHaikuMemoryChoice(texto) ?? []).filter((p) => existentes.has(p)))].slice(0, HAIKU_MEMORY_MAX)
  return { falhou: false, escolhidas: pedidas, entregues: [...r.relPaths], custoUsd, tokensEntrada }
}

/** local-hibrido: só o ordenador local (e o MMR, se pedido), sem IA (0 tokens). */
async function rodarHibrido(dir: string, caso: Caso, ordenador: OrdenadorMedido, opcoes: OpcoesHibrido): Promise<Rodada> {
  const escolhidas = await ordenador.escolher(dir, caso.pedido, listMemoryFiles(dir), opcoes)
  return { falhou: false, escolhidas, entregues: assembleMemories(dir, escolhidas).relPaths, tokensEntrada: 0, msOrdenador: ordenador.tomarMs() }
}

/** grafo: a busca nova, sem IA (0 tokens). Cada caso é uma conversa nova (tema do zero). */
async function rodarGrafo(dir: string, caso: Caso, preparada: BuscaPreparada, opcoes: OpcoesBusca): Promise<Rodada> {
  const t0 = performance.now()
  const r = await buscarMemorias(caso.pedido, preparada.ctx, { tema: null }, opcoes, caso.conversa)
  const msOrdenador = Math.round(performance.now() - t0)
  return { falhou: false, escolhidas: r.escolhidas, entregues: assembleMemories(dir, r.escolhidas).relPaths, tokensEntrada: 0, msOrdenador }
}

/** A IA de retaguarda pelo SDK (login do Claude, nada do ambiente): devolve o texto e os tokens de entrada. */
function perguntarPeloSdk(modelo: string, timeoutMs: number): PerguntarIA {
  return async (prompt) => {
    let texto = ''
    let tokens = 0
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const it = query({
        prompt,
        options: { model: modelo, tools: [], maxTurns: 1, settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, executable: 'node', abortController: ac,
          systemPrompt: 'Você escolhe memórias para um assistente. Responda só o que for pedido, no formato pedido.' }
      })
      for await (const m of it) {
        if (m.type === 'assistant') for (const b of m.message.content as Array<{ type: string; text?: string }>) if (b.type === 'text') texto += b.text ?? ''
        if (m.type === 'result') {
          const u = (m as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage ?? {}
          tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
      }
    } finally {
      clearTimeout(t)
    }
    return { texto, tokens }
  }
}

/** grafo-ia: a busca decide o que é claro; a IA só na dúvida, vendo ~10 candidatas. */
async function rodarGrafoIA(dir: string, caso: Caso, preparada: BuscaPreparada, opcoes: OpcoesDegraus, perguntar: PerguntarIA): Promise<Rodada> {
  const t0 = performance.now()
  const r = await buscarComRetaguarda(caso.pedido, preparada.ctx, { tema: null }, perguntar, opcoes, caso.conversa)
  return { falhou: false, escolhidas: r.escolhidas, entregues: assembleMemories(dir, r.escolhidas).relPaths, tokensEntrada: r.tokensIA, msOrdenador: r.decidiu === 'ia' ? undefined : Math.round(performance.now() - t0) }
}

/** A busca por palavras do app, sem IA: o ranqueamento acima da nota mínima, até 10. */
function rodarLexical(dir: string, caso: Caso): Rodada {
  const escolhidas = rankMemoriesByQuery(dir, caso.pedido)
    .filter((m) => m.score >= MIN_LEXICAL_SCORE)
    .slice(0, MAX_SELECTED_MEMORIES)
    .map((m) => m.file.relPath)
  return { falhou: false, escolhidas, entregues: assembleMemories(dir, escolhidas).relPaths, tokensEntrada: 0 }
}

const juizQuery: JuizQuery = (args) => query(args as unknown as Parameters<typeof query>[0]) as AsyncIterable<unknown>

interface Juizado {
  vereditos: NonNullable<Execucao['vereditos']>
  porCaminho: Record<string, Veredito>
  custoUsd: number
  /** Tempo das chamadas novas ao juiz; ausente se tudo veio do cache. */
  ms?: number
}

/** Julga em paralelo as extras de uma execução (o texto vem redigido, como no app). Sem veredito = conta como erro. */
async function julgarExtras(pasta: string, caso: Caso, extras: string[], cache: CacheDoJuiz, timeoutMs: number): Promise<Juizado> {
  const t0 = Date.now()
  const out: Juizado = { vereditos: {}, porCaminho: {}, custoUsd: 0 }
  let novas = 0
  await Promise.all(
    extras.map(async (p) => {
      const conteudo = readMemoryBody(pasta, p)
      if (!conteudo) return
      const r = await julgarExtra(caso.pedido, p, conteudo, { run: juizQuery, cache, timeoutMs })
      out.custoUsd += r.custoUsd
      if (!r.doCache) novas++
      if (!r.julgamento) {
        console.warn(`    juiz falhou em ${caso.id} · ${p}: ${r.erro}`)
        return
      }
      out.vereditos[p] = { ...r.julgamento, doCache: r.doCache }
      out.porCaminho[p] = r.julgamento.veredito
    })
  )
  if (novas > 0) out.ms = Date.now() - t0
  return out
}

const resumoExtras = (x: ContagemExtras): string => {
  const partes = [x.util && `${x.util} útil`, x.neutra && `${x.neutra} neutra`, x.atrapalha && `${x.atrapalha} atrapalha`, x.semJuiz && `${x.semJuiz} sem juiz`].filter(Boolean)
  return partes.length ? ` · extras: ${partes.join(', ')}` : ''
}

async function main(): Promise<void> {
  const a = argumentos(process.argv.slice(2))
  if ('preparar' in a || 'exemplo' in a) {
    if ('preparar' in a) preparar()
    if ('exemplo' in a) exemplo(a.exemplo)
    return
  }
  const pasta = resolve(a.pasta ?? join(AMBIENTE, 'memorias'))
  const arquivoCasos = resolve(a.casos ?? join(AMBIENTE, 'casos', 'casos.json'))
  const saidaBase = resolve(a.saida ?? join(AMBIENTE, 'resultados'))
  const seletores = (a.seletores ?? 'sonnet,haiku,lexical').split(',').map((s) => s.trim()).filter(Boolean)
  const repeticoes = Number(a.repeticoes ?? 3)
  const timeoutMs = Number(a.timeout ?? HAIKU_MEMORY_TIMEOUT_MS)
  if (!Number.isInteger(repeticoes) || repeticoes < 1 || repeticoes > 50) throw new Error('--repeticoes precisa ser um inteiro de 1 a 50')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout precisa ser em ms, 1000 ou mais')
  const tipos: Record<string, Seletor> = {}
  for (const s of seletores) {
    const t = interpretarSeletor(s, APELIDOS)
    if (!t) throw new Error(`seletor desconhecido: ${s} (use sonnet, haiku, lexical, local-hibrido, grafo ou um id claude-...)`)
    tipos[s] = t
  }
  const hibrido = opcoesHibrido(a['corte-hibrido'], a['max-hibrido'], a.mmr)
  const cacheVetores = resolve(a['cache-vetores'] ?? join(saidaBase, 'vetores-cache'))
  if (!existsSync(pasta)) throw new Error(`pasta de memórias não existe: ${pasta}`)
  conferirSaida(saidaBase)
  conferirSaida(cacheVetores) // os vetores vêm do texto das memórias: também ficam fora do repositório
  const repoDaPasta = repoDe(pasta)
  if (repoDaPasta) console.warn(`AVISO: a pasta de memórias está dentro do repositório ${repoDaPasta}. Memórias de outra pessoa devem ficar em ${AMBIENTE}.`)

  const casos = lerCasos(JSON.parse(readFileSync(arquivoCasos, 'utf8').replace(/^﻿/, '')))
  const arquivos = listMemoryFiles(pasta)
  if (arquivos.length === 0) throw new Error(`nenhuma memória (.md) em ${pasta}`)
  const existentes = new Set(arquivos.map((f) => f.relPath))
  const sempre = new Set(pinnedMemoryPaths(pasta))
  for (const c of casos) {
    const faltam = caminhosDoCaso(c).filter((p) => !existentes.has(p))
    if (faltam.length) console.warn(`AVISO: ${c.id} espera memórias que não existem na pasta: ${faltam.join(', ')}`)
  }
  const modelos: Record<string, string> = {}
  for (const s of seletores) {
    const t = tipos[s]
    if (t.tipo === 'modelo') modelos[s] = t.modelo
    if (t.tipo === 'grafo') modelos[s] = `sem IA (busca no grafo${'com-bibliotecario' in a ? ' + 1ª passada do bibliotecário' : ''})`
    if (t.tipo === 'grafo-ia') modelos[s] = `busca no grafo + ${t.modelo} só na dúvida`
    if (t.tipo === 'hibrido') {
      const corte = hibrido.corte <= -1 ? 'sem corte' : `cosseno >= ${hibrido.corte}`
      modelos[s] = `sem IA (${corte}, até ${hibrido.max}${hibrido.mmr !== undefined ? `, MMR λ=${hibrido.mmr}` : ''})`
    }
  }
  console.log(`${arquivos.length} memórias · ${casos.length} casos · seletores ${seletores.join(', ')} · ${repeticoes} repetição(ões)`)

  // Ordenador local: aquece uma vez (baixa o modelo de embeddings na 1ª vez e
  // calcula os vetores que faltam no cache), para o tempo por pedido não levar isso.
  const usaOrdenador = Object.values(tipos).some((t) => t.tipo === 'hibrido')
  const ordenador = ordenadorMedido({ cacheDir: cacheVetores })
  if (usaOrdenador) {
    await ordenador.ordenar(pasta, 'aquecimento', arquivos)
    // Com MMR, lê também os vetores das memórias agora (fora do tempo por pedido).
    if (hibrido.mmr !== undefined) await ordenador.escolher(pasta, 'aquecimento', arquivos, hibrido)
    console.log(`Ordenador local pronto em ${ordenador.tomarMs()} ms (vetores em ${cacheVetores})`)
  }

  const num = (k: string): number | undefined => (a[k] === undefined ? undefined : Number(a[k]))
  const opcoesGrafo: OpcoesDegraus = { max: num('max-grafo'), corteRelativo: num('corte-relativo'), corteSentido: num('corte-sentido'), modoTema: a['modo-tema'] === 'peso' ? 'peso' : 'filtro', confiante: num('confiante'), nadaParecido: num('nada-parecido') }
  // Busca nova: monta fichas, vetores, catálogo e grafos uma vez (fora do tempo por pedido).
  let preparada: BuscaPreparada | null = null
  if (Object.values(tipos).some((t) => t.tipo === 'grafo' || t.tipo === 'grafo-ia')) {
    const t0 = Date.now()
    const genericas = (a['pastas-genericas'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const folga = a['folga-bibliotecario'] === undefined ? undefined : Number(a['folga-bibliotecario'])
    preparada = await prepararBusca(pasta, { cacheDir: cacheVetores, bibliotecario: 'com-bibliotecario' in a ? { pastasGenericas: genericas, folga } : false })
    const movidas = preparada.sugestoes.filter((x) => x.para)
    console.log(`Busca no grafo pronta em ${Date.now() - t0} ms · ${preparada.ctx.grafos.temas.order} temas · ${preparada.ctx.grafos.memorias.size} ligações entre memórias` +
      ('com-bibliotecario' in a ? ` · bibliotecário: ${movidas.length} de ${preparada.sugestoes.length} sem tema foram para um tema` : ''))
    mkdirSync(saidaBase, { recursive: true })
    writeFileSync(join(saidaBase, 'bibliotecario-sugestoes.json'), JSON.stringify(preparada.sugestoes, null, 2))
  }

  const comJuiz = !('sem-juiz' in a)
  const cache = new CacheDoJuiz(join(saidaBase, 'juiz-cache.json'))
  if (comJuiz) console.log(`Juiz das extras: ${JUIZ_MODELO} · ${cache.tamanho} veredito(s) no cache`)

  const execucoes: Execucao[] = []
  // Repetição por fora e seletores alternados por dentro: nenhum seletor pega sempre o cache frio.
  for (let rep = 1; rep <= repeticoes; rep++) {
    for (const caso of casos) {
      for (const seletor of seletores) {
        const t0 = Date.now()
        const t = tipos[seletor]
        let r: Rodada
        try {
          if (t.tipo === 'lexical') r = rodarLexical(pasta, caso)
          else if (t.tipo === 'hibrido') r = await rodarHibrido(pasta, caso, ordenador, hibrido)
          else if (t.tipo === 'grafo') r = await rodarGrafo(pasta, caso, preparada!, opcoesGrafo)
          else if (t.tipo === 'grafo-ia') r = await rodarGrafoIA(pasta, caso, preparada!, opcoesGrafo, perguntarPeloSdk(t.modelo, timeoutMs))
          else r = await rodarModelo(pasta, caso, t.modelo, timeoutMs, existentes)
        } catch (e) {
          r = { falhou: true, erro: (e as Error)?.message ?? String(e), escolhidas: [], entregues: [], msOrdenador: ordenador.tomarMs() }
        }
        const ms = Date.now() - t0
        // Tempo do modelo = o resto do pedido; só existe para seletor com IA.
        const msModelo = t.tipo === 'modelo' || (t.tipo === 'grafo-ia' && r.msOrdenador === undefined) ? Math.max(0, ms - (r.msOrdenador ?? 0)) : undefined
        const escolhidas = r.escolhidas.filter((p) => !sempre.has(p))
        const entregues = r.entregues.filter((p) => !sempre.has(p))
        const esperadas = semConceitosSempre(caso.esperadas, sempre)
        const extras = r.falhou ? [] : extrasDe(escolhidas, esperadas, caso.aceitaveis)
        const juizado = comJuiz && extras.length ? await julgarExtras(pasta, caso, extras, cache, timeoutMs) : null
        const nota = r.falhou
          ? { precisao: null, cobertura: null, nota: null, extras: { util: 0, neutra: 0, atrapalha: 0, semJuiz: 0 } }
          : pontuar(escolhidas, esperadas, caso.aceitaveis, juizado?.porCaminho ?? {})
        const caracteres = r.falhou ? undefined : assembleMemories(pasta, entregues).block.length
        execucoes.push({
          caso: caso.id,
          seletor,
          repeticao: rep,
          ms,
          falhou: r.falhou,
          ...(r.erro ? { erro: r.erro } : {}),
          escolhidas,
          entregues,
          ...nota,
          ...(juizado ? { vereditos: juizado.vereditos, custoJuizUsd: juizado.custoUsd, ...(juizado.ms !== undefined ? { msJuiz: juizado.ms } : {}) } : {}),
          caracteres,
          custoUsd: r.custoUsd,
          tokensEntrada: r.tokensEntrada,
          ...(r.msOrdenador !== undefined ? { msOrdenador: r.msOrdenador } : {}),
          ...(msModelo !== undefined ? { msModelo } : {})
        })
        if (juizado) cache.salvar()
        const status = r.falhou ? `falhou (${r.erro})` : `${escolhidas.length} escolhidas · nota ${nota.nota?.toFixed(2)}${resumoExtras(nota.extras)}`
        const gasto = `${r.tokensEntrada ?? '?'} tokens${r.msOrdenador !== undefined ? ` · ordenador ${r.msOrdenador} ms` : ''}`
        console.log(`  [${rep}/${repeticoes}] ${caso.id} · ${seletor}: ${status} em ${ms} ms (${gasto})`)
      }
    }
  }
  const custoJuiz = execucoes.reduce((s, e) => s + (e.custoJuizUsd ?? 0), 0)
  const julgadas = execucoes.flatMap((e) => Object.values(e.vereditos ?? {}))
  if (comJuiz) console.log(`Juiz: ${julgadas.length} extras julgadas (${julgadas.filter((v) => v.doCache).length} do cache) · custo US$ ${custoJuiz.toFixed(4)}`)

  const quando = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const saida = join(saidaBase, quando)
  mkdirSync(saida, { recursive: true })
  const linhas = resumir(execucoes, seletores)
  const cab = { quando: new Date().toLocaleString('pt-BR'), pasta, totalMemorias: arquivos.length, sempre: [...sempre], repeticoes, modelos, juiz: comJuiz ? JUIZ_MODELO : null }
  writeFileSync(join(saida, 'resultado.json'), JSON.stringify({ ...cab, casos, resumo: linhas, execucoes }, null, 2), 'utf8')
  writeFileSync(join(saida, 'resumo.md'), resumoMarkdown(cab, linhas, execucoes, casos), 'utf8')
  console.log(`\nResultados em ${saida}`)
}

main().catch((e) => {
  console.error(`erro: ${(e as Error)?.message ?? e}`)
  process.exitCode = 1
})
