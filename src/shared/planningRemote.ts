/**
 * Contrato da aba Planos do celular com a ponte do PC
 * (src/main/remote/planningBridge.ts). Só leitura do plano, "Novo
 * planejamento" e o "Enviar para implementação" (gerar, enviar e descartar os
 * antigos); editar card, marcar etapa e editar o texto do prompt ficam no PC —
 * no celular quem mexe nos cards é o Agent Manager, pela conversa.
 *
 * Rotas (todas com `?token=` e `&dev=` como o resto de /api/):
 *  - GET  /api/planning/list?cwd=           → RemotePlanListResponse
 *  - GET  /api/planning/plan?cwd=&slug=     → RemotePlanResponse
 *  - GET  /api/planning/media?cwd=&slug=&name= → bytes da imagem (Content-Type dela)
 *  - POST /api/planning/create {cwd, pedido} → RemotePlanCreateResponse
 *  - POST /api/planning/handoff RemoteHandoffSendRequest → RemotePlanOkResponse
 *  - POST /api/planning/handoff-generate RemoteHandoffGenerateRequest → RemotePlanOkResponse
 *  - POST /api/planning/handoff-discard {cwd, slug} → RemoteHandoffDiscardResponse
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

/** De onde vem o "N/M" das etapas: a implementação (prontas, dos envios) ou a
 *  especificação (especificadas, do roteiro do planejamento). */
export type RemotePlanEtapasFonte = 'implementacao' | 'especificacao'

/** Um plano na lista de um projeto. */
export interface RemotePlanSummary {
  slug: string
  titulo: string
  /** `fonte` ausente = PC antigo, que só contava a especificação. */
  etapas: { total: number; concluidas: number; fonte?: RemotePlanEtapasFonte }
  cards: number
  ambiguidadesAbertas: number
  /** Última modificação do plano (roteiro e cards), em ms — a ordem da lista.
   *  Ausente = PC antigo (o celular cai no updatedAt do Manager ou na data do slug). */
  atualizadoEm?: number
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

/** Um prompt de _handoff/ ainda a enviar (fora de enviados.json). */
export interface RemotePlanHandoff {
  /** Arquivo (AAAA-MM-DD-NN.md): a ordem de envio. */
  name: string
  createdAt: number
  content: string
  /** Etapas do roteiro que o prompt cobre (ausente = prompt antigo, sem etapas declaradas). */
  etapas?: string[]
  /** Gravado antes da última mudança do plano: não entra no envio sem o usuário decidir. */
  antigo?: boolean
}

/** Um prompt já enviado a uma conversa de implementação. */
export interface RemotePlanHandoffSent {
  nome: string
  enviadoEm: string
  conversaId: string
  conversaTitulo?: string
}

export interface RemotePlanHandoffs {
  pendentes: RemotePlanHandoff[]
  enviados: RemotePlanHandoffSent[]
  /** _handoff/ não pôde ser lido: o envio fica só no PC. */
  erro?: string
}

/** Plano aberto: roteiro + cards (sem layout do canvas nem pastas do PC). */
export interface RemotePlan {
  slug: string
  roteiro: PlanningRoteiroDto
  cards: PlanningCardDto[]
  /** Cards que não carregaram (arquivo relativo à pasta + motivo). */
  invalid: { file: string; error: string }[]
  media: RemotePlanMedia[]
  /** Os prompts de _handoff/. Ausente = PC antigo, sem o envio pelo celular. */
  handoffs?: RemotePlanHandoffs
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

/**
 * "Enviar" da folha: os prompts pendentes, pelo nome e na ordem de envio. O PC
 * roda o MESMO envio da Tela de Planejamento (conversa de implementação nova
 * com o modelo/esforço do Manager, fila do quadro, registro em enviados.json).
 * `override`: o usuário marcou "enviar mesmo assim" com ambiguidade aberta.
 */
export interface RemoteHandoffSendRequest {
  cwd: string
  slug: string
  names: string[]
  override?: boolean
}

/** "Gerar prompts": o PC manda ao Agent Manager o mesmo pedido do botão do PC. */
export interface RemoteHandoffGenerateRequest {
  cwd: string
  slug: string
  override?: boolean
}

/** Teto de prompts num envio pelo celular. */
export const MAX_REMOTE_HANDOFF_PROMPTS = 50

export type RemotePlanOkResponse = { ok: true } | RemotePlanningFailure
export type RemoteHandoffDiscardResponse = { ok: true; discarded: string[] } | RemotePlanningFailure
