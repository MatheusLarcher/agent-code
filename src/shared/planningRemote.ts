/**
 * Contrato da aba Planos do celular com a ponte do PC
 * (src/main/remote/planningBridge.ts). Só leitura do plano + "Novo
 * planejamento"; editar card, marcar etapa e handoff ficam no PC — no celular
 * quem mexe nos cards é o Agent Manager, pela conversa.
 *
 * Rotas (todas com `?token=` e `&dev=` como o resto de /api/):
 *  - GET  /api/planning/list?cwd=           → RemotePlanListResponse
 *  - GET  /api/planning/plan?cwd=&slug=     → RemotePlanResponse
 *  - GET  /api/planning/media?cwd=&slug=&name= → bytes da imagem (Content-Type dela)
 *  - POST /api/planning/create {cwd, pedido} → RemotePlanCreateResponse
 * PC antigo sem as rotas: 404 `{ error: 'rota desconhecida' }`.
 *
 * Aviso de mudança: no SSE /api/events, envelope
 * `{ convId: PLANNING_BRIDGE_CONV, event: PlanningChangedEvent }`.
 */
import type { PlanningCardDto, PlanningRoteiroDto } from './ipc'
import type { MediaKind } from './planningMedia'

/** A "conversa" dos avisos de planejamento no SSE (como OFFICE_BRIDGE_CONV). */
export const PLANNING_BRIDGE_CONV = 'planning'

/** Teto do pedido inicial de um planejamento criado pelo celular. */
export const MAX_REMOTE_PLAN_PEDIDO = 20_000

/** Ponte → celular: um plano mudou (o celular relê só o plano aberto). */
export interface PlanningChangedEvent {
  kind: 'planning-changed'
  projectCwd: string
  slug: string
}

/** Um plano na lista de um projeto. */
export interface RemotePlanSummary {
  slug: string
  titulo: string
  etapas: { total: number; concluidas: number }
  cards: number
  ambiguidadesAbertas: number
  /** O plano não abriu (arquivo quebrado): o resto vem zerado e `titulo` = slug. */
  erro?: string
}

/** Mídia do plano, sem o caminho no disco do PC. Imagem: GET /api/planning/media. */
export interface RemotePlanMedia {
  name: string
  kind: MediaKind
  size: number
  mediaType: string
}

/** Plano aberto: roteiro + cards (sem layout do canvas nem pastas do PC). */
export interface RemotePlan {
  slug: string
  roteiro: PlanningRoteiroDto
  cards: PlanningCardDto[]
  /** Cards que não carregaram (arquivo relativo à pasta + motivo). */
  invalid: { file: string; error: string }[]
  media: RemotePlanMedia[]
}

/**
 * HTTP: invalid → 400, unknown_project → 403 (projeto que o PC não conhece),
 * not_found → 404 (plano/mídia/pasta do projeto inexistente), io → 500.
 */
export type RemotePlanningErrorCode = 'invalid' | 'unknown_project' | 'not_found' | 'io'

export interface RemotePlanningFailure {
  ok: false
  code: RemotePlanningErrorCode
  message: string
}

export type RemotePlanListResponse = { ok: true; plans: RemotePlanSummary[] } | RemotePlanningFailure
export type RemotePlanResponse = { ok: true; plan: RemotePlan } | RemotePlanningFailure

/** Corpo do POST /api/planning/create. `pedido` vazio: o plano nasce sem a 1ª mensagem. */
export interface RemotePlanCreateRequest {
  cwd: string
  pedido?: string
}

/** `convId` da conversa do Agent Manager que o PC vai criar; o slug aparece
 *  depois em /api/state (`mode: 'planning'`, `planningSlug`). */
export type RemotePlanCreateResponse = { ok: true; convId: string } | RemotePlanningFailure
