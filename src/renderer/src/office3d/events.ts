/**
 * Eventos dos agentes do Escritório 3D — camada PURA (sem three, sem React,
 * sem relógio próprio). Diz, por personagem, o que ele está fazendo AGORA
 * (AgentStatus) e o que ACABOU de acontecer entre dois retratos (AgentEvent).
 * É a base de reações, animações e falas: elas consomem isto, não o feed.
 *
 * API pública (estável):
 *   snapshotOf(feed, model, now): OfficeSnapshot
 *     Retrato de todos os personagens de `model` — o MESMO deriveOfficeModel
 *     do layout. `snap.agents.get(key)` é o AgentStatus, na ordem do modelo.
 *   agentStatus(feed, character, now): AgentStatus
 *     O status de UM personagem, sem montar o retrato inteiro.
 *   diffEvents(prev, next, now): AgentEvent[]
 *     O que aconteceu de `prev` para `next`, cada evento com `at: now`, na
 *     ordem dos personagens. prev null (primeiro retrato) → []: histórico não
 *     dispara. Personagem que não estava em `prev` entra como linha de base
 *     (nada dispara), salvo o `request` de turno iniciado depois de prev.at.
 *   Auxiliares puros: parseTestSummary, describeTool, toolKind, shortName,
 *   shortCommand, clip.
 *
 * Fase, por prioridade:
 *   principal  'waiting-permission' (permissão/pergunta pendente) → 'error'
 *              (o turno terminou em erro, inclusive esperando a recuperação
 *              agendada) → 'working' (busyIds) → 'done' (resposta final há
 *              menos de DONE_MS) → 'idle'.
 *   trilha     running → 'working'; error → 'error'; done → 'done' por DONE_MS
 *              depois de endedAt, depois 'idle'.
 *   observador (PO, vigia, memorista) → 'working' se ativo, senão 'idle'.
 *
 * Quem recebe cada evento: tool, test-result, done e error valem para o
 * principal e para o subagente (trilha); o resto só para o principal. done do
 * principal = saiu de ocupado sem erro e sem cancelar; done/error da trilha =
 * ela fechou. Um subagente que sai de cena ao terminar não recebe evento — o
 * principal recebe `return`. Ordem, por personagem: request, permission-done,
 * tool, test-result, delegate/return, permission, error, done, context-low,
 * usage-exhausted/usage-back, stalled, speaking.
 *
 * Reaproveita: scanTurn (ferramenta aberta e fim OK do turno), currentTool e
 * toolPath (passo do subagente, caminho), callSegments (+N −M) e
 * contextBattery sobre o contexto do modelo (contextLimitFor).
 *
 * Custo: O(personagens + mensagens do turno atual + passos das trilhas, que o
 * agentTracks limita). Nada percorre o histórico; o índice de conversas é
 * O(conversas), como o próprio deriveOfficeModel.
 */
import { usageProviderOf, type PermissionRequest } from '@shared/ipc'
import { readableMediaText } from '@shared/inlineMedia'
import type { AgentTrack } from '../agentTracks'
import { currentTool, toolPath } from '../components/office/screenContent'
import { callSegments, lineText, type CrewRole } from '../crew'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel, OfficeModel } from '../office/adapter/model'
import { scanTurn, type TurnScan } from '../office/adapter/turn'
import type { Conversation, UIMessage } from '../types'
import { contextBattery } from './battery'
import { apiError } from './quips/format'

export type AgentPhase = 'idle' | 'working' | 'waiting-permission' | 'error' | 'done'
export type ToolKind = 'edit' | 'write' | 'read' | 'search' | 'bash' | 'web' | 'task' | 'other'

/** Chamada em andamento (ainda sem resultado). */
export interface AgentTool {
  /** id do tool-use: muda a cada chamada, mesmo repetindo a ferramenta. */
  id: string
  /** Nome como o SDK manda (Edit, Bash, Agent, mcp__browser__…). */
  name: string
  kind: ToolKind
  /** Arquivo (basename), comando, padrão, host ou tipo do subagente; '' sem alvo. Até TARGET_MAX. */
  target: string
  /** "+N −M" em edit/write; resumo (descrição, pasta, prompt) no resto; ''. Até DETAIL_MAX. */
  detail: string
}

