/**
 * O progresso das etapas de um plano: a ÚNICA regra de contar e numerar as
 * etapas (a placa da obra, o cabeçalho do Planejamento, a TV do Escritório e a
 * aba Implantação dela, e o topo do chat da implementação leem daqui). A numeração é a POSIÇÃO NO PLANO — "Etapa N de M" é igual em toda tela.
 * Serve para quem tem o roteiro (a ordem dele) e para quem só tem os envios (a
 * ordem dos lotes registrados). PURO, sem React.
 *
 *   planEnviosOf(envios, cwd, slug)  os envios do plano;
 *   planEnvioAtual(envios)           o envio de agora do plano;
 *   planProgress(envios, roteiro?)   as etapas com o estado de implementação, as
 *                                    contas e a etapa de agora;
 *   stepLabel(progress, envio?)      o rótulo das telas (do plano, ou de um envio);
 *   ENTREGA_STATUS_LABEL             o rótulo do status de uma entrega;
 *   roteiroProgress(etapas)          a ESPECIFICAÇÃO (o status do roteiro do
 *                                    planejamento): "concluida" ali é etapa
 *                                    especificada, não pronta — nunca entra em
 *                                    planProgress;
 *   taskCounts(items, statusOf?)     a contagem dos cartões/tarefas (Quadro,
 *                                    placar do Escritório, mapa, celular).
 */
import {
  currentEntrega,
  currentEnvio,
  parseMs,
  type HandoffEntrega,
  type HandoffEntregaStatus,
  type HandoffEnvio,
  type HandoffEnvioStatus
} from './handoffTracking'
import { normalizePath } from './pathGuard'

/** O estado de implementação da etapa: na planta (nunca enviada), na fila, na massa (em andamento), pronta ou trincada (incompleta). */
export type StepState = 'planta' | 'fila' | 'massa' | 'pronto' | 'trinca'

/** O roteiro do plano: as etapas com o id, na ordem (o planning:peek o traz). */
export type PlanRoteiro = ReadonlyArray<{ id: string; titulo: string }>

export interface PlanStep {
  id: string
  titulo: string
  /** A posição no plano, 1-based. */
  n: number
  state: StepState
  /** A entrega mais recente da etapa; null = nunca enviada. */
  entrega: HandoffEntrega | null
}

export interface PlanProgress {
  steps: PlanStep[]
  total: number
  prontas: number
  incompletas: number
  /** O envio de agora (planEnvioAtual); null sem envios. */
  envioAtual: HandoffEnvio | null
  /** A etapa de currentEntrega(envioAtual); null sem ela. */
  atual: PlanStep | null
}

/** Os envios deste plano: o mesmo slug no mesmo projeto (caminho comparado sem caixa/barras no Windows). */
export function planEnviosOf(envios: readonly HandoffEnvio[], projectCwd: string, slug: string): HandoffEnvio[] {
  const cwd = normalizePath(projectCwd)
  return envios.filter((e) => e.planSlug === slug && normalizePath(e.projectCwd) === cwd)
}

/** Do mais vivo/grave ao mais quieto: o primeiro status presente no lote é o envio de agora. */
const ENVIO_PRIORITY: readonly HandoffEnvioStatus[] = ['aguardando_voce', 'em_execucao', 'parada', 'falhou', 'incompleta', 'enviado', 'na_fila']

/**
 * O envio de agora do plano: o lote mais novo (por criadoEm; cada envio do plano
 * é um lote) e, dentro dele, o de status mais vivo/grave; lote todo concluído,
 * o último que saiu (currentEnvio), senão o mais novo.
 */
export function planEnvioAtual(envios: readonly HandoffEnvio[]): HandoffEnvio | null {
  let newest: HandoffEnvio | null = null
  for (const e of envios) if (!newest || (parseMs(e.criadoEm) ?? 0) > (parseMs(newest.criadoEm) ?? 0)) newest = e
  if (!newest) return null
  const loteId = newest.loteId
  const lote = envios.filter((e) => e.loteId === loteId)
  for (const status of ENVIO_PRIORITY) {
    const hit = lote.find((e) => e.status === status)
    if (hit) return hit
  }
  return currentEnvio(lote) ?? newest
}

const STATE_BY_ENTREGA: Record<HandoffEntrega['status'], StepState> = {
  pendente: 'fila',
  em_andamento: 'massa',
  concluida: 'pronto',
  incompleta: 'trinca'
}

/**
 * As etapas do plano, na ordem do roteiro quando informado (as enviadas fora
 * dele entram no fim); sem roteiro, na ordem dos lotes (envio.criadoEm — o
 * registro do lote, não a saída: o prompt 2 ainda na fila não passa à frente do
 * prompt 1 já enviado —, envio.ordem, entrega.ordem). A entrega mais recente de
 * cada etapa decide o estado (um plano reenviado refaz a etapa); etapa nunca
 * enviada fica na planta. `envios` são os do plano (planEnviosOf).
 */
