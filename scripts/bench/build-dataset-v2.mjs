// Gerador de dataset v2 — treina a MESMA tarefa que o benchmark cobra:
// "aqui está o arquivo atual e um pedido em português; devolva o(s) arquivo(s)
// COMPLETO(s) em bloco `// ARQUIVO: caminho`".
//
// A v1 aprendia com chamadas de ferramenta Edit ("Em X, troquei A por B"), que é
// outro trabalho: lá o arquivo já tinha sido escrito por uma ferramenta, então o
// modelo aprendeu a narrar a edição e a responder curto. Aqui todo exemplo tem
// como resposta o arquivo inteiro, no formato exato do harness.
//
// Fontes, todas do próprio repositório:
//   1. commits reais: mensagem do commit = pedido; arquivo ANTES = contexto;
//      arquivo DEPOIS = resposta. É a tarefa do benchmark, ponto por ponto.
//   2. arquivos atuais com um export removido: pedido sintético "adicione X";
//      resposta = arquivo original completo. Ensina a devolver tudo, não um trecho.
//
// Uso: node scripts/bench/build-dataset-v2.mjs [--max-linhas 160]

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SYSTEM, userMessage, assistantMessage } from './format.mjs'

const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT_DIR = join(REPO, 'docs/bench/dataset')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
/** Teto de linhas do arquivo-resposta. Acima disso o exemplo não cabe no seq_len
 *  que a GPU de 8 GB aguenta, e entra truncado — ensinando a parar no meio. */
const MAX_LINHAS = Number(args['max-linhas'] ?? 160)
/** Teto do arquivo de CONTEXTO. Ele ocupa metade do exemplo: baixar isso é o que
 *  mais aumenta quantos exemplos cabem no `max-len` do treino. */
const MAX_CTX_LINHAS = Number(args['max-ctx'] ?? 200)
/**
 * `single` (padrão): um exemplo por ARQUIVO alterado — mais exemplos, todos
 *   pequenos. Foi o que produziu o melhor LoRA medido (v3, 17/22).
 * `multi`: um exemplo por COMMIT, com todos os arquivos numa resposta só. Ensina
 *   a devolver vários arquivos, mas os exemplos ficam grandes e o filtro de
 *   tamanho do treino derruba a maioria (v4 caiu para 68 exemplos e piorou).
 *   Só vale com `--max-len` alto, o que exige GPU maior que 8 GB.
 */
const MODO = args.modo ?? 'single'

/** Arquivos que revelariam a solução do benchmark não entram (o teste tem que
 *  medir generalização, não memorização). Hoje nada disso existe no repo — a
 *  guarda fica para quando a feature for implementada de verdade. */
const PROIBIDOS = [/src[\\/]shared[\\/]archive\.ts$/i, /archive.*\.test\./i]

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function fileAt(rev, rel) {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch {
    return null
  }
}

const proibido = (rel) => PROIBIDOS.some((re) => re.test(rel))
const linhas = (s) => s.split('\n').length

const exemplos = []

/* ---------- fonte 1: commits (pedido real → arquivo completo depois) ---------- */

const hashes = git(['log', '--format=%H', '--no-merges']).split('\n').filter(Boolean)
let porCommit = 0

for (const hash of hashes) {
  const assunto = git(['log', '-1', '--format=%s', hash]).trim()
  const alterados = git(['show', '--name-only', '--format=', hash])
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !proibido(f))

  // Um exemplo por commit com TODOS os arquivos que couberem: a tarefa do
  // benchmark pede 4 arquivos numa resposta só, e um dataset de um-arquivo-por-vez
  // ensina o modelo a parar no primeiro (foi o teto do 3B: 17/22, sempre só o
  // `archive.ts`).
  const contexto = []
  const resposta = []
  for (const rel of alterados) {
    const depois = fileAt(hash, rel)
    if (!depois || linhas(depois) > MAX_LINHAS) continue
    const antes = fileAt(`${hash}~1`, rel)
    if (antes && linhas(antes) > MAX_CTX_LINHAS) continue
    if (antes) contexto.push([rel, antes])
    resposta.push([rel, depois])
  }
  if (!resposta.length) continue

  // Um exemplo com tudo (multi) ou um exemplo por arquivo (single).
  const grupos =
    MODO === 'multi'
      ? [[contexto, resposta]]
      : resposta.map((par) => [contexto.filter(([rel]) => rel === par[0]), [par]])

  for (const [ctx, resp] of grupos) {
    const novos = resp.length - ctx.length
    exemplos.push({
      fonte: resp.length > 1 ? 'commit-multi' : 'commit',
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: userMessage(
            `${assunto}\n\nAplique essa mudança no projeto agent-code${novos ? ', criando o que faltar' : ''}.${
              MODO === 'multi' ? ' Devolva TODOS os arquivos afetados.' : ''
            }`,
            ctx
          )
        },
        { role: 'assistant', content: assistantMessage(resp) }
      ]
    })
    porCommit++
  }
}