export interface AgentStatus {
  /** Chave do personagem (OfficeCharacterModel.key). */
  key: string
  convId: string
  role: CrewRole
  /** Trilha do subagente; ausente no principal e nos observadores. */
  trackId?: string
  phase: AgentPhase
  /** Só com phase 'working' ou 'waiting-permission'. */
  tool: AgentTool | null
  /** Último pedido do usuário na conversa (mídia como "[mídia N]"), até TEXT_MAX; ''. */
  lastUserText: string
  /** Epoch ms do começo do trabalho atual; null parado (ou sem o dado). */
  busySinceMs: number | null
  /** Epoch ms desde quando está parado; null ocupado. */
  idleSinceMs: number | null
  /** Contexto RESTANTE em % inteiro (a bateria); null sem dado. Só principal. */
  contextPct: number | null
  /** Permissão ou pergunta pendente. Só principal. */
  permission: { tool: string; detail: string } | null
  /** Erro do turno (1ª linha, até TEXT_MAX; o da API já em português, sem JSON); null sem erro. */
  error: string | null
  /** Limite de uso estourado (resetsAt null = sem horário). Só principal. */
  usageExhausted: { resetsAt: number | null } | null
  /** A voz está lendo uma mensagem do turno atual. Só principal. */
  speaking: boolean
  /** Há quanto tempo o turno está sem sinal de vida (feed.stalledSince); 0 sem travamento. Só principal. */
  stalledMs: number
}

/** O que o turno (ou a trilha) fez: basenames e comandos curtos, sem repetir. */
export interface DoneSummary {
  /** Edit, MultiEdit, NotebookEdit. */
  edited: string[]
  /** Write (arquivo escrito inteiro). */
  created: string[]
  /** Bash/PowerShell. */
  commands: string[]
}

export type AgentEventBody =
  /** Mensagem nova do usuário (o texto de lastUserText). */
  | { type: 'request'; text: string }
  /** Chamada nova em andamento. */
  | { type: 'tool'; name: string; kind: ToolKind; target: string }
  /** Saída nova de Bash/PowerShell com resumo de vitest, jest, pytest ou go test. */
  | { type: 'test-result'; passed: number; failed: number }
  | { type: 'permission'; tool: string; detail: string }
  | { type: 'permission-done' }
  /** Trilha nova de subagente; childKey = o personagem que a mostra. */
  | { type: 'delegate'; childKey: string; description: string }
  /** A trilha fechou; ok = sem erro. */
  | { type: 'return'; childKey: string; ok: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; summary: DoneSummary }
  /** Contexto restante cruzou um degrau de CONTEXT_LOW_STEPS para baixo. */
  | { type: 'context-low'; pct: number }
  | { type: 'usage-exhausted'; resetsAt: number | null }
  /** Saiu do limite: recuperou, turno novo ou o resetsAt passou. */
  | { type: 'usage-back' }
  /** Cruzou STALL_MS sem sinal de vida. */
  | { type: 'stalled'; ms: number }
  /** A voz começou/parou de ler o turno dele. */
  | { type: 'speaking'; on: boolean }

/** `key`/`convId` do personagem que viveu o evento; `at` = o `now` do diff. */
export type AgentEvent = { key: string; convId: string; at: number } & AgentEventBody
export type AgentEventType = AgentEvent['type']

/** Interno: o que o diff compara por conversa. Não dependa da forma. */
export interface ConvFacts {
  conv: Conversation | null
  busy: boolean
  scan: TurnScan
  /** Índice da última mensagem do usuário (começo do turno); -1 sem ela. */
  start: number
  user: { id: string; ts: number | null; text: string; canceled: boolean } | null
  error: { key: string; text: string; usage: boolean } | null
  permissionId: string | null
  /** Saídas de Bash/PowerShell do principal no turno, por id do tool-use. */
  outputs: ReadonlyMap<string, string>
  /** Resultado com erro de Agent/Task no turno, por id (= id da trilha). */
  taskErrors: ReadonlyMap<string, string>
  speaking: boolean
  tracks: ReadonlyMap<string, { track: AgentTrack; childKey: string }>
}

