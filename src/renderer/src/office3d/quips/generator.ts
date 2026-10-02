/**
 * Gerador de falas do Escritório 3D — PURO (sem DOM, sem relógio próprio, sem
 * Math.random). Lê o retrato de events.ts e decide o balão de cada agente.
 *
 * API pública:
 *   createQuipEngine(rng): QuipEngine
 *     rng: () => número em [0, 1). Mesma sequência + mesmas entradas = mesmas
 *     falas. seededRng(seed) dá um rng determinístico (mulberry32).
 *   engine.step(statuses, events, now): Map<key, Quip | null>
 *     statuses = snap.agents; events = diffEvents(prev, snap, now); now em
 *     epoch ms (o mesmo do snapshotOf). Devolve o balão ATUAL de cada agente de
 *     `statuses` (null = nenhum) e null, uma vez, para quem saiu de cena. Um Quip
 *     mantém a identidade enquanto o balão não muda: compare por referência.
 *     Chame também sem eventos (a cada 250–500 ms): é o step que expira TTLs,
 *     narra a ferramenta atual e sorteia os pensamentos de quem está à toa.
 *
 * Regras:
 *   1 balão por agente. Candidato entra se a prioridade for maior que a do balão
 *   atual, ou igual (o mais novo vence; progress só troca progress depois de
 *   MIN_DWELL_MS). PRIORITY: permission 70 > error 60 > request 50 >
 *   done/test-result/return 40 > warn 30 (context-low, stalled, usage) >
 *   progress 20 > idle/thought 10.
 *   Fixos "enquanto valerem" (ttlMs = Infinity), conferidos no status a cada
 *   step: permissão pendente, erro do turno e limite de uso estourado — o erro
 *   que veio com o limite vira a fala do limite (com a hora do reset) e não
 *   volta depois do usage-back. Sem o status confirmando, viram transientes
 *   (TTL_MS.fallback). Stalled e "lendo em voz alta" também caem quando o status
 *   deixa de valer; o resto vive o TTL da situação.
 *   Cooldown: progress não repete ferramenta+alvo (nem em seguida, nem dentro
 *   de REPEAT_MS); pedido novo zera, porque é outro turno. Idle: um sorteio a
 *   cada IDLE_MIN_MS–IDLE_MAX_MS, com chance IDLE_CHANCE.
 *   Sem evento novo, o status ainda fala: ferramenta atual não narrada,
 *   "pensando em …" do principal sem ferramenta, travamento a cada
 *   STALL_REMIND_MS e a leitura em voz alta.
 *   kind é o visual (cor do balão); priority e ttlMs vêm da situação — teste
 *   vermelho é kind 'error' com prioridade de resultado e TTL.
 *   Texto ≤ 72 (format.fill). A variação sai do rng num saquinho por situação,
 *   dividido pelo escritório: todas saem antes de alguma repetir.
 */
import { STALL_MS, toolKind, type AgentEvent, type AgentStatus, type DoneSummary, type ToolKind } from '../events'
import { bashFlavor, browserAction, clockTime, duration, extLabel, fill, tidyError, toolLabel, whoLabel, type Slots } from './format'
import { LINES, type Situation } from './lines'

export type QuipKind = 'request' | 'progress' | 'permission' | 'done' | 'error' | 'warn' | 'idle' | 'thought'

export interface Quip {
  readonly text: string
  readonly kind: QuipKind
  readonly icon: string
  readonly priority: number
  /** Infinity = fica enquanto a situação valer (o step tira quando acaba). */
  readonly ttlMs: number
  readonly convId: string
}

export type Rng = () => number

export interface QuipEngine {
  step(statuses: ReadonlyMap<string, AgentStatus>, events: readonly AgentEvent[], now: number): Map<string, Quip | null>
}

export const PRIORITY = { permission: 70, error: 60, request: 50, result: 40, warn: 30, progress: 20, idle: 10 } as const
export const TTL_MS = { request: 7_000, result: 9_000, warn: 9_000, progress: 6_000, idle: 6_500, fallback: 10_000 } as const
/** Progress fica pelo menos isto antes de outro progress tomar o lugar. */
export const MIN_DWELL_MS = 2_500
/** A mesma ferramenta+alvo não é narrada de novo dentro desta janela. */
export const REPEAT_MS = 60_000
export const IDLE_MIN_MS = 40_000
export const IDLE_MAX_MS = 120_000
export const IDLE_CHANCE = 0.6
/** Parte das falas à toa que conta há quanto tempo (o resto é pensamento). */
const IDLE_SAYS_TIME = 0.35
/** Principal ocupado sem ferramenta há isto → "pensando em …". */
export const THINK_AFTER_MS = 3_000
export const STALL_REMIND_MS = 90_000

