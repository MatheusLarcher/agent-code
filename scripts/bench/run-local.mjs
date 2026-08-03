// Harness do benchmark: dá a SPEC a um modelo local (Ollama), aplica o que ele
// devolve no worktree indicado, roda typecheck + testes de aceitação e realimenta
// os erros por até N rodadas. Mede tempo e tokens de cada rodada.
//
// Uso:
//   node scripts/bench/run-local.mjs --model qwen3.6:35b-a3b-q4_K_M --worktree ../bench-local --rounds 3
//
// Saída: um JSON em docs/bench/resultados/<slug>.json com o histórico completo.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
const MODEL = args.model ?? 'qwen3.6:35b-a3b-q4_K_M'
const WORKTREE = resolve(args.worktree ?? '../bench-local')
const ROUNDS = Number(args.rounds ?? 3)
const NUM_CTX = Number(args.ctx ?? 16384)
const HOST = args.host ?? 'http://127.0.0.1:11434'
const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** Arquivos que o modelo enxerga. `caminho#inicio-fim` recorta o trecho (o App.tsx
 *  inteiro não caberia). Sem `Sidebar.test.tsx` e sem o ponto de uso no `App.tsx`,
 *  NENHUM modelo tinha como saber que precisa passar a prop nova nesses dois
 *  lugares — e o typecheck cobrava exatamente isso, enquanto o Opus, agindo como
 *  agente, lia o repositório inteiro. */
const CONTEXT_FILES = [
  'src/renderer/src/types.ts',
  'src/renderer/src/components/Sidebar.tsx',
  'src/renderer/src/components/Sidebar.test.tsx#22-50',
  'src/renderer/src/App.tsx#1985-2000'
]

const SPEC = readFileSync(join(REPO, 'docs/bench/SPEC.md'), 'utf8')

const PROTOCOL = `
## Formato da resposta

Um bloco de código por arquivo, e a PRIMEIRA linha de cada bloco é o caminho:

\`\`\`ts
// ARQUIVO: src/shared/archive.ts
...conteúdo COMPLETO do arquivo...
\`\`\`

Para um arquivo que já existe, reescreva-o inteiro, já com as mudanças (não use
"...resto igual", não corte nada). Nada de texto fora dos blocos. Não escreva testes.
TypeScript estrito, sem dependência nova.`

function fileBlock(spec) {
  const [rel, faixa] = spec.split('#')
  const conteudo = readFileSync(join(WORKTREE, rel), 'utf8')
  if (!faixa) return `--- ${rel} ---\n${conteudo}`
  const [ini, fim] = faixa.split('-').map(Number)
  const linhas = conteudo.split('\n').slice(ini - 1, fim).join('\n')
  return `--- ${rel} (linhas ${ini}-${fim}) ---\n${linhas}`
}

/** `ollama` (padrão) ou `openai` — este último atende llama-server, vLLM e afins,
 *  para rodar um modelo sem passar pelo Ollama. */
const API = args.api ?? 'ollama'

/** Streaming de propósito: uma geração longa sem stream estoura o headers-timeout
 *  do fetch do Node muito antes do modelo terminar de escrever. */
