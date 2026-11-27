// Consolidador de memórias (teste do memorista, decisão D23): lê uma pasta de
// memórias SEM alterá-la e grava uma cópia consolidada em outra pasta, com as
// repetidas fundidas e as contradições resolvidas (vale a mais nova ou a
// correção), mais o mapa caminho-antigo → caminho-novo para traduzir o gabarito.
//
// Candidatas: vizinhas por sentido (embeddings locais, sem chave), agrupadas;
// cada grupo vai UMA vez ao Sonnet, que decide fundir / manter / contradição.
//
// Uso (da raiz do repo):
//   npx esbuild scripts/medicoes/consolidar-memorias.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/.consolidar.tmp.mjs
//   node scripts/medicoes/.consolidar.tmp.mjs --pasta <memorias> --saida <pasta-nova-fora-de-repo>
// (ou, sem gerar o pacote: npx jiti scripts/medicoes/consolidar-memorias.ts --pasta ... --saida ...)
// Opções: --limiar 0.75  --limiar-pasta 0.65  --vizinhos 5  --max-grupo 10  --paralelo 3
//         --so-grupos (só mostra os grupos, sem chamar o modelo)
// Saída: <saida>/memorias/ (a cópia), mapa.json, relatorio.md, decisoes.json, cache-grupos.json.
// Depois: traduzir-casos.ts --casos <casos.json> --mapa <saida>/mapa.json

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  SYSTEM_PROMPT,
  VERSAO_PROMPT,
  aplicarDecisoes,
  arestasCandidatas,
  dataDoFrontmatter,
  formarGrupos,
  lerDecisao,
  pastaDe,
  promptDoGrupo,
  renderRelatorio,
  textoParaSemelhanca,
  type Acao,
  type GrupoDecidido,
  type Memoria,
  type OpcoesGrupos
} from './consolidar-memorias-nucleo'

const MODELO = 'claude-sonnet-5-5'
const MODELO_EMBEDDING = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const TIMEOUT_MS = 180_000
const MARCADOR = '.consolidado'

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function numero(nome: string, padrao: number, min: number, max: number): number {
  const bruto = arg(nome)
  if (bruto === undefined) return padrao
  const v = Number(bruto)
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`--${nome} precisa ser um número entre ${min} e ${max}`)
  return v
}

const dentro = (pai: string, filho: string): boolean => {
  const r = relative(pai, filho)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Repositório git que contém `p` (sobe as pastas procurando `.git`), ou null. */
function repoDe(p: string): string | null {
  let d = resolve(p)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const pai = dirname(d)
    if (pai === d) return null
    d = pai
  }
}

/** A saída não pode ficar num repositório git (nada de dado real no repo) nem se misturar com a origem. */
function conferirSaida(origem: string, saida: string): void {
  if (dentro(origem, saida) || dentro(saida, origem)) throw new Error('--saida não pode ser a pasta de origem, ficar dentro dela nem contê-la')
  const repos = [dirname(fileURLToPath(import.meta.url)), process.cwd(), saida].map(repoDe).filter((r): r is string => r !== null)
  for (const r of repos) if (dentro(r, saida)) throw new Error(`--saida fica dentro do repositório git ${r}; use uma pasta fora (ex.: %TEMP%)`)
}

/** Prepara <saida>/memorias vazia. Só apaga uma pasta que este script criou (tem o marcador). */
function prepararSaida(saida: string): string {
  const pasta = join(saida, 'memorias')
  if (existsSync(saida) && readdirSync(saida).length > 0 && !existsSync(join(saida, MARCADOR))) {
    throw new Error(`--saida ${saida} já existe e não é de uma rodada anterior deste script; escolha uma pasta vazia`)
  }
  mkdirSync(saida, { recursive: true })
  writeFileSync(join(saida, MARCADOR), 'pasta gerada por consolidar-memorias.ts\n')
  rmSync(pasta, { recursive: true, force: true })
  mkdirSync(pasta, { recursive: true })
  return pasta
}

const dia = (d: Date): string => d.toISOString().slice(0, 10)