export function planProgress(envios: readonly HandoffEnvio[], roteiro?: PlanRoteiro | null): PlanProgress {
  // Map: a posição é a da 1ª vez que a etapa apareceu; o valor, a entrega mais recente.
  const last = new Map<string, HandoffEntrega>()
  const at = (e: HandoffEnvio): number => parseMs(e.criadoEm) ?? 0
  const sorted = [...envios].sort((a, b) => at(a) - at(b) || a.ordem - b.ordem)
  for (const envio of sorted) {
    for (const entrega of [...envio.entregas].sort((a, b) => a.ordem - b.ordem)) last.set(entrega.etapaId, entrega)
  }
  const steps: PlanStep[] = []
  const push = (id: string, titulo: string, entrega: HandoffEntrega | null): void => {
    steps.push({ id, titulo, n: steps.length + 1, state: entrega ? STATE_BY_ENTREGA[entrega.status] : 'planta', entrega })
  }
  for (const e of roteiro ?? []) {
    push(e.id, e.titulo, last.get(e.id) ?? null)
    last.delete(e.id)
  }
  for (const entrega of last.values()) push(entrega.etapaId, entrega.etapaTitulo, entrega)
  const envioAtual = planEnvioAtual(envios)
  const atualId = currentEntrega(envioAtual)?.etapaId
  return {
    steps,
    total: steps.length,
    prontas: steps.filter((s) => s.state === 'pronto').length,
    incompletas: steps.filter((s) => s.state === 'trinca').length,
    envioAtual,
    atual: (atualId !== undefined && steps.find((s) => s.id === atualId)) || null
  }
}

/**
 * O rótulo das telas: "Etapa N de M: título", N = a posição no PLANO.
 *
 *   do plano   a etapa de agora (sem ela — nada enviado, fase entregue —, a
 *              primeira que não está pronta); "Etapas concluídas" com todas
 *              prontas; "Sem etapas" sem nenhuma.
 *   de envio   (a linha da Implantação, o topo do chat da conversa dele) a etapa
 *              de agora DELE (currentEntrega); com as dele todas concluídas,
 *              "Etapas concluídas"; sem entregas, "Sem etapas". `progress` tem
 *              de incluir o envio (senão vale a regra do plano).
 */
export function stepLabel(progress: PlanProgress, envio?: HandoffEnvio | null): string {
  const label = (step: PlanStep): string => `Etapa ${step.n} de ${progress.total}: ${step.titulo}`
  if (envio) {
    const id = currentEntrega(envio)?.etapaId
    if (id === undefined) return envio.entregas.length > 0 ? 'Etapas concluídas' : 'Sem etapas'
    const step = progress.steps.find((s) => s.id === id)
    if (step) return label(step)
  }
  if (progress.total === 0) return 'Sem etapas'
  const step = progress.atual ?? progress.steps.find((s) => s.state !== 'pronto')
  return step ? label(step) : 'Etapas concluídas'
}

/** O status de uma entrega como as telas o escrevem. */
export const ENTREGA_STATUS_LABEL: Readonly<Record<HandoffEntregaStatus, string>> = {
  pendente: 'pendente',
  em_andamento: 'em andamento',
  concluida: 'concluída',
  incompleta: 'incompleta'
}

/** A especificação do roteiro do planejamento: quantas etapas estão especificadas (status "concluida" lá). */
export function roteiroProgress(etapas: ReadonlyArray<{ status: string }>): { feitas: number; total: number } {
  return { feitas: etapas.filter((e) => e.status === 'concluida').length, total: etapas.length }
}

/** As colunas de cartões/tarefas: a fazer, em andamento, concluídas e o total. */
export interface TaskCounts {
  pending: number
  inProgress: number
  done: number
  total: number
}

/**
 * A contagem ÚNICA dos cartões/tarefas (o contador do Quadro e da aba, o placar
 * do Escritório, as etapas do mapa, o plano do agente no celular): `completed`
 * conta como concluída, `in_progress` como em andamento e qualquer outro status
 * como a fazer. `statusOf` dá o status efetivo (no Quadro, o do PO por cima do
 * da fonte: boardItemStatus); padrão, `item.status`.
 */
export function taskCounts(items: ReadonlyArray<{ status: string }>): TaskCounts
export function taskCounts<T>(items: readonly T[], statusOf: (item: T) => string): TaskCounts
export function taskCounts<T>(items: readonly T[], statusOf: (item: T) => string = (item) => (item as { status: string }).status): TaskCounts {
  const out: TaskCounts = { pending: 0, inProgress: 0, done: 0, total: items.length }
  for (const item of items) {
    const status = statusOf(item)
    if (status === 'completed') out.done++
    else if (status === 'in_progress') out.inProgress++
    else out.pending++
  }
  return out
}
