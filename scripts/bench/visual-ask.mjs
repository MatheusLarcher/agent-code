// Manda a SPEC-VISUAL para um modelo e salva o ArchivedCard.tsx que ele devolver.
// Mesmo texto para todos — a única diferença entre as rodadas é o modelo.
//
// Uso: node scripts/bench/visual-ask.mjs --model <m> [--api openai|ollama|completion]
//        [--host http://127.0.0.1:11434] --out docs/bench/visual/<nome>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SYSTEM } from './format.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const MODEL = args.model
const API = args.api ?? 'ollama'
const HOST = args.host ?? 'http://127.0.0.1:11434'
const OUT = resolve(args.out)

const SPEC = readFileSync(join(REPO, 'docs/bench/SPEC-VISUAL.md'), 'utf8')
const PEDIDO = `${SPEC}

## Formato da resposta

Responda com UM bloco de código, e a primeira linha do bloco é o caminho:

\`\`\`tsx
// ARQUIVO: src/renderer/src/components/ArchivedCard.tsx
...arquivo completo...
\`\`\`

Nada de texto fora do bloco.`

async function pedir() {
  const t0 = Date.now()
  const body =
    API === 'openai'
      ? { model: MODEL, messages: msgs(), stream: true, temperature: 0, max_tokens: 6000, stream_options: { include_usage: true } }
      : API === 'completion'
        ? { prompt: `${SYSTEM}\n\n${PEDIDO}\n\n\`\`\`tsx\n// ARQUIVO: src/renderer/src/components/ArchivedCard.tsx\n`, stream: true, temperature: 0, n_predict: 6000 }
        : { model: MODEL, messages: msgs(), stream: true, options: { temperature: 0, num_ctx: 16384 } }

  const url = API === 'openai' ? `${HOST}/v1/chat/completions` : API === 'completion' ? `${HOST}/completion` : `${HOST}/api/chat`
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
      const pedaco = row.message?.content ?? row.choices?.[0]?.delta?.content ?? row.content ?? ''
      if (pedaco) {
        texto += pedaco
        process.stdout.write('.')
      }
      if (row.eval_count) tokens = row.eval_count
      if (row.usage?.completion_tokens) tokens = row.usage.completion_tokens
      if (row.tokens_predicted) tokens = row.tokens_predicted
    }
  }
  process.stdout.write('\n')
  return { texto, tokens, segundos: (Date.now() - t0) / 1000 }
}

function msgs() {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: PEDIDO }
  ]
}

/** Tira o componente da resposta: bloco marcado, ou o texto cru quando o modelo é
 *  base (sem instrução) e simplesmente continua o código a partir do cabeçalho. */
function extrair(texto) {
  const bloco = texto.match(/```[a-z]*\n([\s\S]*?)```/)
  let codigo = bloco ? bloco[1] : texto
  codigo = codigo.replace(/^\s*\/\/\s*ARQUIVO:.*\n/, '')
  return codigo.trim() + '\n'
}

const r = await pedir()
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'ArchivedCard.tsx'), extrair(r.texto), 'utf8')
writeFileSync(join(OUT, 'resposta-crua.txt'), r.texto, 'utf8')
writeFileSync(
  join(OUT, 'geracao.json'),
  JSON.stringify({ model: MODEL, api: API, tokens: r.tokens, segundos: Math.round(r.segundos) }, null, 2),
  'utf8'
)
process.stdout.write(`${MODEL}: ${r.tokens} tokens em ${Math.round(r.segundos)}s -> ${OUT}\n`)