/** Rng determinístico (mulberry32). A seed passa por um misturador antes: seeds vizinhas não andam juntas. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b)
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35)
  a = (a ^ (a >>> 16)) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

// ── situações ──────────────────────────────────────────────────────────────
type Spec = readonly [kind: QuipKind, priority: number, ttlMs: number]
const P = PRIORITY
const PROGRESS: Spec = ['progress', P.progress, TTL_MS.progress]
const STICKY_PERM: Spec = ['permission', P.permission, Infinity]
const STICKY_USAGE: Spec = ['warn', P.warn, Infinity]
const result = (kind: QuipKind, ttl: number = TTL_MS.result): Spec => [kind, P.result, ttl]
const warn = (ttl: number = TTL_MS.warn): Spec => ['warn', P.warn, ttl]

const SPEC: Record<Situation, Spec> = {
  request: ['request', P.request, TTL_MS.request],
  think: PROGRESS, edit: PROGRESS, write: PROGRESS, read: PROGRESS, search: PROGRESS,
  'bash-test': PROGRESS, 'bash-install': PROGRESS, 'bash-build': PROGRESS, 'bash-check': PROGRESS,
  'bash-git': PROGRESS, 'bash-serve': PROGRESS, 'bash-run': PROGRESS, 'bash-peek': PROGRESS,
  'web-search': PROGRESS, 'web-fetch': PROGRESS, 'web-browse': PROGRESS, task: PROGRESS, delegate: PROGRESS, other: PROGRESS,
  'perm-cmd': STICKY_PERM, 'perm-file': STICKY_PERM, 'perm-question': STICKY_PERM, 'perm-tool': STICKY_PERM,
  'perm-done': ['progress', P.progress, 4_000],
  error: ['error', P.error, Infinity],
  'done-files': result('done'), 'done-file': result('done'), 'done-cmds': result('done'), 'done-chat': result('done'),
  'test-pass': result('done'), 'test-fail': result('error', 10_000), 'test-none': result('warn', 8_000),
  'return-ok': result('done', 8_000), 'return-fail': result('error'),
  'context-low': warn(), stalled: warn(10_000), 'stalled-cmd': warn(10_000),
  'usage-time': STICKY_USAGE, 'usage-notime': STICKY_USAGE, 'usage-back': ['done', P.warn, 7_000],
  'speak-on': ['progress', P.progress, 5_000], 'speak-off': ['idle', P.idle, 3_500],
  idle: ['idle', P.idle, TTL_MS.idle], thought: ['thought', P.idle, TTL_MS.idle]
}

type Valid = (s: AgentStatus) => boolean

/** Uma fala possível, antes de sortear a variação. */
interface Cand {
  sit: Situation
  slots: Slots
  /** Enquanto o status confirmar, o fixo fica; o transiente cai antes do TTL se deixar de valer. */
  valid?: Valid
  /** Identidade do fixo: igual à do balão no ar → nada muda. */
  id?: string
  /** Cooldown de progress (ferramenta|alvo). */
  sig?: string
  /** O que a permissão pedia, para o "valeu" do permission-done. */
  perm?: string
}

interface AgentState {
  quip: Quip | null
  since: number
  until: number
  valid: Valid | null
  id: string
  /** sig → quando foi narrada; lastSig = a última narrada. */
  seen: Map<string, number>
  lastSig: string
  nextIdleAt: number | null
  stalledAt: number
  spoke: boolean
  lastPerm: string
  /** O erro que chegou junto do limite de uso: quem fala dele é o limite. */
  usageErr: string | null
}

const freshState = (): AgentState => ({
  quip: null, since: 0, until: 0, valid: null, id: '', seen: new Map(), lastSig: '',
  nextIdleAt: null, stalledAt: -Infinity, spoke: false, lastPerm: '', usageErr: null
})

const NO_EVENTS: readonly AgentEvent[] = []
const plural = (n: number): string => (n === 1 ? '' : 's')

function roleFromKey(key: string): string {
  if (key.startsWith('conv:')) return 'principal'
  if (key.startsWith('vigia:')) return 'vigia'
  if (key.startsWith('po:')) return 'po'
  if (key.startsWith('role:')) return key.slice(key.lastIndexOf(':') + 1)
  return 'subagente'
}

