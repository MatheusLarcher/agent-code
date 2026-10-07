import {
  currentEnvio,
  isEnvioRemoved,
  isEnvioSent,
  type HandoffEnvio,
  type HandoffQueueDecision,
  type HandoffQueuedPrompt
} from '../../shared/handoffTracking'
import type { HandoffProjectPlanState } from '../../shared/handoffProject'
import { decideQueue, holdReason, queuedEnvios } from './handoffQueue'

/**
 * As REGRAS da fila do projeto, puras (sem banco, git nem relógio): um plano
 * por vez em cada pasta, sem intercalar; dentro do plano, a regra da fila do
 * quadro (handoffQueue.ts). O serviço (projectQueueService.ts) lê o banco, roda
 * o git e guarda o estado; aqui só se decide.
 *
 * A ordem dos planos é a da fila guardada neste PC: o 1º que não terminou tem a
 * vez. "Passar a vez", "Começar mesmo assim" e as decisões do PO só mudam a
 * ordem — a regra continua uma só.
 */

/** Um plano na fila de uma pasta, como fica guardado neste PC. */
export interface StoredPlan {
  loteId: string
  conversationId: string
  planTitulo: string
  addedAt: string
  /** "Começar mesmo assim" (o usuário) ou COMECAR (o PO): começa com a pasta suja. */
  startAnyway?: { by: 'usuario' | 'po'; at: string }
  /** O PO começou este plano com a pasta suja: a lista do anterior vai no 1º prompt. */
  dirtyFromPrevious?: { planTitulo: string; files: string[] }
}

/** Um plano com os envios dele lidos agora. */
export interface PlanView {
  plan: StoredPlan
  envios: HandoffEnvio[]
  state: HandoffProjectPlanState | 'terminado'
  started: boolean
}

/** Um plano está parado há este tempo e outro espera: entra o PO. */
export const PROJECT_STOP_WAIT_MS = 30 * 60_000
/** Depois de um ESPERAR, no máximo uma avaliação a cada… */
export const PROJECT_REEVALUATE_MS = 30 * 60_000
/** Teto da lista de arquivos do anterior no 1º prompt (o resto vira "+N"). */
export const DIRTY_LIST_MAX = 200

export function planState(envios: readonly HandoffEnvio[]): PlanView['state'] {
  // Tirado da fila conta como fora do plano: o que sobrou concluído termina o plano.
  if (envios.length === 0 || envios.every((e) => e.status === 'concluida' || isEnvioRemoved(e))) return 'terminado'
  if (!envios.some(isEnvioSent)) return 'na_fila'
  const current = currentEnvio(envios)
  if (current && (current.status === 'enviado' || current.status === 'em_execucao')) return 'rodando'
  return decideQueue(envios).kind === 'next' ? 'entre_prompts' : 'parado'
}

/** Os planos da pasta, na ordem, sem os terminados (eles saem da fila). */
export function viewFolder(plans: readonly StoredPlan[], enviosOf: (loteId: string) => HandoffEnvio[]): PlanView[] {
  return plans
    .map((plan): PlanView => {
      const envios = enviosOf(plan.loteId)
      return { plan, envios, state: planState(envios), started: envios.some(isEnvioSent) }
    })
    .filter((view) => view.state !== 'terminado')
}

/** O 1º prompt que espera no plano. */
function nextEnvio(view: PlanView): HandoffEnvio | undefined {
  return queuedEnvios(view.envios)[0]
}

export function queuedPrompt(envio: HandoffEnvio, conteudo = envio.conteudo): HandoffQueuedPrompt {
  return { id: envio.id, conversationId: envio.conversationId, loteId: envio.loteId, ordem: envio.ordem, arquivo: envio.arquivo, conteudo }
}

const ordinal = (n: number): string => `${n}º`

/** O motivo de quem espera a vez de outro plano. */
export function waitingReason(position: number, holder: PlanView): string {
  return `na fila do projeto (${ordinal(position)}): esperando o plano "${holder.plan.planTitulo}" terminar`
}

export function dirtyReason(count: number): string {
  return count === 1 ? '1 arquivo sem commit nesta pasta' : `${count} arquivos sem commit nesta pasta`
}

/**
 * O passo da fila do projeto para um plano. `start`: é a vez dele, ninguém roda
 * e nenhum prompt saiu ainda — o serviço confere a pasta (git status) e chama
 * `startDecision`. O resto já sai decidido.
 */
export type ProjectStep =
  | { kind: 'decided'; decision: HandoffQueueDecision }
  | { kind: 'start'; view: PlanView; first: HandoffEnvio }

export function projectStep(views: readonly PlanView[], loteId: string, opts: { force?: boolean } = {}): ProjectStep {
  const index = views.findIndex((view) => view.plan.loteId === loteId)
  if (index < 0) return { kind: 'decided', decision: { kind: 'none' } }
  const view = views[index]
  const next = nextEnvio(view)
  if (!next) return { kind: 'decided', decision: { kind: 'none' } }
  const hold = (motivo: string): ProjectStep => ({ kind: 'decided', decision: { kind: 'hold', envio: queuedPrompt(next), motivo } })
  // Planos não se intercalam: só o 1º da fila anda.
  if (index > 0) return hold(waitingReason(index + 1, views[0]))
  // A vez é dele, mas outro plano ainda roda um prompt (o A que recuperou a vez espera o prompt atual do B).
  const other = views.find((v, i) => i !== index && v.state === 'rodando')
  if (other) return hold(`esperando o prompt atual do plano "${other.plan.planTitulo}" terminar`)
  if (!view.started) return { kind: 'start', view, first: next }
  return { kind: 'decided', decision: decideQueue(view.envios, opts) }
}

