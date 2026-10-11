// Linha de base de uma SESSÃO REAL a partir do transcript do CLI (JSONL), para a
// validação da autonomia do handoff (plano-20261010-0616, etapa `validar`).
// Conta o que o plano quer zerar ou não piorar: perguntas (AskUserQuestion), esperas
// de 7 min (pergunta/permissão que expirou), turnos que terminaram perguntando,
// prompts do handoff que chegaram depois de uma espera, tempo ativo, chamadas ao
// modelo e contexto médio por chamada.
// Uso: node scripts/replay/baseline-sessao.mjs <sessao.jsonl> [<subagente.jsonl> ...] [--json saida.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endsWithQuestion } from './drive.mjs'

/** Carimbo que o app põe em toda mensagem enviada pelo usuário (abre um turno). */
export const STAMP = '[Contexto do sistema: mensagem enviada'
/** O que o app devolve ao modelo quando a pergunta/permissão expira (agentSession.ts, PERMISSION_TIMEOUT_MS). */
export const EXPIRED = [/não respondeu em 7 minutos/, /tempo de 7 minutos esgotado/]
/** Um prompt de handoff: começa com título Markdown ("# Handoff", "# Implementação", ou "# Arquivos"
 *  quando a leitura guiada põe a seção no topo). Pedido comum não começa com "#". */
const HANDOFF_HEAD = /^#\s+\S/
/** Prompt de handoff que chega mais que isto depois do fim do turno anterior não veio da fila. */
export const MANUAL_GAP_MS = 60_000

export function parseLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* linha truncada: ignora */
    }
  }
  return out
}

function textOfUser(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return null
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || null
}

/** O pedido sem o carimbo e sem os blocos de contexto ([X]…[/X]). */
export function requestBody(text) {
  const i = text.indexOf(STAMP)
  const after = i >= 0 ? text.slice(text.indexOf(']', i) + 1) : text
  return after.replace(/\[([A-Z_]+)\][\s\S]*?\[\/\1\]/g, '').trim()
}

const resultText = (b) => (typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content.map((x) => x?.text ?? '').join('\n') : '')
const ctxOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)

/** Linhas do agente que começam com o aviso (mesma regra do app: só no início da linha). */
const LEADING_MARKUP = /^\s*(?:(?:[-*+>]|\d+[.)])\s+)*(?:\*\*|__)?/u
export function attentionKinds(text) {
  const out = { atencao: 0, desvio: 0 }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(LEADING_MARKUP, '')
    if (/^ATENÇÃO:/u.test(line)) out.atencao++
    else if (/^DESVIO DO PLANO:/u.test(line)) out.desvio++
  }
  return out
}

/**
 * Contadores de UMA sessão. `main`: as entradas do transcript principal; `subagents`:
 * listas de entradas dos subagentes (chamadas e contexto deles também contam).
 */
