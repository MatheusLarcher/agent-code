import { projectFolderKey } from '@shared/handoffProject'
import { readPref, writePref } from '../localPrefs'
import type { AwayEntry, AwayKind, AwaySummary } from './awaySummary'

/**
 * A ÚLTIMA VISITA de cada projeto e os resumos ainda abertos, neste PC
 * (localStorage, que mora no userData da instância). Os resumos ficam gravados
 * até o "ok": um F5 não some com o que você ainda não leu.
 */

const VISITS_KEY = 'agentcode.awayVisits.v1'
const SUMMARIES_KEY = 'agentcode.awaySummaries.v1'
/** Teto de projetos lembrados (os mais recentes ficam). */
const MAX_PROJECTS = 100

const CASE_INSENSITIVE = typeof navigator !== 'undefined' && /^win/i.test(navigator.platform ?? '')

export function awayProjectKey(cwd: string): string {
  return projectFolderKey(cwd, CASE_INSENSITIVE)
}

function readJson(key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readPref(key) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function loadVisits(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, at] of Object.entries(readJson(VISITS_KEY))) if (typeof at === 'number' && Number.isFinite(at)) out[key] = at
  return out
}

export function saveVisit(key: string, at: number): void {
  const visits = { ...loadVisits(), [key]: at }
  const kept = Object.entries(visits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROJECTS)
  writePref(VISITS_KEY, JSON.stringify(Object.fromEntries(kept)))
}

const KINDS: ReadonlySet<string> = new Set<AwayKind>(['concluida', 'espera', 'falhou'])

function isEntry(v: unknown): v is AwayEntry {
  const e = v as Partial<AwayEntry> | null
  return (
    !!e &&
    typeof e.kind === 'string' &&
    KINDS.has(e.kind) &&
    (e.cardId === null || typeof e.cardId === 'string') &&
    typeof e.conversationId === 'string' &&
    typeof e.title === 'string' &&
    (e.detail === null || typeof e.detail === 'string') &&
    typeof e.at === 'number'
  )
}

function isSummary(v: unknown): v is AwaySummary {
  const s = v as Partial<AwaySummary> | null
  const counts = s?.counts as Record<string, unknown> | undefined
  return (
    !!s &&
    typeof s.projectKey === 'string' &&
    typeof s.projectCwd === 'string' &&
    typeof s.since === 'number' &&
    typeof s.awayMs === 'number' &&
    !!counts &&
    [...KINDS].every((k) => typeof counts[k] === 'number') &&
    Array.isArray(s.entries) &&
    s.entries.length > 0 &&
    s.entries.every(isEntry)
  )
}

/** Gravado à mão ou corrompido: o que não tem a forma certa é ignorado. */
export function loadSummaries(): Record<string, AwaySummary> {
  const out: Record<string, AwaySummary> = {}
  for (const [key, summary] of Object.entries(readJson(SUMMARIES_KEY))) if (isSummary(summary) && summary.projectKey === key) out[key] = summary
  return out
}

export function saveSummaries(map: Record<string, AwaySummary>): void {
  const kept = Object.entries(map)
    .sort((a, b) => b[1].since + b[1].awayMs - (a[1].since + a[1].awayMs))
    .slice(0, MAX_PROJECTS)
  writePref(SUMMARIES_KEY, JSON.stringify(Object.fromEntries(kept)))
}