export interface OfficeSnapshot {
  /** O `now` do retrato (epoch ms). */
  at: number
  agents: ReadonlyMap<string, AgentStatus>
  /** Interno: base do diff. */
  convs: ReadonlyMap<string, ConvFacts>
}

/** Quanto 'done' dura depois do fim OK; depois vira 'idle'. */
export const DONE_MS = 15_000
/** `stalled` dispara ao cruzar isto sem sinal de vida. */
export const STALL_MS = 2 * 60_000
/** `context-low` dispara ao cruzar estes restantes (%), de cima para baixo. */
export const CONTEXT_LOW_STEPS: readonly number[] = [20, 10]
export const TARGET_MAX = 40
export const DETAIL_MAX = 60
export const TEXT_MAX = 80

// ── texto curto ────────────────────────────────────────────────────────────
/** Uma linha (espaços colapsados), cortada em `max` com "…". */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Último segmento de um caminho Windows ou POSIX. */
export function shortName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return clip(parts[parts.length - 1] ?? '', TARGET_MAX)
}

const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/

/** 1ª linha não vazia do comando, sem os `cd pasta &&` da frente. */
export function shortCommand(command: string): string {
  let line = (command.split('\n').find((l) => l.trim()) ?? '').trim()
  while (CD_PREFIX.test(line)) line = line.replace(CD_PREFIX, '')
  return clip(line, TARGET_MAX)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function hostOf(url: string): string {
  try {
    return clip(new URL(url).host, TARGET_MAX)
  } catch {
    return clip(url, TARGET_MAX) // sem protocolo: mostra como veio
  }
}

// ── ferramentas ────────────────────────────────────────────────────────────
const TOOLS_BY_KIND: Record<Exclude<ToolKind, 'other'>, string[]> = {
  edit: ['Edit', 'MultiEdit', 'NotebookEdit'], write: ['Write'], read: ['Read'], search: ['Grep', 'Glob'],
  bash: ['Bash', 'BashOutput', 'KillShell', 'PowerShell'], web: ['WebFetch', 'WebSearch'], task: ['Task', 'Agent']
}
const KINDS = new Map(Object.entries(TOOLS_BY_KIND).flatMap(([kind, names]) => names.map((n) => [n, kind as ToolKind] as const)))

/** Navegador embutido (mcp__browser__*) e Chrome (mcp__chrome__*) contam como web. */
export const toolKind = (name: string): ToolKind => KINDS.get(name) ?? (/^mcp__(browser|chrome)__/.test(name) ? 'web' : 'other')

export function describeTool(id: string, name: string, input: unknown): AgentTool {
  const i = asRecord(input)
  const kind = toolKind(name)
  const segs = callSegments(name, i)
  const at = (target: string, detail: string): AgentTool => ({ id, name, kind, target, detail })
  switch (kind) {
    case 'edit':
    case 'write':
    case 'read':
      return at(shortName(toolPath(i)), segs.filter((s) => s.kind === 'add' || s.kind === 'del').map((s) => s.text).join(' '))
    case 'search':
      return at(clip(str(i.pattern), TARGET_MAX), shortName(str(i.path)))
    case 'bash':
      return at(shortCommand(str(i.command)), clip(str(i.description), DETAIL_MAX))
    case 'web':
      return at(i.url ? hostOf(str(i.url)) : clip(str(i.query), TARGET_MAX), clip(str(i.prompt), DETAIL_MAX))
    case 'task':
      return at(clip(str(i.subagent_type), TARGET_MAX) || 'subagente', clip(str(i.description) || str(i.prompt), DETAIL_MAX))
    default:
      return at('', clip(lineText(segs), DETAIL_MAX))
  }
}

// ── resumo de testes ───────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
/** vitest: "      Tests  1 failed | 38 passed (39)". */
const VITEST = /^[ \t]*Tests[ \t]{2,}(.+?)[ \t]*\(\d+\)[ \t]*$/gm
/** jest: "Tests:       1 failed, 23 passed, 24 total". */
const JEST = /^[ \t]*Tests:[ \t]+(.+)$/gm
/** pytest: "==== 1 failed, 17 passed, 2 warnings in 0.91s ====" (ou sem os "=", no -q). */
const PYTEST = /^[= \t]*((?:\d+ [a-z]+, )*\d+ [a-z]+) in [\d.]+s\b/gm
/** go test -v: "--- PASS: TestX"; sem -v, as linhas de pacote "ok"/"FAIL". */
const GO_CASE = /^[ \t]*--- (PASS|FAIL):/gm
const GO_OK = /^ok[ \t]+\S+[ \t]+(?:\(cached\)|[\d.]+s)/gm
const GO_FAIL = /^FAIL[ \t]+\S+[ \t]+(?:[\d.]+s|\[build failed\]|\[setup failed\])/gm

const lastMatch = (re: RegExp, text: string): string | null => [...text.matchAll(re)].pop()?.[1] ?? null
const num = (re: RegExp, s: string): number => Number(re.exec(s)?.[1] ?? 0)
const counts = (line: string | null): { passed: number; failed: number } | null =>
  line !== null && /\d+ (passed|failed)/.test(line) ? { passed: num(/(\d+) passed/, line), failed: num(/(\d+) failed/, line) } : null

/** Resumo de vitest, jest, pytest ou go test no fim de uma saída; null sem resumo. */
export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const text = output.slice(-20_000).replace(ANSI, '')
  const hit = counts(lastMatch(VITEST, text)) ?? counts(lastMatch(JEST, text))
  if (hit) return hit
  const py = lastMatch(PYTEST, text)
  // pytest: erro de coleta/fixture conta como falha.
  if (py && /\d+ (passed|failed|errors?)\b/.test(py)) return { passed: num(/(\d+) passed/, py), failed: num(/(\d+) failed/, py) + num(/(\d+) errors?\b/, py) }
  const cases = [...text.matchAll(GO_CASE)].map((m) => m[1])
  if (cases.length > 0) return { passed: cases.filter((c) => c === 'PASS').length, failed: cases.filter((c) => c === 'FAIL').length }
  const [ok, fail] = [GO_OK, GO_FAIL].map((re) => [...text.matchAll(re)].length)
  return ok + fail > 0 ? { passed: ok, failed: fail } : null
}