export function sessionCounters(main, subagents = []) {
  const turns = []
  let turn = null
  const calls = new Map()
  let askUserQuestion = 0
  let expired = 0
  const attention = { atencao: 0, desvio: 0 }
  const closeTurn = () => {
    if (turn) turns.push(turn)
  }
  for (const o of main) {
    if (o.isSidechain || !o.timestamp) continue
    const ts = Date.parse(o.timestamp)
    if (o.type === 'user') {
      const text = textOfUser(o.message)
      if (text && text.includes(STAMP) && !o.isMeta) {
        closeTurn()
        const body = requestBody(text)
        turn = { start: ts, last: ts, body, handoff: HANDOFF_HEAD.test(body), lastText: '' }
        continue
      }
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type === 'tool_result' && EXPIRED.some((re) => re.test(resultText(b)))) expired++
      }
      if (turn) turn.last = Math.max(turn.last, ts)
    } else if (o.type === 'assistant') {
      const id = o.message?.id ?? o.uuid
      if (!calls.has(id)) calls.set(id, o.message?.usage ?? null)
      else if (o.message?.usage) calls.set(id, o.message.usage)
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b?.type === 'tool_use' && b.name === 'AskUserQuestion') askUserQuestion++
        if (b?.type === 'text' && b.text?.trim()) {
          const k = attentionKinds(b.text)
          attention.atencao += k.atencao
          attention.desvio += k.desvio
          if (turn) turn.lastText = b.text
        }
      }
      if (turn) turn.last = Math.max(turn.last, ts)
    }
  }
  closeTurn()
  for (const list of subagents) {
    for (const o of list) {
      if (o.type !== 'assistant') continue
      const id = `sub:${o.message?.id ?? o.uuid}`
      if (!calls.has(id) || o.message?.usage) calls.set(id, o.message?.usage ?? calls.get(id) ?? null)
    }
  }
  const ctx = [...calls.values()].filter(Boolean).map(ctxOf).filter((n) => n > 0)
  const handoffTurns = turns.filter((t) => t.handoff)
  // Prompts 2..N do handoff que chegaram com folga depois do fim do turno anterior: a fila
  // não os soltou (ou não existia) e alguém mandou depois.
  let lateHandoffPrompts = 0
  turns.forEach((t, i) => {
    if (!t.handoff || i === 0 || t === handoffTurns[0]) return
    if (t.start - turns[i - 1].last > MANUAL_GAP_MS) lateHandoffPrompts++
  })
  const first = turns[0]?.start ?? null
  const last = turns.length ? Math.max(...turns.map((t) => t.last)) : null
  return {
    turns: turns.length,
    handoffPrompts: handoffTurns.length,
    lateHandoffPrompts,
    askUserQuestion,
    expired7min: expired,
    turnsEndingInQuestion: turns.filter((t) => endsWithQuestion(t.lastText)).length,
    activeSecs: Math.round(turns.reduce((s, t) => s + (t.last - t.start), 0) / 1000),
    wallSecs: first !== null && last !== null ? Math.round((last - first) / 1000) : 0,
    calls: calls.size,
    avgContextTokens: ctx.length ? Math.round(ctx.reduce((a, b) => a + b, 0) / ctx.length) : 0,
    atencaoLines: attention.atencao,
    desvioLines: attention.desvio,
    firstAt: first !== null ? new Date(first).toISOString() : null,
    lastAt: last !== null ? new Date(last).toISOString() : null,
    firstRequest: turns[0]?.body.slice(0, 300) ?? ''
  }
}

/**
 * Os mesmos contadores sobre a conversa de implementação de uma RODADA do replay:
 * `projectsDir` = <rodada>/projects (transcripts movidos por collectTranscripts) e
 * `file` = o transcript da implementação (implementationTotals). Subagentes em
 * <pasta>/<sessão>/subagents/*.jsonl. `null` sem transcript.
 */
export function roundAutonomy(projectsDir, file) {
  if (!file || !existsSync(projectsDir)) return null
  for (const dir of readdirSync(projectsDir)) {
    const main = path.join(projectsDir, dir, file)
    if (!existsSync(main)) continue
    const subDir = path.join(projectsDir, dir, file.replace(/\.jsonl$/, ''), 'subagents')
    const subs = existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => parseLines(readFileSync(path.join(subDir, f), 'utf8'))) : []
    return sessionCounters(parseLines(readFileSync(main, 'utf8')), subs)
  }
  return null
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  const j = args.indexOf('--json')
  const outFile = j >= 0 ? args[j + 1] : null
  const files = args.filter((a, i) => a !== '--json' && (j < 0 || i !== j + 1))
  if (!files.length) {
    console.log('uso: node scripts/replay/baseline-sessao.mjs <sessao.jsonl> [<subagente.jsonl> ...] [--json saida.json]')
    process.exit(1)
  }
  const [mainFile, ...subs] = files
  const counters = sessionCounters(parseLines(readFileSync(mainFile, 'utf8')), subs.map((f) => parseLines(readFileSync(f, 'utf8'))))
  const result = { session: path.basename(path.dirname(mainFile)) || path.basename(mainFile), ...counters }
  if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
