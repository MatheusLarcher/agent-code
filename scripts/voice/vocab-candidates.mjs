// Levanta as palavras que o usuário escreve nas conversas — base para curar
// resources/voice/vocabulario.txt (o vocabulário de reforço do Parakeet).
//
//   node scripts/voice/vocab-candidates.mjs [--min 3] [--top 1500] [pasta...]
//
// Lê as transcrições .jsonl do Claude (padrão: ~/.claude/projects e as contas
// do Agent Code em %APPDATA%/agent-code-desktop/agent-code-local/claude-accounts),
// pega só o texto das mensagens do usuário (sem tool_result, sem subagente, sem os
// blocos de contexto que o app injeta) e conta em quantas mensagens DISTINTAS cada
// palavra aparece — prompts gerados pelo app se repetem idênticos e contam uma vez.
// A curadoria (tirar português comum, erros de digitação, decidir a grafia) é manual.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  if (i < 0) return dflt
  const v = Number(args[i + 1])
  args.splice(i, 2)
  return v
}
const MIN = opt('--min', 3)
const TOP = opt('--top', 1500)
const roots = args.length
  ? args
  : [join(homedir(), '.claude', 'projects'), join(process.env.APPDATA ?? '', 'agent-code-desktop', 'agent-code-local', 'claude-accounts')]

function* jsonlFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name !== 'subagents') yield* jsonlFiles(p)
    } else if (name.endsWith('.jsonl')) yield p
  }
}

/** Tira o que o app injeta em volta da mensagem do usuário. */
function userText(raw) {
  return raw
    .replace(/<([a-zA-Z_-]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\[([A-Z_]{3,})\][\s\S]*?\[\/\1\]/g, ' ')
    .replace(/\[Contexto do sistema:[^\]]*\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\\S+|\/\S+\/\S*/g, ' ')
}

const seen = new Set()
const count = new Map()
for (const root of roots) {
  for (const file of jsonlFiles(root)) {
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"type":"user"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row.type !== 'user' || row.isSidechain || row.isMeta) continue
      const c = row.message?.content
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
      if (!raw || raw.length > 4000) continue // prompts longos são do app, não ditados
      const text = userText(raw).trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      const words = new Set(text.toLowerCase().match(/[\p{L}][\p{L}\p{N}.+#-]*[\p{L}\p{N}+#]|[\p{L}]/gu) ?? [])
      for (const w of words) count.set(w, (count.get(w) ?? 0) + 1)
    }
  }
}

const rows = [...count].filter(([w, n]) => n >= MIN && w.length > 1).sort((a, b) => b[1] - a[1]).slice(0, TOP)
console.log(`# ${seen.size} mensagens distintas, ${count.size} palavras; ${rows.length} com >= ${MIN} mensagens`)
for (const [w, n] of rows) console.log(`${n}\t${w}`)