// ── retrato ────────────────────────────────────────────────────────────────
type UserMsg = Extract<UIMessage, { kind: 'user' }>
const PIPE_RESET = /\|(\d{9,})\s*$/ // "…limit reached|1999999999" (s), como em moreTriggers

/** 1ª linha, até TEXT_MAX; o erro da API vira português ANTES do corte (o error.message vem depois do JSON). */
const errorText = (text: string): string => {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(PIPE_RESET, '')
  return clip(apiError(line) ?? line, TEXT_MAX) || 'erro'
}

function convFacts(feed: OfficeFeed, conv: Conversation | undefined, keys: ReadonlyMap<string, string>): ConvFacts {
  const tracks = new Map<string, { track: AgentTrack; childKey: string }>()
  const outputs = new Map<string, string>()
  const taskErrors = new Map<string, string>()
  const speakingId = feed.speakingId ?? null
  let error: ConvFacts['error'] = null
  let user: UserMsg | null = null
  let activity = false
  let speaking = false
  let i = (conv?.messages.length ?? 0) - 1
  for (; conv && i >= 0; i--) {
    const m = conv.messages[i]
    if (speakingId !== null && 'id' in m && m.id === speakingId) speaking = true
    if (m.kind === 'user') {
      user = m
      break
    }
    // O erro só vale se nada aconteceu depois dele (a recuperação retoma o turno).
    if (m.kind === 'error' && !activity && !error) error = { key: m.id, text: m.text, usage: !!m.usageExhausted }
    else if (m.kind === 'assistant-text') activity = true
    else if (m.kind === 'tool-use' && m.parentToolUseId == null) {
      activity = true
      const kind = toolKind(m.name)
      if (m.result && kind === 'bash') outputs.set(m.id, m.result.text)
      if (m.result?.isError && kind === 'task') taskErrors.set(m.id, m.result.text)
    }
  }
  if (!error && user?.error) error = { key: `u:${user.id}:${user.error}`, text: user.error, usage: false }
  for (const t of Object.values(conv ? (feed.tracks[conv.id] ?? {}) : {})) tracks.set(t.id, { track: t, childKey: keys.get(t.id) ?? `track:${t.id}` })
  return {
    conv: conv ?? null, busy: conv ? feed.busyIds.has(conv.id) : false, start: i, error, outputs, taskErrors, speaking, tracks,
    scan: conv ? scanTurn(conv.messages) : { tool: null, error: false, okAt: null },
    user: user && { id: user.id, ts: user.ts ?? null, text: clip(readableMediaText(user.text), TEXT_MAX), canceled: !!user.canceled },
    permissionId: conv ? (feed.permissions[conv.id]?.id ?? null) : null
  }
}