/** Todas as memórias `.md` da pasta (recursivo), menos o índice MEMORY.md da raiz. */
function lerMemorias(raiz: string): Memoria[] {
  const out: Memoria[] = []
  const andar = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) andar(abs)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const caminho = relative(raiz, abs).split(sep).join('/')
        if (caminho.toLowerCase() === 'memory.md') continue
        const conteudo = readFileSync(abs, 'utf8')
        const st = statSync(abs)
        const nasc = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs
        const criada = dataDoFrontmatter(conteudo, ['created', 'date']) ?? dia(new Date(nasc))
        const atualizada = dataDoFrontmatter(conteudo, ['updated']) ?? dia(st.mtime)
        out.push({ caminho, conteudo, criada, atualizada: atualizada < criada ? criada : atualizada })
      }
    }
  }
  andar(raiz)
  return out
}

async function vetoresDe(textos: string[]): Promise<Float32Array[]> {
  const { pipeline } = await import('@huggingface/transformers')
  const emb = await pipeline('feature-extraction', MODELO_EMBEDDING)
  const out: Float32Array[] = []
  for (const [k, t] of textos.entries()) {
    const r = await emb(t, { pooling: 'mean', normalize: true })
    out.push(Float32Array.from(r.data as ArrayLike<number>))
    if ((k + 1) % 100 === 0) console.log(`  embeddings ${k + 1}/${textos.length}`)
  }
  return out
}

async function* mensagem(texto: string): AsyncGenerator<unknown> {
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: texto }] }, parent_tool_use_id: null }
}

