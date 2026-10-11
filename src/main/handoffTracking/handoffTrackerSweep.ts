import { parseMs, type HandoffEnvio } from '../../shared/handoffTracking'
import type { HandoffRepository } from '../persistence/types'
import type { HandoffJobs } from './handoffJobs'
import type { HandoffReconciler } from './handoffReconcile'
import * as rules from './handoffRules'
import { closeSlice, mayHaveStalled, type ConvState } from './handoffState'

/**
 * A VARREDURA do acompanhamento (HandoffTracker.loadKnown/sweep): a carga das
 * conversas com envio em curso na abertura e a passada periódica que grava a
 * fatia ativa de quem roda e marca `parada` o que ficou sem turno. Só lê e
 * escreve pelo que o tracker lhe dá — o estado continua dele.
 */

/** A carência depois do boot (a mesma da fila do projeto) mora em handoffActivity.ts. */
export { BOOT_GRACE_MS } from './handoffActivity'

export interface SweepContext {
  states: Map<string, ConvState>
  /** Cria (ou acha) o estado da conversa, sem contar isso como atividade. */
  state(convId: string, cwd: string): ConvState
  jobs: Pick<HandoffJobs, 'addTime' | 'markStalled'>
  reconciler: Pick<HandoffReconciler, 'schedule' | 'scheduleUnsettled'>
  exclusive<T>(convId: string, job: () => Promise<T>): Promise<T>
  repo(): HandoffRepository | null
  now(): number
  /** Nenhuma parada antes deste instante (o boot mais a carência). */
  notBefore: number
  stallMs: number
}

/**
 * As conversas com envio em curso no banco viram conhecidas (para a parada,
 * contada da escrita mais recente delas — não do boot), e o reconciliador passa
 * em cada projeto com envio saído e não concluído (o Quadro pode ter andado com
 * o app fechado). Lança se o banco falhar — a varredura tenta de novo depois.
 */
export async function loadKnownConversations(ctx: SweepContext): Promise<boolean> {
  const repo = ctx.repo()
  if (!repo) return false
  const envios: HandoffEnvio[] = await repo.listHandoffEnvios({ statuses: [...rules.HANDOFF_OPEN_STATUSES], limit: 1000 })
  const fresh = new Set<string>()
  for (const envio of envios) {
    if (!ctx.states.has(envio.conversationId)) fresh.add(envio.conversationId)
    const s = ctx.state(envio.conversationId, envio.projectCwd)
    s.projectId ??= envio.projectId
    if (fresh.has(envio.conversationId)) s.lastActivity = Math.max(s.lastActivity, parseMs(envio.updatedAt) ?? 0)
  }
  await ctx.reconciler.scheduleUnsettled(repo)
  return true
}

/** Uma passada: grava a fatia ativa de quem está rodando e marca `parada` (nunca
 *  na carência do boot) — e o reconciliador relê o projeto do que parou. */
export async function sweepConversations(ctx: SweepContext): Promise<{ flushed: number; stalled: number }> {
  const at = ctx.now()
  const work: Promise<unknown>[] = []
  let flushed = 0
  let stalled = 0
  for (const [convId, s] of ctx.states) {
    if (s.activeSince !== null) {
      const ms = closeSlice(s, at)
      if (ms > 0) {
        flushed++
        work.push(ctx.exclusive(convId, () => ctx.jobs.addTime(convId, ms)))
      }
    }
    if (!mayHaveStalled(s, at, ctx.notBefore, ctx.stallMs)) continue
    work.push(
      ctx.exclusive(convId, async () => {
        // A última atividade é relida na vez do job: algo pode ter chegado na fila.
        const marked = await ctx.jobs.markStalled(convId, ctx.notBefore)
        stalled += marked.length
        for (const envio of marked) ctx.reconciler.schedule(envio.projectId)
      })
    )
  }
  await Promise.allSettled(work)
  return { flushed, stalled }
}