function permissionOf(p: PermissionRequest): { tool: string; detail: string } {
  const question = p.questions?.[0]?.question
  if (question) return { tool: p.toolName, detail: clip(question, DETAIL_MAX) }
  const t = describeTool(p.id, p.toolName, p.input)
  return { tool: p.toolName, detail: t.target || t.detail }
}

/** Limite de uso pelos sinais da PRÓPRIA conversa: usageLimits não diz de qual conta é a janela. */
function exhaustion(feed: OfficeFeed, c: Conversation, f: ConvFacts, now: number): AgentStatus['usageExhausted'] {
  const rec = c.recovery
  let resetsAt: number | null
  if (rec?.reason === 'limit' && rec.scheduledAt >= 0) resetsAt = rec.scheduledAt > 0 ? rec.scheduledAt : null
  else if (f.error?.usage) {
    const pipe = PIPE_RESET.exec(f.error.text)
    const rejected = Object.values(feed.usageLimits ?? {}).find((l) => usageProviderOf(l.rateLimitType) === 'claude' && l.status === 'rejected')
    resetsAt = pipe ? Number(pipe[1]) * 1000 : (rejected?.resetsAt ?? null)
  } else return null
  return resetsAt !== null && now >= resetsAt ? null : { resetsAt }
}

function principalStatus(feed: OfficeFeed, ch: OfficeCharacterModel, now: number, f: ConvFacts, c: Conversation, s: AgentStatus): AgentStatus {
  const perm = feed.permissions[c.id]
  const okAt = f.scan.okAt
  s.phase = perm ? 'waiting-permission' : f.error ? 'error' : f.busy ? 'working' : okAt !== null && now - okAt < DONE_MS ? 'done' : 'idle'
  const tool = f.scan.tool
  if (tool && (s.phase === 'working' || s.phase === 'waiting-permission')) s.tool = describeTool(tool.id, tool.name, tool.input)
  s.busySinceMs = f.busy ? (feed.busySince[c.id] ?? null) : null
  s.idleSinceMs = f.busy ? null : (okAt ?? c.updatedAt)
  const battery = contextBattery(ch.context)
  s.contextPct = battery ? Math.round(battery.charge * 100) : null
  s.permission = perm ? permissionOf(perm) : null
  s.error = f.error ? errorText(f.error.text) : null
  s.usageExhausted = exhaustion(feed, c, f, now)
  s.speaking = f.speaking
  const since = feed.stalledSince[c.id]
  s.stalledMs = f.busy && since !== undefined ? Math.max(0, now - since) : 0
  return s
}

function trackStatus(feed: OfficeFeed, ch: OfficeCharacterModel, now: number, f: ConvFacts, track: AgentTrack, s: AgentStatus): AgentStatus {
  const ended = track.endedAt ?? track.startedAt
  s.phase = track.status === 'running' ? 'working' : track.status === 'error' ? 'error' : now - ended < DONE_MS ? 'done' : 'idle'
  if (track.status === 'running') {
    const t = currentTool(feed, { key: ch.key, convId: ch.convId, role: ch.role, trackId: track.id })
    if (t?.open) s.tool = describeTool(t.id, t.name, t.input)
    s.busySinceMs = track.startedAt
  } else s.idleSinceMs = ended
  if (track.status === 'error') s.error = errorText(f.taskErrors.get(track.id) ?? 'subagente terminou com erro')
  return s
}