/** Uma chamada ao Sonnet, sem ferramentas, sem configurações do usuário. */
async function perguntar(prompt: string): Promise<{ texto: string; custo: number }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  let texto = ''
  let custo = 0
  try {
    for await (const msg of query({
      prompt: mensagem(prompt) as never,
      options: {
        model: MODELO,
        systemPrompt: SYSTEM_PROMPT,
        thinking: { type: 'disabled' },
        executable: 'node',
        tools: [],
        maxTurns: 1,
        includePartialMessages: false,
        permissionMode: 'bypassPermissions',
        persistSession: false,
        settings: { autoMemoryEnabled: false },
        settingSources: [],
        abortController: abort
      } as never
    }) as AsyncIterable<Record<string, unknown>>) {
      if (msg.type === 'assistant') {
        const m = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined
        if (msg.error) throw new Error(`erro do modelo: ${String(msg.error)}`)
        for (const c of m?.content ?? []) if (c.type === 'text' && c.text) texto += c.text
      } else if (msg.type === 'result') {
        custo = Number(msg.total_cost_usd ?? 0) || 0
        if (msg.is_error) throw new Error(`resultado com erro: ${String(msg.subtype ?? '')}`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { texto, custo }
}

interface Registro {
  texto: string
  custo: number
}

function main(): Promise<void> {
  return executar().catch((e: unknown) => {
    console.error(`ERRO: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
}

async function executar(): Promise<void> {
  const inicio = Date.now()
  const pastaArg = arg('pasta')
  const saidaArg = arg('saida')
  if (!pastaArg || !saidaArg) throw new Error('uso: --pasta <memorias> --saida <pasta-nova-fora-de-repo>')
  const origem = resolve(pastaArg)
  const saida = resolve(saidaArg)
  if (!existsSync(origem) || !statSync(origem).isDirectory()) throw new Error(`--pasta ${origem} não é uma pasta`)
  conferirSaida(origem, saida)
  const opcoes: OpcoesGrupos = {
    vizinhos: numero('vizinhos', 5, 1, 50),
    limiar: numero('limiar', 0.75, 0, 1),
    limiarPasta: numero('limiar-pasta', 0.65, 0, 1),
    maxGrupo: numero('max-grupo', 10, 2, 30)
  }
  const paralelo = numero('paralelo', 3, 1, 8)

  const todas = lerMemorias(origem)
  if (todas.length === 0) throw new Error(`nenhuma memória .md em ${origem}`)
  console.log(`${todas.length} memórias em ${origem}`)
  const vetores = await vetoresDe(todas.map(textoParaSemelhanca))
  const arestas = arestasCandidatas(vetores, todas.map((m) => pastaDe(m.caminho)), opcoes)
  const grupos = formarGrupos(todas.length, arestas, opcoes.maxGrupo).map((g) => g.map((i) => todas[i]))
  const emGrupos = grupos.reduce((s, g) => s + g.length, 0)
  console.log(`${grupos.length} grupos de candidatas (${emGrupos} memórias)`)
  if (process.argv.includes('--so-grupos')) {
    for (const g of grupos) console.log(`- ${g.map((m) => m.caminho).join(' | ')}`)
    return
  }

  const pastaMemorias = prepararSaida(saida)
  const arqCache = join(saida, 'cache-grupos.json')
  const cache: Record<string, Registro> = existsSync(arqCache) ? (JSON.parse(readFileSync(arqCache, 'utf8')) as Record<string, Registro>) : {}
  const gravarCache = (): void => {
    writeFileSync(`${arqCache}.tmp`, JSON.stringify(cache))
    renameSync(`${arqCache}.tmp`, arqCache)
  }

  let custo = 0
  let chamadas = 0
  let doCache = 0
  let custoCache = 0
  const decididos: GrupoDecidido[] = []
  const falhas: Array<{ grupo: string[]; erro: string }> = []
  const avisosModelo: string[] = []
  const decisoesBrutas: Array<{ grupo: string[]; acoes: Acao[] }> = []

  let proximo = 0
  const trabalhar = async (): Promise<void> => {
    while (proximo < grupos.length) {
      const k = proximo++
      const g = grupos[k]
      const prompt = promptDoGrupo(g)
      const chave = createHash('sha256').update(`${MODELO}\n${VERSAO_PROMPT}\n${SYSTEM_PROMPT}\n${prompt}`).digest('hex')
      let erro = ''
      let decisao: ReturnType<typeof lerDecisao> = null
      for (let tentativa = 1; tentativa <= 2 && !decisao; tentativa++) {
        try {
          let reg = tentativa === 1 ? cache[chave] : undefined
          if (reg) doCache++
          else {
            reg = await perguntar(prompt)
            chamadas++
            custo += reg.custo
          }
          decisao = lerDecisao(reg.texto, g.length)
          if (decisao) {
            custoCache += reg.custo
            cache[chave] = reg
            gravarCache()
          } else erro = 'resposta sem JSON de ações'
        } catch (e) {
          erro = e instanceof Error ? e.message : String(e)
        }
      }
      const nomes = g.map((m) => m.caminho)
      if (!decisao) {
        falhas.push({ grupo: nomes, erro })
        console.log(`  grupo ${k + 1}/${grupos.length}: FALHOU (${erro})`)
        continue
      }
      for (const a of decisao.avisos) avisosModelo.push(`grupo ${nomes.join(', ')}: ${a}`)
      decididos.push({ membros: g, acoes: decisao.acoes })
      decisoesBrutas.push({ grupo: nomes, acoes: decisao.acoes })
      console.log(`  grupo ${k + 1}/${grupos.length}: ${decisao.acoes.map((a) => a.tipo).join(', ') || 'manter separadas'}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(paralelo, grupos.length) }, trabalhar))

  // Ordem estável (a do grupo na lista), independente de qual chamada terminou antes.
  const ordem = new Map(grupos.map((g, k) => [g[0].caminho, k]))
  decididos.sort((x, y) => (ordem.get(x.membros[0].caminho) ?? 0) - (ordem.get(y.membros[0].caminho) ?? 0))
  const resultado = aplicarDecisoes(todas, decididos)
  resultado.avisos.unshift(...avisosModelo)

  for (const [caminho, conteudo] of resultado.arquivos) {
    const abs = join(pastaMemorias, ...caminho.split('/'))
    if (!dentro(pastaMemorias, abs)) throw new Error(`caminho fora da cópia: ${caminho}`)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, conteudo)
  }
  const faltando = todas.filter((m) => !(m.caminho in resultado.mapa))
  if (faltando.length) throw new Error(`mapa não cobre: ${faltando.map((m) => m.caminho).join(', ')}`)
  writeFileSync(join(saida, 'mapa.json'), `${JSON.stringify(resultado.mapa, null, 2)}\n`)
  writeFileSync(join(saida, 'decisoes.json'), `${JSON.stringify(decisoesBrutas, null, 2)}\n`)
  const relatorio = renderRelatorio({
    origem,
    saida: pastaMemorias,
    modelo: MODELO,
    opcoes,
    total: todas.length,
    grupos: grupos.length,
    memoriasEmGrupos: emGrupos,
    falhas,
    custoUsd: custo,
    chamadas,
    doCache,
    custoCache,
    segundos: (Date.now() - inicio) / 1000,
    resultado
  })
  writeFileSync(join(saida, 'relatorio.md'), relatorio)
  console.log(`\n${todas.length} → ${resultado.arquivos.size} memórias · ${resultado.fusoes.length} fusões · ${resultado.contradicoes.length} contradições · US$ ${custo.toFixed(4)}`)
  console.log(`Relatório: ${join(saida, 'relatorio.md')}`)
}

void main()
