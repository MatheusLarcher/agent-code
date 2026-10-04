/**
 * O uso das memórias para o painel (req-painel-memorias) — PURO, derivado do
 * que já está persistido (nada de banco novo):
 *   - escolhida pelo app: o trecho foi no pedido (memoriesSent dos turnos do
 *     contexto, gravados no banco);
 *   - lida: memory_list/memory_status (a lista) ou Read na pasta de memórias;
 *   - gravada / atualizada / aposentada: memory_propose (op create/update/retire).
 * O "quando" da ferramenta é o fim do turno dela (a resposta carimba `ts`); sem
 * ele, a última mudança da conversa.
 */
import type { ContextTurnSummary } from '@shared/contextSnapshot'
import type { MemoryListItem } from '@shared/memoryPanel'
import type { Conversation } from '../types'

export type UsageHow = 'escolhida' | 'lida' | 'gravada' | 'atualizada' | 'aposentada'

export interface UsageEvent {
  /** A memória; null = a lista toda (memory_list). */
  relPath: string | null
  convId: string
  /** O nome do agente (o título da conversa). */
  agent: string
  /** O projeto (a pasta da conversa). */
  project: string
  how: UsageHow
  at: number
}

const DAY = 86_400_000
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const PROPOSE: Record<string, UsageHow> = { create: 'gravada', update: 'atualizada', retire: 'aposentada' }

/** O relPath de um arquivo dentro da pasta de memórias (null fora dela). */
export function relInMemories(path: string, memoriesDir: string | null): string | null {
  if (!memoriesDir || !path || path.includes('..')) return null
  const p = path.replace(/\\/g, '/')
  const d = memoriesDir.replace(/\\/g, '/').replace(/\/+$/, '')
  // No Windows a comparação ignora a caixa; o relPath sai com a caixa do caminho (a do banco).
  const win = /^[a-z]:/i.test(d)
  const inside = win ? p.toLowerCase().startsWith(`${d.toLowerCase()}/`) : p.startsWith(`${d}/`)
  return inside ? p.slice(d.length + 1) : null
}

/** Das mensagens da conversa: as ferramentas de memória e as leituras na pasta. */
export function usageFromMessages(c: Conversation, memoriesDir: string | null): UsageEvent[] {
  const found: Array<Omit<UsageEvent, 'at'> & { i: number }> = []
  c.messages.forEach((m, i) => {
    if (m.kind !== 'tool-use' || !m.result || m.result.isError) return
    const o = m.input && typeof m.input === 'object' ? (m.input as Record<string, unknown>) : {}
    let ev: { relPath: string | null; how: UsageHow } | null = null
    if (m.name === 'mcp__memory__memory_propose') ev = { relPath: str(o.rel_path) || null, how: PROPOSE[str(o.op)] ?? 'gravada' }
    else if (m.name === 'mcp__memory__memory_list' || m.name === 'mcp__memory__memory_status') ev = { relPath: null, how: 'lida' }
    else if (m.name === 'Read') {
      const rel = relInMemories(str(o.file_path), memoriesDir)
      if (rel) ev = { relPath: rel, how: 'lida' }
    }
    if (ev) found.push({ ...ev, convId: c.id, agent: c.title || 'Agente', project: c.cwd, i })
  })
  return found.map(({ i, ...e }) => {
    let at = c.updatedAt
    for (let k = i + 1; k < c.messages.length; k++) {
      const ts = c.messages[k].ts
      if (typeof ts === 'number') {
        at = ts
        break
      }
    }
    return { ...e, at }
  })
}

/** Dos turnos do contexto: as memórias que o app escolheu e mandou no pedido. */
export function usageFromTurns(c: Conversation, turns: readonly ContextTurnSummary[]): UsageEvent[] {
  return turns.flatMap((t) => t.memoriesSent.map((relPath) => ({ relPath, convId: c.id, agent: c.title || 'Agente', project: c.cwd, how: 'escolhida' as const, at: t.startedAt })))
}

export type Period = 'agora' | 'hoje' | '7d' | 'tudo'
export type HowFilter = 'escolhida' | 'lida' | 'gravada'
export type SortBy = 'recentes' | 'mais-usadas' | 'nunca'

export interface PanelFilters {
  period: Period
  project: string | null
  folder: string | null
  /** A conversa (o agente). */
  agent: string | null
  how: HowFilter | null
  scope: MemoryListItem['scope'] | null
  text: string
  sort: SortBy
  chip: 'esquecidas' | 'conflito' | null
}

