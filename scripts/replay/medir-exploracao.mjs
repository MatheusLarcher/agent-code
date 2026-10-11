// Mede quanto o agente explora ANTES do 1º Edit/Write no projeto, a partir dos
// transcripts JSONL do Claude Code (só leitura). Uso:
//   node medir-exploracao.mjs <dias> <pasta projects> [<outra pasta projects> ...]
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [daysArg, ...roots] = process.argv.slice(2)
const since = Date.now() - Number(daysArg) * 86400e3
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const STAMP = '[Contexto do sistema: mensagem enviada'

const isProjectEdit = (input) => {
  const fp = input?.file_path ?? input?.notebook_path
  return typeof fp === 'string' && !/[\\/](_sandbox|memories|planning)[\\/]/i.test(fp) && !/AppData[\\/]Local[\\/]Temp/i.test(fp)
}

function userText(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return null
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || null
}

function sessions() {
  const out = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      const dir = path.join(root, proj.name)
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
        const file = path.join(dir, f.name)
        if (fs.statSync(file).mtimeMs >= since) out.push({ proj: proj.name, file })
      }
    }
  }
  return out
}

const newTurn = (proj, t0, prompt) => ({
  proj, t0, prompt, last: t0, model: 0, tool: 0, agent: 0, calls: new Set(), perCall: new Map(),
  tools: {}, files: new Set(), usage: new Map(), toolUseTs: new Map(), edit: null, delegated: false, thinking: 0
})

function snapshot(t, ts) {
  const usage = [...t.usage.values()]
  const lastU = usage.at(-1) ?? {}
  const ctx = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  const batches = [...t.perCall.values()].filter((n) => n > 0)
  return {
    proj: t.proj, date: new Date(t.t0).toISOString().slice(0, 16), prompt: t.prompt,
    secs: Math.round((ts - t.t0) / 1000), calls: t.calls.size, model: Math.round(t.model / 1000),
    toolSecs: Math.round(t.tool / 1000), agentSecs: Math.round(t.agent / 1000),
    reads: t.tools.Read ?? 0, grep: t.tools.Grep ?? 0, glob: t.tools.Glob ?? 0, bash: t.tools.Bash ?? 0,
    agents: (t.tools.Agent ?? 0) + (t.tools.Task ?? 0), files: t.files.size,
    singleToolCalls: batches.filter((n) => n === 1).length, toolCalls: batches.length,
    ctxFirst: ctx(usage[0] ?? {}), ctxAtEdit: ctx(lastU), tokensSum: usage.reduce((s, u) => s + ctx(u) + (u.output_tokens ?? 0), 0),
    thinkingChars: t.thinking, outTokens: usage.reduce((s, u) => s + (u.output_tokens ?? 0), 0),
    handoff: /^#\s+\S/.test(t.prompt), effort: t.effort, llm: t.model_
  }
}

async function scan({ proj, file }, rows, stats) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let t = null
  const close = () => { if (t && !t.edit) stats[t.delegated ? 'delegated' : 'noEdit']++ }
  for await (const line of rl) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.isSidechain || !o.timestamp) continue
    const ts = Date.parse(o.timestamp)
    if (o.type === 'user') {
      const text = userText(o.message)
      if (text && text.includes(STAMP) && !o.isMeta) {
        close()
        const i = text.indexOf(STAMP)
        const after = text.slice(text.indexOf(']', i) + 1).replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '').trim()
        t = newTurn(proj, ts, after.replace(/\s+/g, ' ').slice(0, 90))
        stats.turns++
        continue
      }
      if (!t || t.edit) continue
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type !== 'tool_result') continue
        const u = t.toolUseTs.get(b.tool_use_id)
        if (u?.agent) t.agent += ts - u.ts
      }
      t.tool += Math.max(0, ts - t.last)
      t.last = ts
    } else if (o.type === 'assistant' && t && !t.edit) {
      const id = o.message?.id ?? o.uuid
      t.effort ??= o.effort ?? 'n/d'
      t.model_ ??= o.message?.model ?? 'n/d'
      if (!t.calls.has(id)) { t.calls.add(id); t.perCall.set(id, 0) }
      if (o.message?.usage) t.usage.set(id, o.message.usage)
      t.model += Math.max(0, ts - t.last)
      t.last = ts
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type === 'thinking') t.thinking += (b.thinking ?? '').length
        if (b?.type !== 'tool_use') continue
        t.perCall.set(id, t.perCall.get(id) + 1)
        t.tools[b.name] = (t.tools[b.name] ?? 0) + 1
        const agent = b.name === 'Agent' || b.name === 'Task'
        t.toolUseTs.set(b.id, { ts, agent })
        if (agent && /executor/i.test(String(b.input?.subagent_type ?? ''))) t.delegated = true
        if (b.name === 'Read' && b.input?.file_path) t.files.add(String(b.input.file_path).toLowerCase())
        if (EDIT.has(b.name) && isProjectEdit(b.input)) { t.edit = snapshot(t, ts); rows.push(t.edit); break }
      }
    }
  }
  close()
}

