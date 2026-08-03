// Dataset de FUNÇÕES — o formato que cabe no 7B nesta GPU (512 tokens).
//
// O gerador de arquivo completo (build-dataset-v2) produz exemplos de 2.500+
// caracteres: só 6 deles cabem em 512 tokens, o teto do 7B aqui. Uma função
// isolada com seu comentário cabe folgado, e é justamente onde o LoRA já mostrou
// ganho real (o `nextActiveAfterArchive`, que o modelo base errava em 3 casos).
//
// Cada exemplo: assinatura + comentário do projeto (o "pedido") → corpo completo
// da função (a resposta), no mesmo formato de bloco que o harness cobra.
//
// Uso: node scripts/bench/build-dataset-funcoes.mjs [--max-chars 1400]

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SYSTEM } from './format.mjs'

const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT_DIR = join(REPO, 'docs/bench/dataset')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
/** Teto por exemplo. 1400 chars ≈ 440 tokens: cabe em 512 com folga para o template. */
const MAX_CHARS = Number(args['max-chars'] ?? 1400)
const PROIBIDOS = [/src[\\/]shared[\\/]archive\.ts$/i]

/** Função (exportada ou não) e arrow function nomeada, com o comentário de bloco
 *  logo acima quando existir. Pegar as duas formas e as não-exportadas é o que
 *  tira o dataset de algumas dezenas para algumas centenas de exemplos. */
const RE_FUNCAO = /(\/\*\*[\s\S]*?\*\/\n)?(export )?(?:async )?function (\w+)([\s\S]*?)\n\}\n/g
const RE_ARROW = /(\/\*\*[\s\S]*?\*\/\n)?(export )?const (\w+) = (?:async )?\(([\s\S]*?)\n\}\n/g

function git(cmdArgs) {
  return execFileSync('git', cmdArgs, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const exemplos = []
const vistos = new Set()

function coletar(rel, conteudo) {
  const achados = []
  for (const m of conteudo.matchAll(RE_FUNCAO)) {
    const [inteiro, doc, exp, nome, resto] = m
    achados.push({ inteiro, doc, corpo: `${exp ?? ''}function ${nome}${resto}\n}`, nome })
  }
  for (const m of conteudo.matchAll(RE_ARROW)) {
    const [inteiro, doc, exp, nome, resto] = m
    achados.push({ inteiro, doc, corpo: `${exp ?? ''}const ${nome} = (${resto}\n}`, nome })
  }
  return achados.map((a) => ({ ...a, rel }))
}

const fontes = []
for (const rel of git(['ls-files', '*.ts', '*.tsx']).split('\n').filter(Boolean)) {
  if (PROIBIDOS.some((re) => re.test(rel)) || /\.test\.tsx?$/.test(rel)) continue
  try {
    fontes.push(...coletar(rel, readFileSync(join(REPO, rel), 'utf8')))
  } catch {
    /* arquivo sumiu entre o ls-files e a leitura */
  }
}

// Versões antigas das mesmas funções, vindas do histórico: são variações reais
// escritas pelo próprio projeto, e multiplicam o dataset sem inventar nada.
const commits = git(['log', '--format=%H', '--no-merges']).split('\n').filter(Boolean).slice(0, 60)
for (const hash of commits) {
  const alterados = git(['show', '--name-only', '--format=', hash])
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !PROIBIDOS.some((re) => re.test(f)))
  for (const rel of alterados) {
    try {
      fontes.push(...coletar(rel, execFileSync('git', ['show', `${hash}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })))
    } catch {
      /* arquivo não existia nesse commit */
    }
  }
}

for (const { inteiro, doc, corpo, nome, rel } of fontes) {
  {
    const chave = `${nome}:${corpo.length}`
    if (vistos.has(chave)) continue
    if (inteiro.length > MAX_CHARS || corpo.length < 90) continue
    vistos.add(chave)

    // A assinatura sozinha + o comentário do projeto formam o pedido: é o que um
    // desenvolvedor daria a outro, e é o que o modelo precisa aprender a completar.
    const assinatura = corpo.slice(0, corpo.indexOf('{') + 1)
    const comentario = (doc ?? '').trim()
    const pedido = [
      `No projeto agent-code, implemente esta função no arquivo \`${rel}\`.`,
      comentario ? `\nO que ela faz:\n${comentario}` : '',
      `\nAssinatura:\n\`\`\`ts\n${assinatura}\n\`\`\``,
      '\nResponda só com a função completa, num bloco ```ts. Siga o estilo do projeto.'
    ].join('')

    exemplos.push({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: pedido },
        { role: 'assistant', content: `\`\`\`ts\n${comentario ? comentario + '\n' : ''}${corpo}\n\`\`\`` }
      ]
    })
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const embaralhado = exemplos
  .map((e, i) => ({ e, k: (i * 2654435761) % 4294967296 }))
  .sort((a, b) => a.k - b.k)
  .map((x) => x.e)
const corte = Math.max(1, Math.floor(embaralhado.length * 0.05))
const linha = (e) => JSON.stringify({ messages: e.messages })
writeFileSync(join(OUT_DIR, 'funcoes-train.jsonl'), embaralhado.slice(corte).map(linha).join('\n'), 'utf8')
writeFileSync(join(OUT_DIR, 'funcoes-eval.jsonl'), embaralhado.slice(0, corte).map(linha).join('\n'), 'utf8')

const tamanhos = exemplos.map((e) => e.messages.reduce((n, m) => n + m.content.length, 0)).sort((a, b) => a - b)
process.stdout.write(
  `funções: ${exemplos.length} (treino ${embaralhado.length - corte} | eval ${corte})\n` +
    `chars por exemplo — mín ${tamanhos[0]}, mediana ${tamanhos[Math.floor(tamanhos.length / 2)]}, máx ${tamanhos[tamanhos.length - 1]}\n` +
    `cabem em 512 tokens (<1638 chars): ${tamanhos.filter((t) => t < 1638).length}\n`
)