// ── candidatos ─────────────────────────────────────────────────────────────
interface ToolLike {
  name: string
  kind: ToolKind
  target: string
  detail: string
}

function progressCand(t: ToolLike): Cand {
  const sig = `${t.name}|${t.target}`
  const file = t.target || 'arquivo'
  switch (t.kind) {
    case 'edit':
      return { sig, sit: 'edit', slots: { file, diff: t.detail, ext: extLabel(file) } }
    case 'write':
      return { sig, sit: 'write', slots: { file } }
    case 'read':
      return { sig, sit: 'read', slots: { file } }
    case 'search':
      return { sig, sit: 'search', slots: { pattern: t.target || '*', dir: t.detail } }
    case 'bash':
      return t.target ? { sig, sit: `bash-${bashFlavor(t.target)}`, slots: { cmd: t.target } } : { sig, sit: 'bash-peek', slots: {} }
    case 'web':
      if (t.name === 'WebSearch' && t.target) return { sig, sit: 'web-search', slots: { q: t.target } }
      return t.target ? { sig, sit: 'web-fetch', slots: { host: t.target } } : { sig, sit: 'web-browse', slots: { action: browserAction(t.name) } }
    case 'task':
      return { sig, sit: 'task', slots: { who: whoLabel(t.target), desc: t.detail } }
    default:
      return { sig, sit: 'other', slots: { tool: toolLabel(t.name) } }
  }
}

function permCand(tool: string, detail: string): Cand {
  const kind = toolKind(tool)
  const base = {
    valid: (s: AgentStatus) => s.permission !== null && s.permission.tool === tool && s.permission.detail === detail,
    id: `perm|${tool}|${detail}`,
    perm: detail || toolLabel(tool)
  }
  if (tool === 'AskUserQuestion' && detail) return { ...base, sit: 'perm-question', slots: { q: detail } }
  if (kind === 'bash' && detail) return { ...base, sit: 'perm-cmd', slots: { cmd: detail } }
  if ((kind === 'edit' || kind === 'write' || kind === 'read') && detail) return { ...base, sit: 'perm-file', slots: { file: detail } }
  return { ...base, sit: 'perm-tool', slots: { tool: toolLabel(tool), what: detail } }
}

/** Cai se o limite de uso aparecer depois (a recuperação agendada): quem fala então é o limite. */
const errorCand = (text: string): Cand => ({
  sit: 'error',
  slots: { err: tidyError(text) },
  valid: (s) => s.error === text && s.usageExhausted === null,
  id: `err|${text}`
})

const usageCand = (resetsAt: number | null, now: number): Cand => ({
  sit: resetsAt !== null ? 'usage-time' : 'usage-notime',
  slots: resetsAt !== null ? { time: clockTime(resetsAt, now) } : {},
  valid: (s) => s.usageExhausted !== null,
  id: `usage|${resetsAt}`
})

function stalledCand(ms: number, s: AgentStatus): Cand {
  const cmd = s.tool?.kind === 'bash' ? s.tool.target : ''
  const valid: Valid = (x) => x.stalledMs > 0
  return cmd ? { sit: 'stalled-cmd', slots: { cmd, dur: duration(ms) }, valid } : { sit: 'stalled', slots: { dur: duration(ms) }, valid }
}

function testCand(passed: number, failed: number): Cand {
  if (failed > 0) return { sit: 'test-fail', slots: { n: failed, s: plural(failed), total: passed + failed } }
  if (passed > 0) return { sit: 'test-pass', slots: { n: passed, s: plural(passed) } }
  return { sit: 'test-none', slots: {} }
}

function doneCand(sum: DoneSummary, s: AgentStatus): Cand {
  const files = [...new Set([...sum.edited, ...sum.created])]
  if (files.length > 1) return { sit: 'done-files', slots: { n: files.length } }
  if (files.length === 1) return { sit: 'done-file', slots: { file: files[0] } }
  const [cmd, ...more] = sum.commands
  if (cmd) return { sit: 'done-cmds', slots: { cmd, more: more.length || '' } }
  return { sit: 'done-chat', slots: { text: s.role === 'principal' ? s.lastUserText : '' } }
}

/** Fixos que o status sustenta: permissão, limite de uso (no lugar do erro dele) ou erro. */
function stickyCands(st: AgentState, s: AgentStatus, now: number): Cand[] {
  const out: Cand[] = []
  if (s.permission) out.push(permCand(s.permission.tool, s.permission.detail))
  if (s.usageExhausted) out.push(usageCand(s.usageExhausted.resetsAt, now))
  else if (s.error !== null && s.error !== st.usageErr) out.push(errorCand(s.error))
  return out
}