function statusWith(feed: OfficeFeed, ch: OfficeCharacterModel, now: number, f: ConvFacts): AgentStatus {
  const s: AgentStatus = {
    key: ch.key, convId: ch.convId, role: ch.role, phase: ch.active ? 'working' : 'idle', tool: null, lastUserText: f.user?.text ?? '',
    busySinceMs: null, idleSinceMs: null, contextPct: null, permission: null, error: null, usageExhausted: null, speaking: false, stalledMs: 0
  }
  if (ch.trackId) s.trackId = ch.trackId
  if (ch.role === 'principal' && f.conv) return principalStatus(feed, ch, now, f, f.conv, s)
  const track = ch.trackId ? feed.tracks[ch.convId]?.[ch.trackId] : undefined
  return track ? trackStatus(feed, ch, now, f, track, s) : s
}

export function agentStatus(feed: OfficeFeed, character: OfficeCharacterModel, now: number): AgentStatus {
  const conv = feed.conversations.find((c) => c.id === character.convId)
  return statusWith(feed, character, now, convFacts(feed, conv, new Map()))
}

export function snapshotOf(feed: OfficeFeed, model: OfficeModel, now: number): OfficeSnapshot {
  const byId = new Map<string, Conversation>()
  for (const c of feed.conversations) byId.set(c.id, c)
  const keys = new Map<string, string>()
  for (const ch of model.characters) if (ch.trackId && !keys.has(ch.trackId)) keys.set(ch.trackId, ch.key)
  const convs = new Map<string, ConvFacts>()
  const agents = new Map<string, AgentStatus>()
  for (const ch of model.characters) {
    let f = convs.get(ch.convId)
    if (!f) convs.set(ch.convId, (f = convFacts(feed, byId.get(ch.convId), keys)))
    agents.set(ch.key, statusWith(feed, ch, now, f))
  }
  return { at: now, agents, convs }
}

// ── diff ───────────────────────────────────────────────────────────────────
type Emit = (body: AgentEventBody) => void

function summarize(calls: ReadonlyArray<{ name: string; input: unknown }>): DoneSummary {
  const edited = new Set<string>()
  const created = new Set<string>()
  const commands = new Set<string>()
  for (const { name, input } of calls) {
    const kind = toolKind(name)
    const i = asRecord(input)
    if (kind === 'edit') edited.add(shortName(toolPath(i)))
    else if (kind === 'write') created.add(shortName(toolPath(i)))
    else if (kind === 'bash' && str(i.command)) commands.add(shortCommand(str(i.command)))
  }
  return { edited: [...edited].filter(Boolean), created: [...created].filter(Boolean), commands: [...commands].filter(Boolean) }
}

/** Chamadas do principal no turno atual (só quando o `done` dispara). */
const turnCalls = (f: ConvFacts): Array<{ name: string; input: unknown }> =>
  (f.conv?.messages ?? []).slice(f.start + 1).flatMap((m) => (m.kind === 'tool-use' && m.parentToolUseId == null ? [m] : []))

function emitTest(text: string, emit: Emit): void {
  const r = parseTestSummary(text)
  if (r) emit({ type: 'test-result', ...r })
}

function taskDescription(t: AgentTrack): string {
  const prefix = t.subagentType ? `${t.subagentType}: ` : ''
  return clip(prefix && t.label.startsWith(prefix) ? t.label.slice(prefix.length) : t.label, DETAIL_MAX)
}

