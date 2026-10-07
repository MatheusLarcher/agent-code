/**
 * Rotas da aba Planos na ponte do PC (contrato em @shared/planningRemote): lista,
 * plano aberto, URL da imagem anexa e "Novo planejamento". Só leitura do plano —
 * no celular quem mexe nos cards é o Agent Manager, pela conversa.
 *
 * Erros viram `PlanningError`: `old-pc` (PC sem as rotas: 404 "rota desconhecida"),
 * `failure` (a ponte recusou: invalid/unknown_project/not_found/io) ou `net`.
 */
import { PLANNING_BRIDGE_CONV, type PlanningChangedEvent, type RemotePlanningErrorCode } from '@shared/planningRemote'
import type { RemoteClient } from './client'
import { errorText, HttpError, statusOf } from './net'
import type { BridgeEvent, RemotePlan, RemotePlanCreateResponse, RemotePlanListResponse, RemotePlanResponse, RemotePlanSummary } from './types'

export type PlanningErrorKind = 'old-pc' | 'failure' | 'net'

export class PlanningError extends Error {
  constructor(
    readonly kind: PlanningErrorKind,
    message: string,
    readonly code?: RemotePlanningErrorCode,
    readonly status = 0
  ) {
    super(message)
    this.name = 'PlanningError'
  }
}

export const OLD_PC_TEXT = 'Atualize o app do PC para ver os planos no celular.'

const CODES: RemotePlanningErrorCode[] = ['invalid', 'unknown_project', 'not_found', 'io']

function isFailureBody(b: unknown): b is { ok: false; code: RemotePlanningErrorCode; message?: string } {
  return !!b && typeof b === 'object' && (b as { ok?: unknown }).ok === false && CODES.includes((b as { code: RemotePlanningErrorCode }).code)
}

/** HttpError da ponte → PlanningError (o que a tela sabe mostrar). */
export function toPlanningError(err: unknown): PlanningError {
  if (err instanceof PlanningError) return err
  const status = statusOf(err)
  const body = err instanceof HttpError ? err.body : null
  if (isFailureBody(body)) return new PlanningError('failure', body.message || body.code, body.code, status)
  if (status === 404) return new PlanningError('old-pc', OLD_PC_TEXT, undefined, status)
  return new PlanningError('net', errorText(err), undefined, status)
}

/** Resposta 200 que diz `ok:false` (não deveria acontecer, mas a borda confere). */
function unwrap<T extends { ok: true }>(r: T | { ok: false; code: RemotePlanningErrorCode; message: string } | null | undefined): T {
  if (r && r.ok === true) return r
  if (isFailureBody(r)) throw new PlanningError('failure', r.message || r.code, r.code)
  throw new PlanningError('net', 'Resposta inesperada do PC.')
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toPlanningError(err)
  }
}

export async function listPlans(c: RemoteClient, cwd: string): Promise<RemotePlanSummary[]> {
  const r = await call(() => c.request<RemotePlanListResponse>(`/api/planning/list?cwd=${encodeURIComponent(cwd)}`))
  const plans = unwrap(r).plans
  return Array.isArray(plans) ? plans : []
}

export async function getPlan(c: RemoteClient, cwd: string, slug: string): Promise<RemotePlan> {
  const r = await call(() => c.request<RemotePlanResponse>(`/api/planning/plan?cwd=${encodeURIComponent(cwd)}&slug=${encodeURIComponent(slug)}`))
  const plan = unwrap(r).plan
  return { ...plan, cards: plan.cards ?? [], invalid: plan.invalid ?? [], media: plan.media ?? [], roteiro: { ...plan.roteiro, etapas: plan.roteiro?.etapas ?? [] } }
}

/** URL da imagem anexa (a ponte só serve imagens; com token, como o /api/file). */
export function planMediaUrl(c: RemoteClient, cwd: string, slug: string, name: string): string {
  return c.url(`/api/planning/media?cwd=${encodeURIComponent(cwd)}&slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}`)
}

/** "+ Novo planejamento": o PC cria a conversa do Agent Manager e devolve o id dela. */
export async function createPlan(c: RemoteClient, cwd: string, pedido: string): Promise<string> {
  const body = pedido.trim() ? { cwd, pedido: pedido.trim() } : { cwd }
  const r = await call(() => c.post<RemotePlanCreateResponse>('/api/planning/create', body))
  return unwrap(r).convId
}

/** O aviso `planning-changed` do SSE (envelope com convId 'planning'), validado. */
export function planningChange(msg: BridgeEvent): PlanningChangedEvent | null {
  if (msg?.convId !== PLANNING_BRIDGE_CONV) return null
  const e = msg.event as Partial<PlanningChangedEvent> | undefined
  if (!e || e.kind !== 'planning-changed' || typeof e.projectCwd !== 'string' || typeof e.slug !== 'string') return null
  return { kind: 'planning-changed', projectCwd: e.projectCwd, slug: e.slug }
}
