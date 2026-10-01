/**
 * Gatilhos das animações 1 a 5 (card dec-todas-animacoes): compara o feed
 * anterior com o novo e diz o que ACONTECEU agora. Pura: o feed vem de fora.
 *
 *   1 delegação   — trilha nova de especialista (tool-use Agent/Task do
 *                   principal, agentTracks.reduceTracks) → 'delegacao';
 *                   a trilha fecha (tool-result) → 'devolucao' (✓, ou ✗ se isError).
 *   2 revisão     — trilha 'critico' abre → 'revisao' (com o executor que
 *                   trabalhou por último na conversa); fecha → 'veredito'.
 *   3 PO          — diagnóstico do PO em andamento (nova rodada) → 'po';
 *                   'audit-finished' novo → 'po-fim' com appliedOps.
 *   4 vigia       — vigiaAlerts[cid] aparece → 'vigia'; some → 'vigia-fim'.
 *   5 memorista   — diagnóstico em andamento → 'memorista';
 *                   'analysis-finished' novo → 'memorista-fim' com savedMemories.
 */
import type { MemoristaProviderDiagnosticMsg, PoProviderDiagnosticMsg } from '@shared/ipc'
import type { AgentTrack } from '../../agentTracks'
import { roleFromSubagentType, type CrewRole } from '../../crew'
import type { OfficeFeed } from './feed'

export type AnimTrigger =
  | { type: 'delegacao'; convId: string; trackId: string; role: CrewRole }
  | { type: 'devolucao'; convId: string; trackId: string; role: CrewRole; error: boolean }
  | { type: 'revisao'; convId: string; trackId: string; reviewedTrackId: string | null }
  | { type: 'veredito'; convId: string; trackId: string; reviewedTrackId: string | null; error: boolean }
  | { type: 'po'; convId: string; round: 'open' | 'close' }
  /** cards null = a rodada falhou (sem contagem). */
  | { type: 'po-fim'; convId: string; cards: number | null }
  | { type: 'vigia'; convId: string }
  | { type: 'vigia-fim'; convId: string }
  | { type: 'memorista'; convId: string }
  | { type: 'memorista-fim'; convId: string; saved: number | null }

const SPECIALISTS: ReadonlySet<CrewRole> = new Set(['executor', 'critico', 'navegador-de-codigo', 'memoria'])

/** Executor que trabalhou por último na conversa até `before` (inclusive). */
export function lastExecutor(tracks: Readonly<Record<string, AgentTrack>>, before: number): AgentTrack | null {
  let best: AgentTrack | null = null
  for (const t of Object.values(tracks)) {
    if (roleFromSubagentType(t.subagentType) !== 'executor' || t.startedAt > before) continue
    if (!best || t.startedAt > best.startedAt) best = t
  }
  return best
}

const poWorking = (d: PoProviderDiagnosticMsg | undefined): boolean =>
  !!d && d.phase !== 'audit-finished' && d.phase !== 'gpt-luna-unavailable'
const memWorking = (d: MemoristaProviderDiagnosticMsg | undefined): boolean =>
  !!d && d.phase !== 'analysis-finished' && d.phase !== 'gpt-luna-unavailable'

export function detectTriggers(prev: OfficeFeed | null, next: OfficeFeed): AnimTrigger[] {
  const out: AnimTrigger[] = []
  for (const c of next.conversations) {
    const cid = c.id
    const before = prev?.tracks[cid] ?? {}
    const tracks = next.tracks[cid] ?? {}
    // Primeiro feed (app abrindo, aba aberta depois): as trilhas que já rodam
    // são o ponto de partida, não delegações novas.
    for (const t of prev ? Object.values(tracks) : []) {
      const role = roleFromSubagentType(t.subagentType)
      if (!SPECIALISTS.has(role)) continue
      const old = before[t.id]
      if (!old && t.status === 'running') {
        out.push({ type: 'delegacao', convId: cid, trackId: t.id, role })
        if (role === 'critico') out.push({ type: 'revisao', convId: cid, trackId: t.id, reviewedTrackId: lastExecutor(tracks, t.startedAt)?.id ?? null })
      }
      // Fechou agora (ou já nasceu fechada, quando o feed pulou o "rodando").
      if (t.status !== 'running' && (!old || old.status === 'running')) {
        const error = t.status === 'error'
        // Crítico: o veredito (na mesa revisada) vem antes de devolver a pasta.
        if (role === 'critico') out.push({ type: 'veredito', convId: cid, trackId: t.id, reviewedTrackId: lastExecutor(tracks, t.startedAt)?.id ?? null, error })
        out.push({ type: 'devolucao', convId: cid, trackId: t.id, role, error })
      }
    }

    const hadVigia = prev?.vigiaAlerts[cid] !== undefined
    const hasVigia = next.vigiaAlerts[cid] !== undefined
    if (hasVigia && !hadVigia) out.push({ type: 'vigia', convId: cid })
    if (!hasVigia && hadVigia) out.push({ type: 'vigia-fim', convId: cid })

    if (next.observersOn.po) {
      const p0 = prev?.poDiagnostics[cid]
      const p1 = next.poDiagnostics[cid]
      if (p1 && p1.id !== p0?.id) {
        // Nova rodada: o primeiro diagnóstico "trabalhando" dela (correlação nova).
        if (poWorking(p1) && !(poWorking(p0) && p0?.correlationId === p1.correlationId)) {
          out.push({ type: 'po', convId: cid, round: p1.round === 'open' ? 'open' : 'close' })
        } else if (!poWorking(p1)) {
          out.push({ type: 'po-fim', convId: cid, cards: p1.phase === 'audit-finished' ? (p1.appliedOps ?? 0) : null })
        }
      }
    }

    if (next.observersOn.memorista) {
      const m0 = prev?.memoristaDiagnostics[cid]
      const m1 = next.memoristaDiagnostics[cid]
      if (m1 && m1.id !== m0?.id) {
        if (memWorking(m1) && !(memWorking(m0) && m0?.correlationId === m1.correlationId)) {
          out.push({ type: 'memorista', convId: cid })
        } else if (!memWorking(m1)) {
          out.push({ type: 'memorista-fim', convId: cid, saved: m1.phase === 'analysis-finished' ? (m1.savedMemories ?? 0) : null })
        }
      }
    }
  }
  return out
}