/** O aviso que o código monta no 1º prompt do B quando o PO o começou com a pasta suja. */
export function dirtyPreamble(previous: { planTitulo: string; files: string[] }): string {
  const shown = previous.files.slice(0, DIRTY_LIST_MAX)
  const extra = previous.files.length - shown.length
  return [
    `ANTES DE COMEÇAR — o plano anterior ("${previous.planTitulo}") deixou ${previous.files.length === 1 ? '1 arquivo' : `${previous.files.length} arquivos`} sem commit nesta pasta.`,
    'Eles são do outro plano: NÃO edite nem commite estes arquivos.',
    ...shown.map((file) => `- ${file}`),
    ...(extra > 0 ? [`- (+${extra} arquivos)`] : []),
    '',
    '---',
    ''
  ].join('\n')
}

/** O começo do plano, com a pasta conferida: suja e sem "Começar mesmo assim" segura. */
export function startDecision(view: PlanView, first: HandoffEnvio, dirty: readonly string[] | null): HandoffQueueDecision {
  if (dirty && dirty.length > 0 && !view.plan.startAnyway) {
    return { kind: 'hold', envio: queuedPrompt(first), motivo: dirtyReason(dirty.length) }
  }
  const previous = view.plan.dirtyFromPrevious
  const conteudo = previous && previous.files.length > 0 ? `${dirtyPreamble(previous)}${first.conteudo}` : first.conteudo
  return { kind: 'next', envio: queuedPrompt(first, conteudo) }
}

/** Move `loteId` para a posição `to` (0 = a vez), mantendo a ordem dos outros. */
export function moveTo<T extends { loteId: string }>(plans: readonly T[], loteId: string, to: number): T[] {
  const item = plans.find((p) => p.loteId === loteId)
  if (!item) return [...plans]
  const rest = plans.filter((p) => p.loteId !== loteId)
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, item)
  return rest
}

/** "Passar a vez": o plano vai para logo depois do próximo que não terminou. */
export function passTurn(plans: readonly StoredPlan[], views: readonly PlanView[], loteId: string): StoredPlan[] {
  const live = views.map((v) => v.plan.loteId)
  const at = live.indexOf(loteId)
  const after = live[at + 1]
  if (at < 0 || !after) return [...plans]
  const without = plans.filter((p) => p.loteId !== loteId)
  const target = without.findIndex((p) => p.loteId === after)
  return moveTo(plans, loteId, target + 1)
}

const STOP_TEXT: Partial<Record<HandoffEnvio['status'], string>> = {
  aguardando_voce: 'está esperando uma resposta do usuário',
  parada: 'parou',
  falhou: 'terminou com erro',
  incompleta: 'não foi concluído',
  concluida: 'concluiu, mas o plano não seguiu'
}

/** O motivo da parada do plano com a vez (o que o PO lê): o prompt, o estado e o que o acompanhamento gravou. */
export function stopReason(view: PlanView): string {
  const current = currentEnvio(view.envios)
  if (!current) return 'o plano não começou'
  const text = STOP_TEXT[current.status]
  if (!text) return holdReason(current)
  const detail = current.motivo?.trim()
  return `o prompt ${current.ordem} de ${view.envios.length} (${current.arquivo}) ${text}${detail ? `: ${detail}` : ''}`
}

/** A identidade da parada: mudou (o A andou), o relógio dos 30 min recomeça. */
export function stopKey(view: PlanView): string | null {
  if (view.state !== 'parado') return null
  const current = currentEnvio(view.envios)
  return current ? `${view.plan.loteId}:${current.id}:${current.status}` : null
}

export interface TurnEvaluationMemo {
  loteA: string
  loteB: string
  decisao: string
  at: number
  signature: string
}

/**
 * A avaliação dos 30 min pode rodar? (o `signature` — HEAD, git status e o
 * estado do A — o serviço só calcula quando o resto já disse sim).
 * - o plano com a vez está PARADO e outro espera atrás dele;
 * - parado há 30 min;
 * - depois de um ESPERAR do mesmo par: só com algo mudado e 30 min depois do último.
 */
export function turnEvaluationDue(input: {
  views: readonly PlanView[]
  stoppedSince: number | null
  now: number
  last: TurnEvaluationMemo | null
  signature?: string
}): boolean {
  const [holder, next] = input.views
  if (!holder || !next || holder.state !== 'parado' || input.stoppedSince === null) return false
  if (input.now - input.stoppedSince < PROJECT_STOP_WAIT_MS) return false
  const last = input.last
  if (!last || last.loteA !== holder.plan.loteId || last.loteB !== next.plan.loteId) return true
  if (input.now - last.at < PROJECT_REEVALUATE_MS) return false
  return input.signature === undefined || input.signature !== last.signature
}

/** Minutos que faltam pela estimativa do plano: a soma dos envios não concluídos. */
export function remainingMinutes(envios: readonly HandoffEnvio[]): number | null {
  const open = envios.filter((e) => e.status !== 'concluida' && e.estimativaTotal !== null)
  return open.length > 0 ? open.reduce((sum, e) => sum + (e.estimativaTotal ?? 0), 0) : null
}
