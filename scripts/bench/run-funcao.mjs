// Harness do desafio de FUNÇÃO: manda a spec, escreve o arquivo, roda os testes.
//
// É o benchmark do tamanho certo para um modelo de 7B nesta máquina — resposta de
// ~50 linhas em vez de 4 arquivos. A nota máxima é alcançável, então dá para medir
// de verdade se o treino aproximou o modelo pequeno do grande.
//
// Uso: node scripts/bench/run-funcao.mjs --model <m> [--api openai --host <url>] --rounds 2

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SYSTEM } from './format.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const MODEL = args.model
const API = args.api ?? 'ollama'
const HOST = args.host ?? 'http://127.0.0.1:11434'
const ROUNDS = Number(args.rounds ?? 2)
// Modelo de raciocínio (qwen3.5) manda tudo para `message.thinking` e devolve
// `content` vazio — `--think false` desliga isso no Ollama.
const THINK = args.think === undefined ? undefined : args.think !== 'false'
const ALVO = 'src/shared/reconcile.ts'
const TOTAL = 18

const SPEC = readFileSync(join(REPO, 'docs/bench/SPEC-FUNCAO.md'), 'utf8')
const PEDIDO = `${SPEC}

## Formato da resposta

Um bloco de código só, com o arquivo completo:

\`\`\`ts
// ARQUIVO: ${ALVO}
...
\`\`\`

Nada de texto fora do bloco. Não escreva testes.`

async function perguntar(messages) {
  const t0 = Date.now()
  const openai = API === 'openai'
  const res = await fetch(`${HOST}${openai ? '/v1/chat/completions' : '/api/chat'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      openai
        ? { model: MODEL, messages, stream: true, temperature: 0, max_tokens: 4000, stream_options: { include_usage: true } }
        : { model: MODEL, messages, stream: true, options: { temperature: 0, num_ctx: Number(args.ctx ?? 8192) }, ...(THINK === undefined ? {} : { think: THINK }) }
    )
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)

  let texto = ''
  let tokens = 0
  let buffer = ''
  const dec = new TextDecoder()
  for await (const chunk of res.body) {
    buffer += dec.decode(chunk, { stream: true })
    const linhas = buffer.split('\n')
    buffer = linhas.pop() ?? ''
    for (const linha of linhas) {
      if (!linha.trim()) continue
      const cru = linha.startsWith('data:') ? linha.slice(5).trim() : linha
      if (cru === '[DONE]') continue
      let row
      try {
        row = JSON.parse(cru)
      } catch {
        continue
      }
      const pedaco = row.message?.content ?? row.choices?.[0]?.delta?.content ?? ''
      if (pedaco) {
        texto += pedaco
        process.stdout.write('.')
      }
      if (row.eval_count) tokens = row.eval_count
      if (row.usage?.completion_tokens) tokens = row.usage.completion_tokens
    }
  }
  process.stdout.write('\n')
  return { texto, tokens, segundos: (Date.now() - t0) / 1000 }
}

function extrair(texto) {
  const bloco = texto.match(/```[a-z]*\n([\s\S]*?)```/)
  return (bloco ? bloco[1] : texto).replace(/^\s*\/\/\s*ARQUIVO:.*\n/, '').trim() + '\n'
}

function avaliar() {
  let passou = 0
  let saida = ''
  try {
    execFileSync('npx', ['vitest', 'run', '--config', 'scripts/bench/vitest.funcao.config.mts', '--reporter=json', '--outputFile=.func.json'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: true
    })
  } catch (e) {
    saida = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(-2500)
  }
  try {
    passou = JSON.parse(readFileSync(join(REPO, '.func.json'), 'utf8')).numPassedTests ?? 0
  } catch {
    /* sem relatório = zero */
  }
  let tipos = true
  let tiposOut = ''
  try {
    execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe', shell: true })
  } catch (e) {
    tipos = false
    tiposOut = `${e.stdout ?? ''}`.slice(-1500)
  }
  return { passou, saida, tipos, tiposOut }
}

const historico = []
const messages = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: PEDIDO }
]

const inicio = Date.now()
for (let rodada = 1; rodada <= ROUNDS; rodada++) {
  process.stdout.write(`\n[rodada ${rodada}] ${MODEL}\n`)
  const resposta = await perguntar(messages)
  const destino = join(REPO, ALVO)
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, extrair(resposta.texto), 'utf8')

  const r = avaliar()
  historico.push({ rodada, ...resposta, passou: r.passou, tipos: r.tipos })
  process.stdout.write(
    `  ${resposta.segundos.toFixed(0)}s, ${resposta.tokens} tokens | testes: ${r.passou}/${TOTAL} | typecheck: ${r.tipos ? 'ok' : 'falhou'}\n`
  )
  if (r.passou === TOTAL && r.tipos) break
  if (rodada === ROUNDS) break

  messages.push({ role: 'assistant', content: resposta.texto })
  messages.push({
    role: 'user',
    content: `${[r.tiposOut && `Erros de tipo:\n${r.tiposOut}`, r.saida && `Testes falhando:\n${r.saida}`].filter(Boolean).join('\n\n')}\n\nCorrija e devolva o arquivo inteiro no mesmo formato.`
  })
}

const dir = join(REPO, 'docs/bench/resultados-funcao')
mkdirSync(dir, { recursive: true })
const slug = MODEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
writeFileSync(
  join(dir, `${slug}.json`),
  JSON.stringify({ model: MODEL, total: TOTAL, minutos: +((Date.now() - inicio) / 60000).toFixed(1), rodadas: historico }, null, 2),
  'utf8'
)
writeFileSync(join(dir, `${slug}-reconcile.ts`), readFileSync(join(REPO, ALVO), 'utf8'), 'utf8')

// O arquivo do modelo é escrito DENTRO do repositório de verdade (é onde o vitest
// e o alias `@shared` o encontram), então ele tem que sair no fim. Sem isto o
// `npm run typecheck` do projeto passa a falhar com o código que o modelo gerou —
// e uma medição de um modelo que degenerou deixa o repo quebrado até alguém achar
// o motivo. A cópia permanente já está em `resultados-funcao/`.
rmSync(join(REPO, ALVO), { force: true })
rmSync(join(REPO, '.func.json'), { force: true })
process.stdout.write(`\nmelhor: ${Math.max(...historico.map((h) => h.passou))}/${TOTAL} -> ${dir}\n`)