function eventCand(e: AgentEvent, st: AgentState, s: AgentStatus, statuses: ReadonlyMap<string, AgentStatus>, now: number): Cand | null {
  const who = (childKey: string): string => whoLabel(statuses.get(childKey)?.role ?? roleFromKey(childKey))
  switch (e.type) {
    case 'request':
      return { sit: 'request', slots: { text: e.text || '…' } }
    case 'tool': {
      // O status tem o detalhe (+N −M) da mesma chamada; o evento, só o alvo.
      const same = s.tool && s.tool.name === e.name && s.tool.target === e.target
      return progressCand(same && s.tool ? s.tool : { name: e.name, kind: e.kind, target: e.target, detail: '' })
    }
    case 'test-result':
      return testCand(e.passed, e.failed)
    case 'permission':
      return permCand(e.tool, e.detail)
    case 'permission-done':
      return { sit: 'perm-done', slots: { what: st.lastPerm } }
    case 'delegate':
      return { sit: 'delegate', slots: { who: who(e.childKey), desc: e.description }, sig: `delegate|${e.childKey}` }
    case 'return':
      return { sit: e.ok ? 'return-ok' : 'return-fail', slots: { who: who(e.childKey) } }
    case 'error':
      return s.usageExhausted ? null : errorCand(e.message)
    case 'done':
      return doneCand(e.summary, s)
    case 'context-low':
      return { sit: 'context-low', slots: { pct: e.pct } }
    case 'usage-exhausted':
      return usageCand(e.resetsAt, now)
    case 'usage-back':
      return { sit: 'usage-back', slots: {} }
    case 'stalled':
      return stalledCand(e.ms, s)
    case 'speaking':
      return e.on
        ? { sit: 'speak-on', slots: { text: s.role === 'principal' ? s.lastUserText : '' }, valid: (x) => x.speaking }
        : { sit: 'speak-off', slots: {} }
  }
}

