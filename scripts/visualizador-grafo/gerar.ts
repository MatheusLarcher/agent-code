/**
 * Gera o visualizador dos grafos de memórias (D32): lê o acervo de teste, junta os
 * vetores (cache do ambiente + o que faltar, calculado aqui), monta os três grafos e
 * escreve uma página que abre por file://, sem servidor e sem CDN.
 *
 * Rodar (da raiz do repositório):
 *   npx esbuild scripts/visualizador-grafo/gerar.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/visualizador-grafo/.tmp-gerar.mjs
 *   node scripts/visualizador-grafo/.tmp-gerar.mjs [--memorias <pasta>] [--vetores <pasta>] [--saida <pasta>] [--hoje AAAA-MM-DD]
 *   (apague o .tmp-gerar.mjs depois)
 *
 * Padrões: %USERPROFILE%\agent-code-ambiente\{memorias, vetores, visualizador}.
 * Nada do acervo é escrito dentro do repositório: só na pasta de saída.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { DEFAULT_EMBEDDING_MODEL, embedText, memoryTime } from '../../src/main/memoryRanker'
import { isPinnedMemory, listMemoryFiles } from '../../src/main/memoryIndex'
import { dataDaMemoria, dataIso, inicioDoDia, nivelDe, temaDe } from './dados'
import { montarGrafo, type MemoriaLida } from './montar'

const AQUI = dirname(fileURLToPath(import.meta.url))

function argumento(nome: string, padrao: string): string {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao
}

const AMBIENTE = join(homedir(), 'agent-code-ambiente')
const PASTA_MEMORIAS = argumento('memorias', join(AMBIENTE, 'memorias'))
const PASTA_VETORES = argumento('vetores', join(AMBIENTE, 'vetores'))
const PASTA_SAIDA = argumento('saida', join(AMBIENTE, 'visualizador'))
const HOJE_ISO = argumento('hoje', new Date().toISOString().slice(0, 10))
const MODELO = DEFAULT_EMBEDDING_MODEL

if (!/^\d{4}-\d{2}-\d{2}$/.test(HOJE_ISO) || !Number.isFinite(Date.parse(`${HOJE_ISO}T12:00:00Z`))) {
  console.error(`--hoje inválido: "${HOJE_ISO}" (use AAAA-MM-DD)`)
  process.exit(2)
}
if (!existsSync(PASTA_MEMORIAS)) {
  console.error(`Pasta de memórias não encontrada: ${PASTA_MEMORIAS}`)
  process.exit(2)
}
const HOJE = Date.parse(`${HOJE_ISO}T12:00:00Z`)

// ---- vetores: mesmo hash e mesmo arquivo de cache do memoryRanker ----
type Cache = Record<string, number[]>
const arquivoCache = join(PASTA_VETORES, `${MODELO.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`)
const arquivoExtra = join(PASTA_SAIDA, 'vetores-extra.json')

function lerCache(arquivo: string): Cache {
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8')) as Cache
  } catch {
    return {}
  }
}

const hashDe = (texto: string): string => createHash('sha256').update(`${MODELO}\n${texto}`).digest('hex')

type Extrator = (t: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>

async function calcularVetores(textos: string[]): Promise<number[][]> {
  const mod = await import('@huggingface/transformers')
  const extrator = await (mod.pipeline as unknown as (task: string, model: string) => Promise<Extrator>)('feature-extraction', MODELO)
  const out: number[][] = []
  for (let i = 0; i < textos.length; i += 16) {
    out.push(...(await extrator(textos.slice(i, i + 16), { pooling: 'mean', normalize: true })).tolist())
  }
  return out
}

async function main(): Promise<void> {
  mkdirSync(PASTA_SAIDA, { recursive: true })
  const arquivos = listMemoryFiles(PASTA_MEMORIAS)
  const principal = lerCache(arquivoCache)
  const extra = lerCache(arquivoExtra)

  const lidas: Array<Omit<MemoriaLida, 'vetor'> & { hash: string; textoVetor: string }> = []
  let semTexto = 0
  for (const f of arquivos) {
    const conteudo = readFileSync(join(PASTA_MEMORIAS, f.relPath), 'utf8')
    if (conteudo.includes('\0')) {
      semTexto++
      continue
    }
    const textoVetor = embedText(f, conteudo)
    const doCabecalho = memoryTime(conteudo)
    const cabecalhoValido = doCabecalho !== null && inicioDoDia(doCabecalho) <= inicioDoDia(HOJE)
    const doTexto = cabecalhoValido ? null : dataDaMemoria(conteudo, HOJE)
    const data = cabecalhoValido ? inicioDoDia(doCabecalho) : doTexto
    lidas.push({
      caminho: f.relPath,
      titulo: f.title,
      gancho: f.hook,
      tema: temaDe(f.folders),
      nivel: nivelDe(data, HOJE),
      data: dataIso(data),
      origemData: cabecalhoValido ? 'cabecalho' : doTexto !== null ? 'texto' : null,
      sempre: isPinnedMemory(conteudo),
      texto: `${f.title} ${f.hook} ${conteudo}`,
      hash: hashDe(textoVetor),
      textoVetor
    })
  }

  const faltando = lidas.filter((m) => !principal[m.hash] && !extra[m.hash])
  if (faltando.length > 0) {
    console.log(`Calculando ${faltando.length} vetores que não estavam no cache…`)
    const novos = await calcularVetores(faltando.map((m) => m.textoVetor))
    faltando.forEach((m, i) => (extra[m.hash] = novos[i]))
    writeFileSync(arquivoExtra, JSON.stringify(extra))
  }

  const memorias: MemoriaLida[] = lidas.map(({ hash, textoVetor: _t, ...m }) => ({ ...m, vetor: principal[hash] ?? extra[hash] }))
  const grafo = montarGrafo(memorias, { hoje: HOJE_ISO, modelo: MODELO })

  writeFileSync(join(PASTA_SAIDA, 'dados.js'), `window.GRAFO = ${JSON.stringify(grafo)};\n`)
  await build({
    entryPoints: [join(AQUI, 'pagina.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: true,
    outfile: join(PASTA_SAIDA, 'app.js'),
    logLevel: 'warning'
  })
  copyFileSync(join(AQUI, 'pagina.css'), join(PASTA_SAIDA, 'estilo.css'))
  copyFileSync(join(AQUI, 'pagina.html'), join(PASTA_SAIDA, 'index.html'))

  const niveis = { fast: 0, curto: 0, medio: 0, longo: 0 }
  const origens = { cabecalho: 0, texto: 0, sem: 0 }
  for (const m of grafo.memorias) {
    niveis[m.nivel]++
    origens[m.origemData ?? 'sem']++
  }
  console.log(
    JSON.stringify(
      {
        memorias: grafo.memorias.length,
        ignoradasBinarias: semTexto,
        vetoresCalculadosAgora: faltando.length,
        temas: grafo.temas.length,
        ligacoesTemas: grafo.ligacoesTemas.length,
        parecida: { ...grafo.parecida, ligacoes: grafo.parecidas.length },
        niveis,
        origemDaData: origens,
        saida: join(PASTA_SAIDA, 'index.html')
      },
      null,
      2
    )
  )
}

main().then(
  () => process.exit(0),
  (erro: unknown) => {
    console.error(erro)
    process.exit(1)
  }
)
