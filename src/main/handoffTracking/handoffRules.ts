import {
  CARD_ETAPA_PREFIX,
  currentEntrega,
  currentEnvio,
  isEnvioSent,
  parseMs,
  type HandoffEntrega,
  type HandoffEnvio,
  type HandoffEnvioStatus
} from '../../shared/handoffTracking'
import { boardItemStatus, type BoardItem } from '../../shared/ipc'
import type { HandoffEntregaPatch, HandoffEnvioPatch, HandoffTimeAdd } from '../persistence/types'
import { STALL_ABORT_MS } from '../stallWatch'
import { blockReason, cardForEtapa, poContestReason } from './handoffCardMatch'

/**
 * As regras do acompanhamento dos envios de handoff, puras: nada aqui lê banco,
 * relógio ou quadro — quem chama passa tudo. O tracker (handoffTracker.ts) só
 * observa, lê e grava o que estas funções decidem.
 *
 * O critério de fundo (card req-criterio-concluida): "terminou" não é "fez". O
 * turno também acaba quando o modelo para no meio ou pergunta; quem diz que a
 * etapa foi feita é o cartão dela no Quadro, concluído e não contestado pelo PO.
 */

/** Sem turno nem pergunta por tanto tempo, o envio está parado: o mesmo teto do
 *  travamento definitivo do turno (stallWatch.ts). */
export const HANDOFF_STALL_MS = STALL_ABORT_MS

/** Teto do texto de erro guardado como motivo (o resto é do log). */
export const HANDOFF_ERROR_MOTIVO_MAX = 500
/** Teto do motivo do envio incompleto (a lista do que faltou). */
export const HANDOFF_ENVIO_MOTIVO_MAX = 2000

/** Começo do motivo do envio cujo turno terminou com erro — a releitura do
 *  Quadro mantém o erro e troca só a lista do que falta. */
export const TURN_ERROR_PREFIX = 'o turno terminou com erro'

export const CORRECTED_BY_USER = 'corrigido por você'

/** Status de envio que a varredura pode marcar como parada. `aguardando_voce`
 *  só chega à regra sem pergunta aberta em memória (a varredura pula a conversa
 *  que tem uma): o app fechou com a pergunta aberta e ninguém mais a responde. */
const STALLABLE: ReadonlySet<HandoffEnvioStatus> = new Set(['na_fila', 'enviado', 'em_execucao', 'aguardando_voce'])

export function isStallable(status: HandoffEnvioStatus): boolean {
  return STALLABLE.has(status)
}

/** Ainda em curso — o que a varredura carrega no início do processo. */
export const HANDOFF_OPEN_STATUSES: readonly HandoffEnvioStatus[] = ['na_fila', 'enviado', 'em_execucao', 'aguardando_voce']