// ── motor ──────────────────────────────────────────────────────────────────
export function createQuipEngine(rng: Rng): QuipEngine {
  const agents = new Map<string, AgentState>()
  /** Saquinho por situação (o escritório todo divide): sai cada variação antes de repetir. */
  const bags = new Map<Situation, number[]>()
  const lastPick = new Map<Situation, number>()

  const roll = (): number => {
    const r = rng()
    return r >= 0 && r < 1 ? r : 0
  }

  /** Sorteia a variação: nenhuma repete antes de as outras saírem, nem logo depois do refil. */
  function pickLine(sit: Situation): string {
    const lines = LINES[sit].lines
    let bag = bags.get(sit)
    if (!bag || bag.length === 0) {
      const last = lastPick.get(sit)
      bag = lines.map((_, i) => i).filter((i) => lines.length === 1 || i !== last)
      bags.set(sit, bag)
    }
    const [i] = bag.splice(Math.floor(roll() * bag.length), 1)
    lastPick.set(sit, i)
    return lines[i]
  }

  const cooling = (st: AgentState, sig: string, now: number): boolean => {
    const at = st.seen.get(sig)
    return sig === st.lastSig || (at !== undefined && now - at < REPEAT_MS)
  }

  function clear(st: AgentState): void {
    st.quip = null
    st.valid = null
    st.id = ''
    st.until = 0
  }

  function show(st: AgentState, s: AgentStatus, c: Cand, now: number): void {
    const [kind, priority, base] = SPEC[c.sit]
    const holds = c.valid ? c.valid(s) : false
    const ttlMs = base === Infinity && !holds ? TTL_MS.fallback : base
    st.quip = { text: fill(pickLine(c.sit), c.slots), kind, icon: LINES[c.sit].icon, priority, ttlMs, convId: s.convId }
    st.since = now
    st.until = now + ttlMs
    st.valid = holds && c.valid ? c.valid : null
    st.id = c.id ?? ''
    if (c.sig) {
      for (const [k, at] of st.seen) if (now - at >= REPEAT_MS) st.seen.delete(k)
      st.seen.set(c.sig, now)
      st.lastSig = c.sig
    }
    if (c.perm !== undefined) st.lastPerm = c.perm
    if (c.sit === 'request') {
      // Turno novo: o que foi narrado no anterior pode ser narrado de novo.
      st.seen.clear()
      st.lastSig = ''
    }
    if (c.sit === 'stalled' || c.sit === 'stalled-cmd') st.stalledAt = now
    if (c.sit === 'speak-on') st.spoke = true
  }

  /** Mostra se puder; true também quando o mesmo fixo já está no ar. */
  function offer(st: AgentState, s: AgentStatus, c: Cand, now: number): boolean {
    if (c.sig && cooling(st, c.sig, now)) return false
    const cur = st.quip
    if (cur) {
      if (c.id && c.id === st.id) return true
      const priority = SPEC[c.sit][1]
      if (priority < cur.priority) return false
      if (priority === P.progress && cur.priority === P.progress && now - st.since < MIN_DWELL_MS) return false
    }
    show(st, s, c, now)
    return true
  }

  function idleTick(st: AgentState, s: AgentStatus, now: number): void {
    const next = (): number => now + IDLE_MIN_MS + roll() * (IDLE_MAX_MS - IDLE_MIN_MS)
    if (st.nextIdleAt === null) {
      st.nextIdleAt = next()
      return
    }
    if (now < st.nextIdleAt) return
    st.nextIdleAt = next()
    if (roll() >= IDLE_CHANCE) return
    const ago = s.idleSinceMs !== null && now - s.idleSinceMs >= 60_000 ? duration(now - s.idleSinceMs) : ''
    offer(st, s, roll() < IDLE_SAYS_TIME ? { sit: 'idle', slots: { ago } } : { sit: 'thought', slots: {} }, now)
  }

  /** Sem evento: o que o status ainda conta (só com o balão livre). */
  function ambient(st: AgentState, s: AgentStatus, now: number): void {
    const cur = st.quip
    if (cur && !(cur.priority === P.progress && now - st.since >= MIN_DWELL_MS)) return
    if (s.tool && offer(st, s, progressCand(s.tool), now)) return
    if (cur) return
    if (s.stalledMs >= STALL_MS && now - st.stalledAt >= STALL_REMIND_MS) {
      offer(st, s, stalledCand(s.stalledMs, s), now)
      return
    }
    if (s.speaking && !st.spoke) {
      offer(st, s, { sit: 'speak-on', slots: { text: s.role === 'principal' ? s.lastUserText : '' }, valid: (x) => x.speaking }, now)
      return
    }
    const thinking = s.role === 'principal' && s.phase === 'working' && !s.tool && s.busySinceMs !== null && now - s.busySinceMs >= THINK_AFTER_MS
    if (thinking && offer(st, s, { sit: 'think', slots: { text: s.lastUserText }, sig: `think|${s.lastUserText}` }, now)) return
    if (s.phase === 'idle') idleTick(st, s, now)
  }

  function stepAgent(st: AgentState, s: AgentStatus, events: readonly AgentEvent[], statuses: ReadonlyMap<string, AgentStatus>, now: number): Quip | null {
    if (st.quip && ((st.valid && !st.valid(s)) || now >= st.until)) clear(st)
    if (s.phase !== 'idle') st.nextIdleAt = null
    if (!s.speaking) st.spoke = false
    if (s.usageExhausted) st.usageErr = s.error
    else if (s.error === null) st.usageErr = null
    // Por prioridade; no empate, o evento mais novo primeiro.
    const cands: Array<{ c: Cand; order: number }> = []
    for (const c of stickyCands(st, s, now)) cands.push({ c, order: -1 })
    events.forEach((e, order) => {
      const c = eventCand(e, st, s, statuses, now)
      if (c) cands.push({ c, order })
    })
    cands.sort((a, b) => SPEC[b.c.sit][1] - SPEC[a.c.sit][1] || b.order - a.order)
    for (const { c } of cands) if (offer(st, s, c, now)) break
    ambient(st, s, now)
    return st.quip
  }

  return {
    step(statuses, events, now) {
      const byKey = new Map<string, AgentEvent[]>()
      for (const e of events) {
        if (!statuses.has(e.key)) continue
        const list = byKey.get(e.key)
        if (list) list.push(e)
        else byKey.set(e.key, [e])
      }
      const out = new Map<string, Quip | null>()
      for (const [key, s] of statuses) {
        let st = agents.get(key)
        if (!st) agents.set(key, (st = freshState()))
        out.set(key, stepAgent(st, s, byKey.get(key) ?? NO_EVENTS, statuses, now))
      }
      for (const key of agents.keys()) {
        if (statuses.has(key)) continue
        agents.delete(key)
        out.set(key, null)
      }
      return out
    }
  }
}