async function ask(messages) {
  const t0 = Date.now()
  const openai = API === 'openai'
  const res = await fetch(`${HOST}${openai ? '/v1/chat/completions' : '/api/chat'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      openai
        ? {
            model: MODEL,
            messages,
            stream: true,
            temperature: 0,
            max_tokens: 24000,
            // Sem isto o llama-server não manda `usage` no stream e a contagem de
            // tokens/velocidade sai zerada.
            stream_options: { include_usage: true }
          }
        : { model: MODEL, messages, stream: true, options: { temperature: 0, num_ctx: NUM_CTX } }
    )
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)

  let text = ''
  let final = {}
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      if (openai) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        const row = JSON.parse(payload)
        const piece = row.choices?.[0]?.delta?.content
        if (piece) {
          text += piece
          process.stdout.write('.')
        }
        if (row.usage) final = { eval_count: row.usage.completion_tokens, prompt_eval_count: row.usage.prompt_tokens }
        continue
      }
      const row = JSON.parse(line)
      if (row.message?.content) {
        text += row.message.content
        process.stdout.write('.')
      }
      if (row.done) final = row
    }
  }
  process.stdout.write('\n')
  const seconds = (Date.now() - t0) / 1000
  return {
    text,
    seconds,
    promptTokens: final.prompt_eval_count ?? 0,
    outputTokens: final.eval_count ?? 0,
    // O llama-server não manda `eval_duration`; nesse caso o tempo de parede da
    // geração é a melhor medida disponível.
    tokensPerSecond: final.eval_duration
      ? final.eval_count / (final.eval_duration / 1e9)
      : (final.eval_count ?? 0) / Math.max(seconds, 0.001)
  }
}

const PATH_RE = /(src\/[\w./-]+\.(?:ts|tsx))/

/** Caminho declarado na 1ª linha do bloco (`// ARQUIVO: x`, `// x`) ou, na falta
 *  dele, na linha de texto imediatamente antes do bloco. */
function pathOf(firstLine, preceding) {
  const inside = firstLine.match(/^\s*(?:\/\/|\/\*|#)\s*(?:ARQUIVO:|FILE:|arquivo:)?\s*(\S+\.(?:ts|tsx))/)
  if (inside) return { rel: inside[1].replace(/^\.\//, ''), consumeFirstLine: true }
  const before = preceding?.match(PATH_RE)
  return before ? { rel: before[1], consumeFirstLine: false } : null
}

/** Aplica os blocos da resposta. Devolve o que aplicou e o que falhou (vira feedback). */
function applyBlocks(text) {
  const applied = []
  const failures = []

  for (const m of text.matchAll(/(^|\n)([^\n]*)\n?```[a-z]*\n([\s\S]*?)```/g)) {
    const preceding = m[2]
    const body = m[3]
    const lines = body.split('\n')
    const found = pathOf(lines[0] ?? '', preceding)
    if (!found) {
      failures.push(`bloco de código sem caminho de arquivo (comece com "// ARQUIVO: src/..."):\n${body.slice(0, 200)}`)
      continue
    }
    const content = (found.consumeFirstLine ? lines.slice(1).join('\n') : body).replace(/\s*$/, '\n')
    // `.ts` onde o arquivo real é `.tsx` é escorregão de extensão, não outro
    // arquivo — senão o modelo cria um módulo órfão e o typecheck acusa outra coisa.
    let rel = found.rel
    if (!existsSync(join(WORKTREE, rel)) && existsSync(join(WORKTREE, `${rel}x`))) rel = `${rel}x`
    const dest = join(WORKTREE, rel)
    try {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, content, 'utf8')
      applied.push(`escreveu ${rel} (${content.split('\n').length} linhas)`)
    } catch (e) {
      failures.push(`falhou ao escrever ${found.rel}: ${e.message}`)
    }
  }

  if (!applied.length && !failures.length) failures.push('nenhum bloco de código foi encontrado na resposta')
  return { applied, failures }
}

function run(cmd, cmdArgs) {
  try {
    const out = execFileSync(cmd, cmdArgs, { cwd: WORKTREE, encoding: 'utf8', stdio: 'pipe', shell: true })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() }
  }
}

/** Nota objetiva: typecheck + suíte existente + testes de aceitação. */
function evaluate() {
  const typecheck = run('npm', ['run', 'typecheck'])
  const acceptance = run('npx', [
    'vitest',
    'run',
    '--config',
    'scripts/bench/vitest.bench.config.mts',
    '--reporter=json',
    '--outputFile=.bench-accept.json'
  ])
  const suite = run('npx', ['vitest', 'run', 'src'])
  // Total FIXO: quando o módulo não existe, o arquivo de teste nem coleta e o
  // "numTotalTests" do relatório encolhe — a nota tem que ser contra o alvo real.
  const total = 22
  let passed = 0
  try {
    const report = JSON.parse(readFileSync(join(WORKTREE, '.bench-accept.json'), 'utf8'))
    passed = report.numPassedTests ?? 0
  } catch {
    /* sem relatório = nada passou */
  }
  return {
    typecheck: typecheck.ok,
    typecheckOut: typecheck.ok ? '' : typecheck.out.slice(-3000),
    acceptancePassed: passed,
    acceptanceTotal: total,
    acceptanceOut: acceptance.ok ? '' : acceptance.out.slice(-3000),
    suiteGreen: suite.ok,
    suiteOut: suite.ok ? '' : suite.out.slice(-2000)
  }
}

const history = []
const messages = [
  {
    role: 'system',
    content:
      'Você é um engenheiro sênior de TypeScript trabalhando num app Electron + React. Siga a especificação à risca e responda somente no formato pedido.'
  },
  {
    role: 'user',
    content: `${SPEC}\n\n## Arquivos atuais do projeto\n\n${CONTEXT_FILES.map(fileBlock).join('\n\n')}\n${PROTOCOL}`
  }
]

const startedAt = Date.now()
for (let round = 1; round <= ROUNDS; round++) {
  process.stdout.write(`\n[rodada ${round}] perguntando ao ${MODEL}...\n`)
  const answer = await ask(messages)
  const { applied, failures } = applyBlocks(answer.text)
  process.stdout.write(`  ${answer.seconds.toFixed(0)}s, ${answer.outputTokens} tokens (${answer.tokensPerSecond.toFixed(1)} tok/s)\n`)
  process.stdout.write(`  aplicado: ${applied.join(', ') || 'nada'}\n`)

  const result = applied.length ? evaluate() : { typecheck: false, acceptancePassed: 0, acceptanceTotal: 0, suiteGreen: false }
  history.push({ round, ...answer, applied, failures, ...result, text: answer.text })
  process.stdout.write(
    `  typecheck: ${result.typecheck ? 'ok' : 'falhou'} | aceitação: ${result.acceptancePassed}/${result.acceptanceTotal} | suíte: ${result.suiteGreen ? 'verde' : 'vermelha'}\n`
  )

  if (result.typecheck && result.suiteGreen && result.acceptanceTotal && result.acceptancePassed === result.acceptanceTotal) break
  if (round === ROUNDS) break

  const feedback = [
    failures.length ? `Blocos que não aplicaram:\n${failures.join('\n')}` : '',
    result.typecheck === false && result.typecheckOut ? `Erros de typecheck:\n${result.typecheckOut}` : '',
    result.acceptanceOut ? `Testes de aceitação falhando:\n${result.acceptanceOut}` : '',
    result.suiteOut ? `Suíte existente quebrou:\n${result.suiteOut}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  messages.push({ role: 'assistant', content: answer.text })
  messages.push({ role: 'user', content: `${feedback}\n\nCorrija. Mesmo formato de blocos.` })
}

const out = {
  model: MODEL,
  worktree: WORKTREE,
  totalSeconds: (Date.now() - startedAt) / 1000,
  rounds: history
}
const dir = join(REPO, 'docs/bench/resultados')
mkdirSync(dir, { recursive: true })
const slug = MODEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
writeFileSync(join(dir, `${slug}.json`), JSON.stringify(out, null, 2), 'utf8')
process.stdout.write(`\ntotal: ${(out.totalSeconds / 60).toFixed(1)} min → docs/bench/resultados/${slug}.json\n`)