export const NO_FILTERS: PanelFilters = { period: 'tudo', project: null, folder: null, agent: null, how: null, scope: null, text: '', sort: 'recentes', chip: null }

/** "Agora" é a última meia hora. */
const NOW_MS = 30 * 60_000

function since(period: Period, now: number): number {
  if (period === 'agora') return now - NOW_MS
  if (period === 'hoje') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return period === '7d' ? now - 7 * DAY : -Infinity
}

const howMatches = (h: UsageHow, f: HowFilter | null): boolean => !f || (f === 'gravada' ? h === 'gravada' || h === 'atualizada' || h === 'aposentada' : h === f)

/** A linha do tempo "Usadas pelos agentes" com os filtros (a mais recente primeiro). */
export function filterUsage(events: readonly UsageEvent[], items: readonly MemoryListItem[], f: PanelFilters, now: number): UsageEvent[] {
  const byRel = new Map(items.map((i) => [i.relPath, i]))
  const text = f.text.trim().toLowerCase()
  return events
    .filter((e) => {
      const item = e.relPath ? byRel.get(e.relPath) : undefined
      if (e.at < since(f.period, now) || !howMatches(e.how, f.how)) return false
      if ((f.project && e.project !== f.project) || (f.agent && e.convId !== f.agent)) return false
      if (f.folder !== null && (!item || item.folder !== f.folder)) return false
      if (f.scope && (!item || item.scope !== f.scope)) return false
      if (text && !`${item?.title ?? ''} ${item?.hook ?? ''} ${e.relPath ?? ''} ${e.agent}`.toLowerCase().includes(text)) return false
      return true
    })
    .sort((a, b) => b.at - a.at)
}

export interface MemoryRow extends MemoryListItem {
  uses: number
  lastUse: number | null
  /** Usos por dia, dos 7 últimos (o último é hoje). */
  week: number[]
}

/** "Todas as memórias": com o uso, os filtros, os chips e a ordem pedida. `bodies` = os textos já lidos (a busca olha o corpo também). */
export function memoryRows(items: readonly MemoryListItem[], events: readonly UsageEvent[], f: PanelFilters, now: number, conflicts: ReadonlySet<string>, bodies: ReadonlyMap<string, string> = new Map()): MemoryRow[] {
  const usageFilter = f.period !== 'tudo' || f.agent !== null || f.how !== null || f.project !== null
  const used = filterUsage(events, items, { ...f, text: '' }, now)
  const all = events.filter((e) => e.relPath)
  const text = f.text.trim().toLowerCase()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const rows = items.map((i): MemoryRow => {
    const mine = all.filter((e) => e.relPath === i.relPath)
    const week = Array.from({ length: 7 }, (_, d) => {
      const from = today.getTime() - (6 - d) * DAY
      return mine.filter((e) => e.at >= from && e.at < from + DAY).length
    })
    return { ...i, uses: mine.length, lastUse: mine.length ? Math.max(...mine.map((e) => e.at)) : null, week }
  })
  return rows
    .filter((r) => {
      if (f.folder !== null && r.folder !== f.folder) return false
      if (f.scope && r.scope !== f.scope) return false
      if (f.project && !(r.projectCwd === f.project || used.some((e) => e.relPath === r.relPath))) return false
      if (usageFilter && !f.project && !used.some((e) => e.relPath === r.relPath)) return false
      if (text && !`${r.title} ${r.hook} ${bodies.get(r.relPath) ?? ''}`.toLowerCase().includes(text)) return false
      if (f.chip === 'esquecidas' && r.lastUse !== null && now - r.lastUse < 30 * DAY) return false
      if (f.chip === 'conflito' && !conflicts.has(r.relPath)) return false
      return true
    })
    .sort((a, b) =>
      f.sort === 'mais-usadas' ? b.uses - a.uses || a.title.localeCompare(b.title) :
      f.sort === 'nunca' ? (a.uses === 0 ? 0 : 1) - (b.uses === 0 ? 0 : 1) || a.title.localeCompare(b.title) :
      (b.lastUse ?? -Infinity) - (a.lastUse ?? -Infinity) || a.title.localeCompare(b.title)
    )
}

/** As linhas agrupadas pela pasta (como no MEMORY.md); a raiz primeiro. */
export function byFolder(rows: readonly MemoryRow[]): Array<{ folder: string; rows: MemoryRow[] }> {
  const groups = new Map<string, MemoryRow[]>()
  for (const r of rows) groups.set(r.folder, [...(groups.get(r.folder) ?? []), r])
  return [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map(([folder, rows]) => ({ folder, rows }))
}