const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const rows = []
const stats = { files: 0, turns: 0, noEdit: 0, delegated: 0 }
const list = sessions()
stats.files = list.length
for (const s of list) await scan(s, rows, stats)

console.log(`sessões: ${stats.files} | pedidos: ${stats.turns} | com edição no projeto: ${rows.length} | sem edição: ${stats.noEdit} | edição delegada a executor: ${stats.delegated}`)
if (!rows.length) process.exit(0)
const cols = ['secs', 'calls', 'model', 'toolSecs', 'agentSecs', 'reads', 'grep', 'glob', 'bash', 'agents', 'files', 'ctxFirst', 'ctxAtEdit', 'tokensSum', 'outTokens', 'thinkingChars']
for (const [label, rs] of [['handoff', rows.filter((r) => r.handoff)], ['pedido comum', rows.filter((r) => !r.handoff)]]) {
  const m = (c) => q(rs.map((r) => r[c]), 0.5)
  console.log(`${label}: ${rs.length} pedidos | p50 ${m('secs')}s, ${m('calls')} chamadas, ${m('reads')} Read, ${m('files')} arquivos, ${m('grep') + m('glob')} buscas, ${Math.round(m('outTokens'))} tokens de saída`)
}
const byEffort = rows.reduce((acc, r) => ((acc[`${r.handoff ? 'H' : 'C'} ${r.llm} @ ${r.effort}`] ??= []).push(r), acc), {})
for (const [k, rs] of Object.entries(byEffort).sort((a, b) => b[1].length - a[1].length)) {
  const m = (c) => q(rs.map((r) => r[c]), 0.5)
  const spc = q(rs.filter((r) => r.calls).map((r) => r.model / r.calls), 0.5)
  console.log(`  ${k.padEnd(34)} ${String(rs.length).padStart(3)} pedidos (${rs.filter((r) => r.handoff).length} handoff) | p50 ${m('secs')}s, ${m('calls')} chamadas, ${m('outTokens')} tokens saída, ${spc.toFixed(1)} s/chamada`)
}
const perCall = rows.filter((r) => r.calls > 0).map((r) => r.model / r.calls)
console.log(`segundos de modelo por chamada: p50 ${q(perCall, 0.5).toFixed(1)} | p90 ${q(perCall, 0.9).toFixed(1)}`)
console.log('\nmétrica (até o 1º Edit)      p50        p75        p90        máx')
for (const c of cols) {
  const v = rows.map((r) => r[c])
  console.log(`${c.padEnd(26)} ${[0.5, 0.75, 0.9, 1].map((p) => String(q(v, p)).padStart(10)).join(' ')}`)
}
const single = rows.reduce((s, r) => s + r.singleToolCalls, 0)
const withTools = rows.reduce((s, r) => s + r.toolCalls, 0)
const model = rows.reduce((s, r) => s + r.model, 0)
const tool = rows.reduce((s, r) => s + r.toolSecs, 0)
console.log(`\nchamadas ao modelo com UMA ferramenta só (leitura em série): ${single}/${withTools} (${Math.round((100 * single) / Math.max(1, withTools))}%)`)
console.log(`tempo até o 1º Edit: modelo ${Math.round((100 * model) / Math.max(1, model + tool))}% | ferramentas ${Math.round((100 * tool) / Math.max(1, model + tool))}% (inclui espera de permissão e subagentes)`)
console.log('\npor projeto: projeto | pedidos com edição | p50 segs | p50 chamadas | p50 Reads')
const byProj = rows.reduce((acc, r) => ((acc[r.proj] ??= []).push(r), acc), {})
for (const [p, rs] of Object.entries(byProj).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${p.padEnd(40)} ${String(rs.length).padStart(4)} ${String(q(rs.map((r) => r.secs), 0.5)).padStart(8)} ${String(q(rs.map((r) => r.calls), 0.5)).padStart(8)} ${String(q(rs.map((r) => r.reads), 0.5)).padStart(8)}`)
}
console.log('\n15 mais lentos até o 1º Edit:')
for (const r of [...rows].sort((a, b) => b.secs - a.secs).slice(0, 15)) {
  console.log(`  ${r.date} ${r.proj.slice(0, 22).padEnd(22)} ${String(r.secs).padStart(5)}s ${String(r.calls).padStart(3)} chamadas ${String(r.reads).padStart(3)} Read ${String(r.grep + r.glob).padStart(3)} busca ${String(r.agents).padStart(2)} subag. ${String(r.agentSecs).padStart(5)}s em subag. | ${r.prompt}`)
}