/* ---------- fonte 2: "adicione o que falta" (arquivo do repo sem um export) ---------- */

const RE_EXPORT = /\n(\/\*\*[\s\S]*?\*\/\n)?export (async )?function (\w+)[\s\S]*?\n}\n/g
let porSintetico = 0

for (const rel of git(['ls-files', '*.ts', '*.tsx']).split('\n').filter(Boolean)) {
  if (proibido(rel) || /\.test\.tsx?$/.test(rel)) continue
  const abs = join(REPO, rel)
  if (!existsSync(abs)) continue
  const completo = readFileSync(abs, 'utf8')
  if (linhas(completo) > MAX_LINHAS || linhas(completo) < 25) continue

  const matches = [...completo.matchAll(RE_EXPORT)]
  if (!matches.length) continue
  const alvo = matches[Math.floor(matches.length / 2)]
  const nome = alvo[3]
  const semAlvo = completo.replace(alvo[0], '\n')
  if (semAlvo === completo) continue

  exemplos.push({
    fonte: 'sintetico',
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: userMessage(
          `Falta a função \`${nome}\` neste arquivo. Implemente-a seguindo o estilo do projeto e devolva o arquivo inteiro.`,
          [[rel, semAlvo]]
        )
      },
      { role: 'assistant', content: assistantMessage([[rel, completo]]) }
    ]
  })
  porSintetico++
}

/* ---------- fonte 3: transcripts do agente (pedido SEU → arquivo completo) ---------- */

// Só as chamadas `Write`, que carregam o arquivo inteiro. As `Edit` (trechos)
// ficaram de fora de propósito: foram elas que ensinaram o modelo a responder
// pedaço na primeira tentativa.
// O repositório já mudou de lugar (Documents/GitHub -> C:\GitHub) e o Claude Code
// guarda um diretório por caminho, então os transcripts antigos ficam num slug e os
// novos noutro. Varremos os dois: o slug do caminho atual + o histórico.
const projetos = join(process.env.USERPROFILE ?? '', '.claude/projects')
const TRANSCRIPT_DIRS = [
  join(projetos, REPO.replace(/[^a-zA-Z0-9]/g, '-')),
  join(projetos, 'C--Users-mathe-Documents-GitHub-agent-code')
].filter((d, i, todos) => existsSync(d) && todos.indexOf(d) === i)
let porTranscript = 0

function textoDe(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

const { readdirSync } = await import('node:fs')
for (const dir of TRANSCRIPT_DIRS) {
  for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    let ultimoPedido = null
    for (const linhaTxt of readFileSync(join(dir, arquivo), 'utf8').split('\n')) {
      if (!linhaTxt.trim()) continue
      let row
      try {
        row = JSON.parse(linhaTxt)
      } catch {
        continue
      }
      const msg = row.message
      if (!msg) continue
      if (row.type === 'user' && msg.content) {
        const t = textoDe(msg.content).trim()
        if (t && !t.startsWith('<') && !t.includes('tool_result') && t.length < 1200) ultimoPedido = t
        continue
      }
      if (row.type !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const c of msg.content) {
        if (c?.type !== 'tool_use' || c.name !== 'Write' || !c.input?.content || !ultimoPedido) continue
        const caminho = String(c.input.file_path ?? '').replace(/\\/g, '/')
        const rel = caminho.split('/GitHub/agent-code/')[1]
        if (!rel || !/\.(ts|tsx)$/.test(rel) || proibido(rel)) continue
        const conteudo = c.input.content
        if (linhas(conteudo) > MAX_LINHAS || linhas(conteudo) < 15) continue
        exemplos.push({
          fonte: 'transcript',
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userMessage(ultimoPedido, []) },
            { role: 'assistant', content: assistantMessage([[rel, conteudo]]) }
          ]
        })
        porTranscript++
      }
    }
  }
}

/* ---------- saída ---------- */

mkdirSync(OUT_DIR, { recursive: true })
const embaralhado = exemplos
  .map((e, i) => ({ e, k: (i * 2654435761) % 4294967296 }))
  .sort((a, b) => a.k - b.k)
  .map((x) => x.e)
const corte = Math.max(1, Math.floor(embaralhado.length * 0.05))
const eva = embaralhado.slice(0, corte)
const treino = embaralhado.slice(corte)

const linha = (e) => JSON.stringify({ messages: e.messages })
writeFileSync(join(OUT_DIR, 'train.jsonl'), treino.map(linha).join('\n'), 'utf8')
writeFileSync(join(OUT_DIR, 'eval.jsonl'), eva.map(linha).join('\n'), 'utf8')

const chars = exemplos.map((e) => e.messages[2].content.length).sort((a, b) => a - b)
process.stdout.write(
  `exemplos: ${exemplos.length} (commits: ${porCommit}, sintéticos: ${porSintetico})\n` +
    `treino: ${treino.length} | eval: ${eva.length}\n` +
    `resposta em chars — mín ${chars[0]}, mediana ${chars[Math.floor(chars.length / 2)]}, máx ${chars[chars.length - 1]}\n`
)
