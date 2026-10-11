// Tempo (só informativo): separa os transcripts da rodada, roda o script combinado
// (medir-exploracao.mjs, cópia sem mudança da mídia do plano) e tira o tempo total
// e as chamadas da conversa de implementação.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STAMP = '[Contexto do sistema: mensagem enviada'

/** Nome da pasta de projeto do Claude Code para um cwd (tudo que não é letra/dígito vira "-"). */
export const claudeProjectSlug = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-')

/**
 * A instância isolada usa o login de ~/.claude, então os transcripts dela caem em
 * ~/.claude/projects/<slug da worktree>. Move os da rodada para a pasta de dados dela.
 */
export function collectTranscripts(worktree, runData, home = os.homedir()) {
  const src = path.join(home, '.claude', 'projects', claudeProjectSlug(worktree))
  const dest = path.join(runData, 'projects', claudeProjectSlug(worktree))
  if (!existsSync(src)) return { dir: path.join(runData, 'projects'), files: 0 }
  cpSync(src, dest, { recursive: true })
  rmSync(src, { recursive: true, force: true })
  return { dir: path.join(runData, 'projects'), files: readdirSync(dest).filter((f) => f.endsWith('.jsonl')).length }
}

/** Saída do script combinado sobre os transcripts da rodada. */
export function runMedirExploracao(projectsDir) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1')), 'medir-exploracao.mjs')
  return execFileSync(process.execPath, [script, '3', projectsDir], { encoding: 'utf8' })
}

/** Do bloco "handoff: N pedidos | p50 Xs, Y chamadas, …" do script: segundos e chamadas até o 1º Edit. */
export function parseFirstEdit(output) {
  const m = /^handoff: (\d+) pedidos \| p50 (\d+)s, (\d+) chamadas, (\d+) Read/m.exec(String(output))
  return m ? { pedidos: Number(m[1]), secsToFirstEdit: Number(m[2]), callsToFirstEdit: Number(m[3]), readsToFirstEdit: Number(m[4]) } : null
}

/**
 * Totais da conversa de implementação (a que recebeu o handoff), somando os
 * subagentes dela (<sessão>/subagents/*.jsonl): o script combinado deixa de fora a
 * edição delegada a executor, que é o caso comum em tarefa grande. Tempo do 1º pedido
 * à última resposta, chamadas ao modelo, edições e o 1º Edit de qualquer um deles.
 */
export function implementationTotals(projectsDir) {
  let best = null
  for (const dir of readdirSync(projectsDir)) {
    const full = path.join(projectsDir, dir)
    for (const f of readdirSync(full).filter((x) => x.endsWith('.jsonl'))) {
      const t = totalsOf(path.join(full, f))
      if (t.handoff && (!best || t.calls > best.calls)) best = { ...t, dir: full }
    }
  }
  if (!best) return null
  const subDir = path.join(best.dir, best.file.replace(/\.jsonl$/, ''), 'subagents')
  const subs = existsSync(subDir) ? readdirSync(subDir).filter((x) => x.endsWith('.jsonl')).map((f) => totalsOf(path.join(subDir, f), true)) : []
  const firstEdits = [best.firstEditAt, ...subs.map((s) => s.firstEditAt)].filter(Boolean)
  const lastAt = Math.max(best.lastAt ?? 0, ...subs.map((s) => s.lastAt ?? 0))
  return {
    file: best.file,
    subagents: subs.length,
    secsTotal: best.firstAt && lastAt ? Math.round((lastAt - best.firstAt) / 1000) : 0,
    secsToFirstEditAny: firstEdits.length ? Math.round((Math.min(...firstEdits) - best.firstAt) / 1000) : null,
    calls: best.calls + subs.reduce((s, x) => s + x.calls, 0),
    callsMain: best.calls,
    edits: best.edits + subs.reduce((s, x) => s + x.edits, 0),
    tools: best.tools
  }
}

/** Edição no projeto (mesmo filtro do script combinado: fora de _sandbox, memórias, planejamento e temp). */
const projectEdit = (b) =>
  ['Edit', 'Write', 'MultiEdit'].includes(b.name) &&
  typeof b.input?.file_path === 'string' &&
  !/[\\/](_sandbox|memories|planning)[\\/]/i.test(b.input.file_path) &&
  !/[\\/]Temp[\\/]/i.test(b.input.file_path)

/** Um transcript: o principal começa no 1º pedido do usuário; o de subagente, na 1ª linha. */
function totalsOf(file, sidechain = false) {
  let first = null
  let last = null
  let firstEditAt = null
  let handoff = false
  const ids = new Set()
  const tools = {}
  let edits = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if ((!sidechain && o.isSidechain) || !o.timestamp) continue
    const ts = Date.parse(o.timestamp)
    if (sidechain) first ??= ts
    if (!sidechain && o.type === 'user' && first === null) {
      const c = o.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
      if (text.includes(STAMP)) {
        first = ts
        // O prompt de handoff começa com um título Markdown ("# Handoff", "# Implementação", ou "# Arquivos"
        // quando a leitura guiada põe a seção no topo); pedido comum e o pedido ao Manager não.
        handoff = /\]\s*(\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]\s*)*#\s+\S/i.test(text)
      }
    }
    if (o.type === 'assistant' && first !== null) {
      last = ts
      ids.add(o.message?.id ?? o.uuid)
      for (const b of o.message?.content ?? []) {
        if (b?.type !== 'tool_use') continue
        tools[b.name] = (tools[b.name] ?? 0) + 1
        if (projectEdit(b)) {
          edits++
          firstEditAt ??= ts
        }
      }
    }
  }
  return { file: path.basename(file), handoff, firstAt: first, lastAt: last, firstEditAt, calls: ids.size, edits, tools }
}
