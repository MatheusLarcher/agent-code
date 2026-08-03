// Monta o dataset de treino do LoRA a partir dos dados REAIS deste projeto:
//  1. transcripts do agente (~/.claude/projects/<projeto>/*.jsonl): pedido do
//     usuário → a edição de arquivo que de fato entrou no código;
//  2. histórico do git: mensagem do commit → diff daquele commit.
//
// Saída: docs/bench/dataset/train.jsonl no formato {"messages":[user, assistant]}.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TRANSCRIPTS = join(homedir(), '.claude/projects/C--Users-mathe-Documents-GitHub-agent-code')
const OUT_DIR = join(REPO, 'docs/bench/dataset')
/** Exemplos maiores que isso não cabem no seq_len de treino da GPU de 8 GB. */
const MAX_CHARS = 6000
const MIN_CHARS = 80

const examples = []

/* ---------- 1. transcripts: pedido do usuário → edição aplicada ---------- */

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

for (const file of readdirSync(TRANSCRIPTS).filter((f) => f.endsWith('.jsonl'))) {
  let lastUser = null
  for (const line of readFileSync(join(TRANSCRIPTS, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const msg = row.message
    if (!msg) continue

    if (row.type === 'user' && typeof msg.content !== 'undefined') {
      const t = textOf(msg.content).trim()
      // Só pedidos humanos de verdade: nada de resultado de ferramenta nem meta.
      if (t && !t.startsWith('<') && !t.includes('tool_result') && t.length < 2000) lastUser = t
      continue
    }

    if (row.type === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c?.type !== 'tool_use') continue
        const { name, input } = c
        if (!lastUser) continue
        let assistant = null
        if (name === 'Write' && input?.content) {
          assistant = `Arquivo \`${input.file_path?.split(/[\\/]/).pop()}\`:\n\n\`\`\`ts\n${input.content}\n\`\`\``
        } else if (name === 'Edit' && input?.new_string) {
          assistant = `Em \`${input.file_path?.split(/[\\/]/).pop()}\`, troquei:\n\n\`\`\`ts\n${input.old_string}\n\`\`\`\n\npor:\n\n\`\`\`ts\n${input.new_string}\n\`\`\``
        }
        if (!assistant) continue
        if (assistant.length < MIN_CHARS || assistant.length > MAX_CHARS) continue
        examples.push({ source: 'transcript', messages: [
          { role: 'user', content: lastUser },
          { role: 'assistant', content: assistant }
        ] })
      }
    }
  }
}

/* ---------- 2. git: mensagem do commit → diff ---------- */

const hashes = execFileSync('git', ['log', '--format=%H', '--no-merges'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

for (const hash of hashes) {
  const subject = execFileSync('git', ['log', '-1', '--format=%s%n%b', hash], { cwd: REPO, encoding: 'utf8' }).trim()
  let diff
  try {
    diff = execFileSync('git', ['show', hash, '--format=', '--unified=3', '--', '*.ts', '*.tsx'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    })
  } catch {
    continue
  }
  if (!diff || diff.length < MIN_CHARS || diff.length > MAX_CHARS) continue
  examples.push({
    source: 'git',
    messages: [
      { role: 'user', content: `Implemente esta mudança no projeto agent-code:\n${subject}` },
      { role: 'assistant', content: `\`\`\`diff\n${diff}\n\`\`\`` }
    ]
  })
}

/* ---------- saída ---------- */

mkdirSync(OUT_DIR, { recursive: true })
const shuffled = examples
  .map((e, i) => ({ e, k: (i * 2654435761) % 4294967296 }))
  .sort((a, b) => a.k - b.k)
  .map((x) => x.e)
const split = Math.max(1, Math.floor(shuffled.length * 0.05))
const eva = shuffled.slice(0, split)
const train = shuffled.slice(split)

writeFileSync(join(OUT_DIR, 'train.jsonl'), train.map((e) => JSON.stringify({ messages: e.messages })).join('\n'), 'utf8')
writeFileSync(join(OUT_DIR, 'eval.jsonl'), eva.map((e) => JSON.stringify({ messages: e.messages })).join('\n'), 'utf8')

const porFonte = examples.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {})
const chars = examples.reduce((n, e) => n + e.messages[1].content.length, 0)
process.stdout.write(
  `exemplos: ${examples.length} (${JSON.stringify(porFonte)})\ntreino: ${train.length} | eval: ${eva.length}\nmédia de ${Math.round(chars / examples.length)} chars por resposta\n`
)