export function truncate(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Tempo corrido da entrega: do início ao fim no Quadro; sem início visto, 0. */
export function tempoCorrido(iniciadaEm: string | null, concluidaEm: string): number {
  const start = parseMs(iniciadaEm)
  const end = parseMs(concluidaEm)
  return start === null || end === null ? 0 : Math.max(0, Math.round(end - start))
}

// ---------------------------------------------------------------------------
// Envio corrente e casamento pelo hash
// ---------------------------------------------------------------------------

// `isEnvioSent` e `currentEnvio` moram em shared/handoffTracking.ts: a tela (o
// indicador de prazo) lê o envio corrente pela MESMA regra.
export { currentEnvio, isEnvioSent }

/** O envio que um texto mandado à conversa entrega: mesmo hash, ainda não
 *  enviado; vários (o mesmo prompt relançado) → o do lote mais novo, menor ordem. */
export function envioForHash(envios: readonly HandoffEnvio[], hash: string): HandoffEnvio | null {
  const candidates = envios.filter((e) => e.conteudoHash === hash && !isEnvioSent(e))
  candidates.sort((a, b) => (parseMs(b.criadoEm) ?? 0) - (parseMs(a.criadoEm) ?? 0) || a.ordem - b.ordem)
  return candidates[0] ?? null
}

// ---------------------------------------------------------------------------
// Cartão ↔ entrega
// ---------------------------------------------------------------------------

// O casamento cartão ↔ etapa mora em handoffCardMatch.ts; reexportado aqui.
export { blockReason, CARD_EPOCH_SLACK_MS, cardForEtapa, etapaIdFromTitle, poContestReason, type CardPreference } from './handoffCardMatch'

/** O "Mandar fazer" do "Fala, PO" liga a entrega direto ao cartão citado: `card:<id>`. */
export { CARD_ETAPA_PREFIX }

export interface EntregaSyncContext {
  /** Agora, em ISO. */
  now: string
  /** PO ligado (`board.po.enabled`): vira `auditada` na conclusão. */
  poEnabled: boolean
}

const CLEAR_CONCLUSION: HandoffEntregaPatch = { concluidaEm: null, auditada: null, tempoCorridoMs: null }

/** Só o que difere do atual; `null` = nada a gravar. */
function diff(entrega: HandoffEntrega, target: HandoffEntregaPatch): HandoffEntregaPatch | null {
  const out: HandoffEntregaPatch = {}
  for (const [key, value] of Object.entries(target) as [keyof HandoffEntregaPatch, unknown][]) {
    if (value !== undefined && entrega[key] !== value) (out as Record<string, unknown>)[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * A entrega acompanhando o cartão da etapa. Entrega corrigida pelo usuário não
 * muda (a correção é dele); sem cartão, nada muda. A entrega já `incompleta`
 * (o turno acabou sem ela) continua incompleta enquanto o cartão não anda —
 * só o motivo é relido.
 */
export function entregaCardPatch(
  entrega: HandoffEntrega,
  card: BoardItem | null,
  ctx: EntregaSyncContext
): HandoffEntregaPatch | null {
  if (entrega.corrigidoPor === 'usuario' || !card) return null
  const contested = poContestReason(card) !== null
  const status = boardItemStatus(card)
  const target: HandoffEntregaPatch = { boardItemId: card.id }
  if (status === 'completed' && !contested) {
    if (entrega.status !== 'concluida') {
      const concluidaEm = entrega.concluidaEm ?? ctx.now
      Object.assign(target, {
        status: 'concluida',
        motivo: null,
        concluidaEm,
        auditada: ctx.poEnabled,
        tempoCorridoMs: tempoCorrido(entrega.iniciadaEm, concluidaEm)
      })
    }
  } else if (status === 'in_progress' && !contested) {
    Object.assign(target, { status: 'em_andamento', motivo: null, iniciadaEm: entrega.iniciadaEm ?? ctx.now })
    if (entrega.concluidaEm) Object.assign(target, CLEAR_CONCLUSION)
  } else {
    const incompleta = entrega.status === 'incompleta'
    Object.assign(target, {
      status: incompleta ? 'incompleta' : 'pendente',
      motivo: incompleta || contested ? blockReason(card, entrega.etapaId) : null
    })
    if (entrega.concluidaEm) Object.assign(target, CLEAR_CONCLUSION)
  }
  return diff(entrega, target)
}

export interface EntregaPatchFor {
  id: string
  patch: HandoffEntregaPatch
}

/** O cartão de uma entrega do envio: o casamento ÚNICO do app — as regras daqui
 *  e as etapas órfãs do PO (handoffOrphans.ts) chamam só este. A época é o
 *  REGISTRO do lote (`criadoEm`), não a saída do prompt: o agente declara as
 *  etapas do roteiro inteiro já no 1º prompt. */
export function entregaCard(envio: HandoffEnvio, entrega: HandoffEntrega, cards: readonly BoardItem[]): BoardItem | null {
  return cardForEtapa(cards, entrega.etapaId, { conversationId: envio.conversationId, boardItemId: entrega.boardItemId, since: envio.criadoEm })
}

/** As entregas do envio acompanhando os cartões do projeto. */
export function syncEntregas(envio: HandoffEnvio, cards: readonly BoardItem[], ctx: EntregaSyncContext): EntregaPatchFor[] {
  const out: EntregaPatchFor[] = []
  for (const entrega of envio.entregas) {
    const patch = entregaCardPatch(entrega, entregaCard(envio, entrega, cards), ctx)
    if (patch) out.push({ id: entrega.id, patch })
  }
  return out
}

/** As entregas cujo cartão está em andamento — é para elas que vai o retrabalho. */
export function entregasWithCardInProgress(envio: HandoffEnvio, cards: readonly BoardItem[]): string[] {
  return envio.entregas
    .filter((entrega) => {
      const card = entregaCard(envio, entrega, cards)
      return card !== null && boardItemStatus(card) === 'in_progress'
    })
    .map((entrega) => entrega.id)
}

// ---------------------------------------------------------------------------
// Critério concluída / incompleta
// ---------------------------------------------------------------------------

function missingReason(envio: HandoffEnvio, entrega: HandoffEntrega, cards: readonly BoardItem[]): string {
  if (entrega.corrigidoPor === 'usuario') return entrega.motivo ?? CORRECTED_BY_USER
  return blockReason(entregaCard(envio, entrega, cards), entrega.etapaId)
}

/** "faltou 1 de 3 entregas: [id] Título — motivo; …" */
export function describeMissing(envio: HandoffEnvio, cards: readonly BoardItem[]): string {
  const missing = envio.entregas.filter((e) => e.status !== 'concluida')
  if (missing.length === 0) return ''
  const items = missing.map((e) => `[${e.etapaId}] ${e.etapaTitulo} — ${missingReason(envio, e, cards)}`)
  const noun = envio.entregas.length === 1 ? 'entrega' : 'entregas'
  return `faltou ${missing.length} de ${envio.entregas.length} ${noun}: ${items.join('; ')}`
}

export interface TurnEndOutcome {
  envio: HandoffEnvioPatch
  entregas: EntregaPatchFor[]
}

/** O motivo do incompleto: o erro do turno (se houve) na frente e o que falta. */
function incompleteMotivo(error: string | null, missing: string): string {
  return truncate([error, missing].filter(Boolean).join(' — '), HANDOFF_ENVIO_MOTIVO_MAX)
}

const MISSING_START = / — faltou \d+ de \d+ entregas?: /

/** A parte "o turno terminou com erro: …" do motivo gravado, sem a lista do que faltava; `null` sem erro. */
function turnErrorPart(motivo: string | null): string | null {
  if (!motivo?.startsWith(TURN_ERROR_PREFIX)) return null
  const at = MISSING_START.exec(motivo)?.index
  return at === undefined ? motivo : motivo.slice(0, at)
}

/**
 * O fim do turno (`result`) do envio corrente, com as entregas JÁ sincronizadas
 * com os cartões. Todas concluídas → `concluida`, mesmo com erro de turno (o
 * Quadro é a verdade); senão `incompleta`, dizendo o que faltou e por quê — e
 * cada entrega que faltou fica `incompleta` com o próprio motivo (a corrigida
 * pelo usuário, não). Envio sem entregas: só o turno decide.
 */
export function turnEndOutcome(
  envio: HandoffEnvio,
  cards: readonly BoardItem[],
  ctx: { now: string; turnError: string | null }
): TurnEndOutcome {
  const entregas: EntregaPatchFor[] = []
  for (const entrega of envio.entregas) {
    if (entrega.status === 'concluida' || entrega.corrigidoPor === 'usuario') continue
    const patch = diff(entrega, { status: 'incompleta', motivo: missingReason(envio, entrega, cards) })
    if (patch) entregas.push({ id: entrega.id, patch })
  }
  const missing = describeMissing(envio, cards)
  if (!missing && (envio.entregas.length > 0 || !ctx.turnError)) {
    return { envio: { status: 'concluida', concluidoEm: envio.concluidoEm ?? ctx.now, motivo: null }, entregas }
  }
  const error = ctx.turnError ? `${TURN_ERROR_PREFIX}: ${truncate(ctx.turnError, HANDOFF_ERROR_MOTIVO_MAX)}` : null
  return { envio: { status: 'incompleta', motivo: incompleteMotivo(error, missing), concluidoEm: null }, entregas }
}

// ---------------------------------------------------------------------------
// Reconciliação com o Quadro (handoffReconcile.ts)
// ---------------------------------------------------------------------------

/** Os status que o reconciliador relê: o envio que já saiu e não concluiu. */
export const RECONCILE_STATUSES: readonly HandoffEnvioStatus[] = ['enviado', 'em_execucao', 'aguardando_voce', 'parada', 'falhou', 'incompleta']

/** Já saiu e não concluiu. O "tirado da fila" (parada sem `enviadoEm`) nunca saiu. */
export function isReconcilable(envio: HandoffEnvio): boolean {
  return RECONCILE_STATUSES.includes(envio.status) && isEnvioSent(envio)
}

/** O turno já acabou nesses: é o Quadro que diz se o trabalho ficou feito. */
const SETTLED_BY_BOARD: ReadonlySet<HandoffEnvioStatus> = new Set(['incompleta', 'parada', 'falhou'])

/**
 * O envio depois de as entregas acompanharem os cartões (syncEntregas antes).
 * Incompleto, parado ou que falhou com TODAS as entregas (≥ 1) concluídas vira
 * concluído — mesmo com erro de turno: o Quadro é a verdade. Incompleto que
 * ainda falta tem o motivo relido (o erro do turno fica; só a lista troca).
 * Turno rodando na conversa: o status é dele, nada muda aqui.
 */
export function reconcileEnvioPatch(
  envio: HandoffEnvio,
  cards: readonly BoardItem[],
  ctx: { now: string; turnRunning: boolean }
): HandoffEnvioPatch | null {
  if (ctx.turnRunning || !SETTLED_BY_BOARD.has(envio.status) || !isEnvioSent(envio)) return null
  const missing = describeMissing(envio, cards)
  if (!missing) return envio.entregas.length > 0 ? { status: 'concluida', concluidoEm: ctx.now, motivo: null } : null
  if (envio.status !== 'incompleta') return null
  const motivo = incompleteMotivo(turnErrorPart(envio.motivo), missing)
  return motivo === envio.motivo ? null : { motivo }
}

// ---------------------------------------------------------------------------
// Transições do envio pelo que o turno faz
// ---------------------------------------------------------------------------

/** O turno começou: o envio corrente volta a rodar (ou espera você, se há
 *  pergunta aberta). Concluído não reabre — o tempo vira retrabalho. */
export function turnStartPatch(envio: HandoffEnvio, at: string, pending: boolean): HandoffEnvioPatch | null {
  if (envio.status === 'concluida' || !isEnvioSent(envio)) return null
  const patch: HandoffEnvioPatch = {}
  const target: HandoffEnvioStatus = pending ? 'aguardando_voce' : 'em_execucao'
  if (envio.status !== target) patch.status = target
  if (envio.status === 'parada' || envio.status === 'falhou' || envio.status === 'incompleta') patch.motivo = null
  if (!envio.iniciadoEm) patch.iniciadoEm = at
  return Object.keys(patch).length > 0 ? patch : null
}

/** Pergunta/permissão aberta ↔ rodando. */
export function permissionPatch(envio: HandoffEnvio, pending: boolean): HandoffEnvioPatch | null {
  if (pending && envio.status === 'em_execucao') return { status: 'aguardando_voce' }
  if (!pending && envio.status === 'aguardando_voce') return { status: 'em_execucao' }
  return null
}

/** Erro que o próprio app retoma (travamento abortado, fim de stream): não é falha. */
export function isRecoverableError(event: { incomplete?: boolean; retryable?: boolean }): boolean {
  return event.incomplete === true && event.retryable === true
}

/** Erro de verdade: o envio corrente falhou, com o texto do erro. */
/** O motivo do envio que o usuário parou: a fila espera ele (Stop não é erro e não tenta de novo). */
export const STOP_MOTIVO = 'você parou este prompt (Stop) — a fila espera você'

/**
 * O Stop do usuário: o envio corrente que não concluiu fica PARADO até o próximo
 * turno — ou até o Quadro dizer que todas as etapas ficaram prontas (o
 * reconciliador o conclui). O que já concluiu fica concluído — a hora da
 * conclusão é dado de entrega; a fila o segura pela marca do tracker
 * (HandoffTracker.stoppedByUser), não pelo status.
 */
export function stopPatch(envio: HandoffEnvio): HandoffEnvioPatch | null {
  if (!isEnvioSent(envio) || envio.status === 'concluida') return null
  return envio.status === 'parada' && envio.motivo === STOP_MOTIVO ? null : { status: 'parada', motivo: STOP_MOTIVO }
}

export function errorPatch(envio: HandoffEnvio, text: string): HandoffEnvioPatch | null {
  if (envio.status === 'concluida' || !isEnvioSent(envio)) return null
  const motivo = truncate(text, HANDOFF_ERROR_MOTIVO_MAX) || 'o turno terminou com erro'
  return envio.status === 'falhou' && envio.motivo === motivo ? null : { status: 'falhou', motivo }
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/**
 * As entregas que recebem o tempo ATIVO de um envio não concluído: as em
 * andamento; sem nenhuma, a etapa ATUAL (currentEntrega — a mesma que o
 * indicador do topo mostra), para o tempo não sumir entre uma etapa e outra.
 */
export function activeTimeEntregas(envio: HandoffEnvio): HandoffEntrega[] {
  if (envio.status === 'concluida') return []
  const running = envio.entregas.filter((e) => e.status === 'em_andamento')
  if (running.length > 0) return running
  const current = currentEntrega(envio)
  return current ? [current] : []
}

/**
 * Para onde vai uma fatia de tempo ATIVO (turno rodando, sem pergunta aberta).
 * Envio não concluído: tempo ativo do envio e de activeTimeEntregas.
 * Concluído: é retrabalho — do envio (o total) e das entregas cujo cartão voltou
 * a andar.
 */
export function timeDistribution(
  envio: HandoffEnvio,
  ms: number,
  cardInProgress: ReadonlySet<string>
): HandoffTimeAdd | null {
  const slice = Math.round(ms)
  if (!Number.isFinite(slice) || slice <= 0) return null
  if (envio.status !== 'concluida') {
    const entregas = activeTimeEntregas(envio).map((e) => ({ id: e.id, ativoMs: slice }))
    return { envioId: envio.id, ativoMs: slice, entregas }
  }
  const entregas = envio.entregas.filter((e) => cardInProgress.has(e.id)).map((e) => ({ id: e.id, retrabalhoMs: slice }))
  return { envioId: envio.id, retrabalhoMs: slice, entregas }
}

// ---------------------------------------------------------------------------
// Parada
// ---------------------------------------------------------------------------

export interface StallContext {
  turnRunning: boolean
  /** Pergunta/permissão aberta EM MEMÓRIA (neste processo). */
  pending: boolean
  /** Última atividade da conversa: a vista neste processo (ou o início do
   *  tracker) e a escrita mais recente nos envios dela (conversationLastWriteMs), em ms. */
  lastActivityMs: number
  now: number
  limitMs?: number
}

/**
 * A escrita mais recente nos envios da conversa, em ms (0 sem nenhuma). Com o
 * banco compartilhado, é a atividade da conversa que roda em OUTRO PC: ele grava
 * tempo no envio corrente a cada passada — e o prompt na fila atrás dele espera
 * o mesmo turno, então a parada é julgada pela conversa, não pelo envio.
 */
export function conversationLastWriteMs(envios: readonly HandoffEnvio[]): number {
  let last = 0
  for (const envio of envios) last = Math.max(last, parseMs(envio.updatedAt) ?? 0)
  return last
}

/**
 * Por que o envio está parado, ou `null`. Na fila/enviado sem turno começar, em
 * execução sem turno rodando e sem conclusão, ou esperando você sem pergunta
 * aberta em memória, há o limite desde a última atividade (a do envio também
 * conta).
 */
export function stallReason(envio: HandoffEnvio, ctx: StallContext): string | null {
  if (ctx.turnRunning || ctx.pending || !STALLABLE.has(envio.status)) return null
  const limitMs = ctx.limitMs ?? HANDOFF_STALL_MS
  const since = Math.max(ctx.lastActivityMs, parseMs(envio.updatedAt) ?? 0)
  if (ctx.now - since < limitMs) return null
  const min = Math.max(1, Math.round(limitMs / 60_000))
  if (envio.status === 'na_fila') return `o prompt ficou ${min} min na fila sem ser enviado`
  if (envio.status === 'enviado') return `o prompt foi enviado, mas nenhum turno começou em ${min} min`
  if (envio.status === 'aguardando_voce') return `esperava você, mas não há pergunta aberta nem turno rodando há ${min} min`
  return `nenhum turno rodando há ${min} min, sem pergunta pendente e sem conclusão`
}

// ---------------------------------------------------------------------------
// Correção manual
// ---------------------------------------------------------------------------

export type HandoffCorrecao = 'concluir' | 'reabrir'

/** A correção do usuário numa entrega: fica registrada como dele. */
export function correctionPatch(
  entrega: HandoffEntrega,
  acao: HandoffCorrecao,
  motivo: string | undefined,
  now: string
): HandoffEntregaPatch {
  const extra = motivo?.trim()
  const base: HandoffEntregaPatch = {
    corrigidoPor: 'usuario',
    corrigidoEm: now,
    motivo: extra ? `${CORRECTED_BY_USER}: ${truncate(extra, HANDOFF_ERROR_MOTIVO_MAX)}` : CORRECTED_BY_USER
  }
  if (acao === 'reabrir') return { ...base, status: 'pendente', ...CLEAR_CONCLUSION }
  const concluidaEm = entrega.concluidaEm ?? now
  // `auditada: false`: quem concluiu foi o usuário, não o PO.
  return { ...base, status: 'concluida', concluidaEm, auditada: false, tempoCorridoMs: tempoCorrido(entrega.iniciadaEm, concluidaEm) }
}

/** O envio depois da correção (com a entrega já corrigida). Na fila não muda:
 *  o prompt ainda não saiu, e mudar o status impediria casá-lo quando sair. */
export function envioAfterCorrection(
  envio: HandoffEnvio,
  acao: HandoffCorrecao,
  cards: readonly BoardItem[],
  now: string
): HandoffEnvioPatch | null {
  if (!isEnvioSent(envio)) return null
  const allDone = envio.entregas.length > 0 && envio.entregas.every((e) => e.status === 'concluida')
  if (allDone) return envio.status === 'concluida' ? null : { status: 'concluida', concluidoEm: envio.concluidoEm ?? now, motivo: null }
  const missing = describeMissing(envio, cards)
  if (acao === 'reabrir' && envio.status === 'concluida') {
    return { status: 'incompleta', concluidoEm: null, motivo: incompleteMotivo(null, missing) }
  }
  // Incompleto continua incompleto, mas a lista do que falta acompanha a correção
  // (o motivo do erro do turno fica na frente).
  if (envio.status !== 'incompleta') return null
  const motivo = incompleteMotivo(turnErrorPart(envio.motivo), missing)
  return motivo === envio.motivo ? null : { motivo }
}