function principalEvents(p: AgentStatus, s: AgentStatus, f0: ConvFacts, f1: ConvFacts, emit: Emit): void {
  // Pedido novo (uma bolha removida faz o último usuário "voltar": não é pedido).
  const u0 = f0.user
  const u1 = f1.user
  const older = u1?.ts != null && u0?.ts != null && u1.ts < u0.ts
  if (u1 && u1.id !== u0?.id && !older) emit({ type: 'request', text: u1.text })
  if (f0.permissionId && f0.permissionId !== f1.permissionId) emit({ type: 'permission-done' })
  if (s.tool && s.tool.id !== p.tool?.id) emit({ type: 'tool', name: s.tool.name, kind: s.tool.kind, target: s.tool.target })
  for (const [id, text] of f1.outputs) if (!f0.outputs.has(id)) emitTest(text, emit)
  for (const [id, t1] of f1.tracks) {
    const t0 = f0.tracks.get(id)
    if (!t0 && t1.track.status === 'running') emit({ type: 'delegate', childKey: t1.childKey, description: taskDescription(t1.track) })
    // Fechou agora (ou já nasceu fechada, quando o feed pulou o "rodando").
    if (t1.track.status !== 'running' && (!t0 || t0.track.status === 'running')) {
      emit({ type: 'return', childKey: t0?.childKey ?? t1.childKey, ok: t1.track.status === 'done' })
    }
  }
  if (f1.permissionId && f1.permissionId !== f0.permissionId && s.permission) emit({ type: 'permission', ...s.permission })
  if (f1.error && f1.error.key !== f0.error?.key && s.error) emit({ type: 'error', message: s.error })
  if (f0.busy && !f1.busy && !f1.error && !f1.user?.canceled) emit({ type: 'done', summary: summarize(turnCalls(f1)) })
  const [c0, c1] = [p.contextPct, s.contextPct]
  if (c0 !== null && c1 !== null && CONTEXT_LOW_STEPS.some((step) => c0 > step && c1 <= step)) emit({ type: 'context-low', pct: c1 })
  if (!p.usageExhausted && s.usageExhausted) emit({ type: 'usage-exhausted', resetsAt: s.usageExhausted.resetsAt })
  else if (p.usageExhausted && !s.usageExhausted) emit({ type: 'usage-back' })
  if (p.stalledMs < STALL_MS && s.stalledMs >= STALL_MS) emit({ type: 'stalled', ms: s.stalledMs })
  if (p.speaking !== s.speaking) emit({ type: 'speaking', on: s.speaking })
}

function trackEvents(p: AgentStatus, s: AgentStatus, f0: ConvFacts, f1: ConvFacts, emit: Emit): void {
  const t1 = s.trackId ? f1.tracks.get(s.trackId)?.track : undefined
  if (!t1) return
  const t0 = f0.tracks.get(t1.id)?.track
  if (s.tool && s.tool.id !== p.tool?.id) emit({ type: 'tool', name: s.tool.name, kind: s.tool.kind, target: s.tool.target })
  const seen = new Set((t0?.steps ?? []).filter((st) => st.result !== undefined).map((st) => st.id))
  for (const st of t1.steps) if (st.result !== undefined && !seen.has(st.id) && toolKind(st.name) === 'bash') emitTest(st.result, emit)
  if (t1.status !== 'running' && (!t0 || t0.status === 'running')) {
    if (t1.status === 'error') emit({ type: 'error', message: s.error ?? 'subagente terminou com erro' })
    else emit({ type: 'done', summary: summarize(t1.steps) })
  }
}

export function diffEvents(prev: OfficeSnapshot | null, next: OfficeSnapshot, now: number): AgentEvent[] {
  const out: AgentEvent[] = []
  if (!prev) return out
  for (const s of next.agents.values()) {
    const emit: Emit = (body) => void out.push({ key: s.key, convId: s.convId, at: now, ...body })
    const p = prev.agents.get(s.key)
    const f0 = prev.convs.get(s.convId)
    const f1 = next.convs.get(s.convId)
    if (!f1) continue
    if (!p || !f0) {
      // Linha de base: só o pedido de um turno que começou depois do retrato anterior.
      const ts = f1.user?.ts ?? s.busySinceMs
      if (s.role === 'principal' && f1.user && ts !== null && ts > prev.at) emit({ type: 'request', text: f1.user.text })
      continue
    }
    if (s.role === 'principal') principalEvents(p, s, f0, f1, emit)
    else if (s.trackId) trackEvents(p, s, f0, f1, emit)
  }
  return out
}
