// Revisão às cegas (avaliador "modelo" do eval-harness do ECC): para cada par
// (rodada i de hoje × rodada i de novo), uma pasta FORA do repositório com o pedido
// original, o diff de referência, as regras do projeto, os dois diffs rotulados A/B em
// ordem sorteada e as falhas dos testes de referência com chaves curtas (f1..fN).
// O mapa A/B e as saídas das rodadas ficam em pastas que o revisor não recebe.
// Uso:
//   node scripts/replay/review.mjs prepare <t> <n>      monta a pasta e imprime o prompt do revisor
//   node scripts/replay/review.mjs ingest <t> <n> <json> grava a nota do revisor já com os lados
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { OUT, REPO, TASKS, paths } from './config.mjs'
import { git } from './worktree.mjs'

export const CRITERIA = ['atende', 'bugs', 'bordas', 'regras']

/** Rótulos sorteados: { A: 'hoje'|'novo', B: o outro }. */
export function drawLabels(rand = () => randomInt(2)) {
  return rand() === 0 ? { A: 'hoje', B: 'novo' } : { A: 'novo', B: 'hoje' }
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

export function prepare(t, n) {
  const dir = paths.review(t, n)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  mkdirSync(path.dirname(paths.map(t, n)), { recursive: true })
  const labels = existsSync(paths.map(t, n)) ? readJson(paths.map(t, n)).labels : drawLabels()
  const ref = TASKS[t].reference
  writeFileSync(path.join(dir, 'pedido.md'), readFileSync(path.join(OUT, 'pedidos', `${t}.md`), 'utf8'))
  writeFileSync(path.join(dir, 'referencia.patch'), git(REPO, ['show', '--format=%B', '--stat', '-p', ref]))
  writeFileSync(path.join(dir, 'regras-AGENTS.md'), git(REPO, ['show', `${ref}^:AGENTS.md`]))
  // Chaves curtas: o revisor não precisa copiar ids longos (aspas, travessões) sem errar.
  const keys = {}
  const fails = {}
  let k = 0
  for (const label of ['A', 'B']) {
    const out = paths.out(t, labels[label], n)
    writeFileSync(path.join(dir, `${label}.patch`), readFileSync(path.join(out, 'diff.patch')))
    const ev = readJson(path.join(out, 'eval.json'))
    fails[label] = {
      total: ev.reference.total,
      naoRodou: ev.reference.crashed,
      falhas: ev.reference.failed.map((f) => {
        const key = `f${++k}`
        keys[key] = { label, id: f.id }
        return { chave: key, teste: f.id, mensagem: f.message }
      }),
      testesQueSumiram: ev.suite.missingFromParent ?? []
    }
  }
  writeFileSync(path.join(dir, 'falhas-de-referencia.json'), JSON.stringify(fails, null, 2))
  writeFileSync(paths.map(t, n), JSON.stringify({ labels, keys }, null, 2))
  return { dir, prompt: reviewerPrompt(t, dir) }
}

export function reviewerPrompt(t, dir) {
  return `Você é revisor de código, às cegas. Leia os arquivos da pasta ${dir}:
- pedido.md: o pedido original do usuário (a tarefa).
- referencia.patch: a solução que o usuário aprovou — é a régua, não a única resposta certa.
- A.patch e B.patch: duas implementações independentes do mesmo pedido, a partir do mesmo commit.
- regras-AGENTS.md: as regras do projeto naquele commit.
- falhas-de-referencia.json: os testes do commit de referência que falharam em A e em B (cada um com uma chave f1..fN), e os testes que passavam antes e sumiram.
Para conferir contexto, o código no commit de partida (só leitura) está em ${paths.worktree(t)}. Não leia nenhuma outra pasta e não tente descobrir qual implementação é de qual configuração.

Dê nota 1–5 para A e para B em cada critério, com justificativa curta e concreta (arquivo/trecho):
- atende: entrega o que o pedido pede (5 = tudo, sem faltar parte).
- bugs: ausência de bugs (5 = nenhum bug encontrado; 1 = bug grave).
- bordas: casos de borda tratados (5 = cobre os relevantes).
- regras: segue as regras do projeto (arquivos < 500 linhas, testes, estilo, sem commit indevido etc.).
Classifique CADA chave de falhas-de-referencia.json:
- "nome": falhou só porque a implementação deu outro nome, caminho, assinatura ou texto a algo que faz a mesma coisa. Arquivo de teste que nem carregou só é "nome" se o comportamento existe em outro módulo.
- "comportamento": a implementação não faz o que o teste verifica.
Na dúvida, "comportamento". Testes que sumiram contam no critério "regras" (e em "bugs", se escondem falha).

Responda SÓ com um JSON neste formato:
{"A":{"atende":n,"bugs":n,"bordas":n,"regras":n,"justificativa":"..."},"B":{...},"falhas":{"f1":{"tipo":"nome|comportamento","motivo":"..."},...},"comparacao":"uma frase: qual é melhor e por quê"}`
}

/** Grava a revisão com os lados revelados (o JSON do revisor + o mapa A/B). Recusa revisão incompleta. */
export function ingest(t, n, jsonFile) {
  const { labels, keys } = readJson(paths.map(t, n))
  const raw = readFileSync(jsonFile, 'utf8')
  const review = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  for (const label of ['A', 'B']) for (const c of CRITERIA) if (!(review[label]?.[c] >= 1 && review[label]?.[c] <= 5)) throw new Error(`nota inválida ${label}.${c}`)
  const missing = Object.keys(keys).filter((key) => !['nome', 'comportamento'].includes(review.falhas?.[key]?.tipo))
  if (missing.length) throw new Error(`falhas sem classificação: ${missing.join(', ')}`)
  const bySide = {}
  for (const label of ['A', 'B']) {
    const side = labels[label]
    const falhas = Object.entries(keys)
      .filter(([, v]) => v.label === label)
      .map(([key, v]) => ({ id: v.id, tipo: review.falhas[key].tipo, motivo: review.falhas[key].motivo }))
    bySide[side] = { label, notas: review[label], falhas }
  }
  const out = { par: n, labels, comparacao: review.comparacao, ...bySide }
  mkdirSync(path.dirname(paths.reviewResult(t, n)), { recursive: true })
  writeFileSync(paths.reviewResult(t, n), JSON.stringify(out, null, 2))
  return out
}

const [cmd, t, n, file] = process.argv.slice(2)
if (process.argv[1]?.endsWith('review.mjs')) {
  if (cmd === 'prepare' && TASKS[t]) {
    console.log(prepare(t, Number(n)).prompt)
  } else if (cmd === 'ingest' && TASKS[t] && file) {
    console.log(JSON.stringify(ingest(t, Number(n), file), null, 2))
  } else if (cmd) {
    console.log('uso: review.mjs prepare <t> <n> | ingest <t> <n> <json>')
    process.exit(1)
  }
}
