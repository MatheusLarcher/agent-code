import {
  currentEnvio,
  isEnvioSent,
  type HandoffEntrega,
  type HandoffEnvio,
  type HandoffEnvioStatus
} from '../../shared/handoffTracking'
import {
  BOARD_USER_MOVE_REASON_PREFIX,
  boardItemStatus,
  parseBoardTurnEndReason,
  type BoardItem
} from '../../shared/ipc'
import type { HandoffEntregaPatch, HandoffEnvioPatch, HandoffTimeAdd } from '../persistence/types'
import { STALL_ABORT_MS } from '../stallWatch'

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
 *  Quadro não o reescreve (perderia o erro). */
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

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
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

const ETAPA_PREFIX = /^\s*\[([^\]\s]{1,64})\]/

/** O id da etapa no começo do título (`[id-da-etapa] …`), em minúsculas; `null` sem prefixo. */
export function etapaIdFromTitle(title: string | null | undefined): string | null {
  const match = ETAPA_PREFIX.exec(title ?? '')
  return match ? match[1].toLowerCase() : null
}

/** O cartão da etapa: não dispensado, título (do agente ou do PO) com o prefixo
 *  `[id]`. Vários → o atualizado por último. Item sem prefixo é subitem. */
export function cardForEtapa(cards: readonly BoardItem[], etapaId: string): BoardItem | null {
  const id = etapaId.toLowerCase()
  let best: BoardItem | null = null
  for (const card of cards) {
    if (card.dismissedAt !== null) continue
    if (etapaIdFromTitle(card.sourceTitle) !== id && etapaIdFromTitle(card.poTitle) !== id) continue
    if (!best || (parseMs(card.updatedAt) ?? 0) >= (parseMs(best.updatedAt) ?? 0)) best = card
  }
  return best
}

/**
 * O motivo da contestação do PO, ou `null`. Contestado = o agente concluiu e o
 * PO sobrepôs outro status. NÃO é contestação: o fim de turno devolvendo
 * "fazendo" para "a fazer" (regra do app) nem o arrasto do usuário no Quadro.
 */
export function poContestReason(card: BoardItem): string | null {
  if (card.sourceStatus !== 'completed' || card.poStatus === null || card.poStatus === 'completed') return null
  if (parseBoardTurnEndReason(card.poReason)) return null
  if (card.poReason?.startsWith(BOARD_USER_MOVE_REASON_PREFIX)) return null
  return card.poReason?.trim() || 'sem motivo registrado'
}

/** Por que a etapa NÃO está concluída, dito pelo cartão (ou pela falta dele). */
export function blockReason(card: BoardItem | null, etapaId: string): string {
  if (!card) return `sem cartão no Quadro com o prefixo [${etapaId}]`
  const contest = poContestReason(card)
  if (contest) return `o PO contestou: ${contest}`
  const status = boardItemStatus(card)
  const label = status === 'in_progress' ? 'cartão em andamento' : status === 'pending' ? 'cartão a fazer' : 'cartão concluído'
  // O motivo do PO/do app diz o que o status sozinho não diz ("o turno terminou
  // sem concluir esta tarefa — falta verificar…").
  const why = card.poReason?.trim()
  return why ? `${label} (${why})` : label
}

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

/** As entregas do envio acompanhando os cartões da conversa. */
export function syncEntregas(envio: HandoffEnvio, cards: readonly BoardItem[], ctx: EntregaSyncContext): EntregaPatchFor[] {
  const out: EntregaPatchFor[] = []
  for (const entrega of envio.entregas) {
    const patch = entregaCardPatch(entrega, cardForEtapa(cards, entrega.etapaId), ctx)
    if (patch) out.push({ id: entrega.id, patch })
  }
  return out
}

/** As entregas cujo cartão está em andamento — é para elas que vai o retrabalho. */
export function entregasWithCardInProgress(envio: HandoffEnvio, cards: readonly BoardItem[]): string[] {
  return envio.entregas
    .filter((entrega) => {
      const card = cardForEtapa(cards, entrega.etapaId)
      return card !== null && boardItemStatus(card) === 'in_progress'
    })
    .map((entrega) => entrega.id)
}

// ---------------------------------------------------------------------------
// Critério concluída / incompleta
// ---------------------------------------------------------------------------

function missingReason(entrega: HandoffEntrega, cards: readonly BoardItem[]): string {
  if (entrega.corrigidoPor === 'usuario') return entrega.motivo ?? CORRECTED_BY_USER
  return blockReason(cardForEtapa(cards, entrega.etapaId), entrega.etapaId)
}

/** "faltou 1 de 3 entregas: [id] Título — motivo; …" */
export function describeMissing(envio: HandoffEnvio, cards: readonly BoardItem[]): string {
  const missing = envio.entregas.filter((e) => e.status !== 'concluida')
  if (missing.length === 0) return ''
  const items = missing.map((e) => `[${e.etapaId}] ${e.etapaTitulo} — ${missingReason(e, cards)}`)
  const noun = envio.entregas.length === 1 ? 'entrega' : 'entregas'
  return `faltou ${missing.length} de ${envio.entregas.length} ${noun}: ${items.join('; ')}`
}

export interface TurnEndOutcome {
  envio: HandoffEnvioPatch
  entregas: EntregaPatchFor[]
}

/**
 * O fim do turno (`result`) do envio corrente, com as entregas JÁ sincronizadas
 * com os cartões. Todas concluídas e turno sem erro → `concluida`; senão
 * `incompleta`, dizendo o que faltou e por quê — e cada entrega que faltou
 * fica `incompleta` com o próprio motivo (a corrigida pelo usuário, não).
 * Envio sem entregas: só o turno decide.
 */
export function turnEndOutcome(
  envio: HandoffEnvio,
  cards: readonly BoardItem[],
  ctx: { now: string; turnError: string | null }
): TurnEndOutcome {
  const entregas: EntregaPatchFor[] = []
  for (const entrega of envio.entregas) {
    if (entrega.status === 'concluida' || entrega.corrigidoPor === 'usuario') continue
    const patch = diff(entrega, { status: 'incompleta', motivo: missingReason(entrega, cards) })
    if (patch) entregas.push({ id: entrega.id, patch })
  }
  const missing = describeMissing(envio, cards)
  if (!ctx.turnError && !missing) {
    return { envio: { status: 'concluida', concluidoEm: envio.concluidoEm ?? ctx.now, motivo: null }, entregas }
  }
  const error = ctx.turnError ? `${TURN_ERROR_PREFIX}: ${truncate(ctx.turnError, HANDOFF_ERROR_MOTIVO_MAX)}` : ''
  const motivo = truncate([error, missing].filter(Boolean).join(' — '), HANDOFF_ENVIO_MOTIVO_MAX)
  return { envio: { status: 'incompleta', motivo, concluidoEm: null }, entregas }
}

/**
 * Depois de reler os cartões de um envio que JÁ terminou incompleto: o veredito
 * do PO que chegou depois do teto (30 s) concluiu a última entrega → o envio
 * passa a concluído; senão, o motivo acompanha o que ainda falta.
 * `completedNow` = alguma entrega acabou de virar concluída. O incompleto de
 * turno que terminou com ERRO fica como está: concluído exige turno sem erro, e
 * o motivo do erro não se perde.
 */
export function incompleteRefresh(
  envio: HandoffEnvio,
  cards: readonly BoardItem[],
  ctx: { now: string; completedNow: boolean; turnRunning: boolean }
): HandoffEnvioPatch | null {
  if (envio.status !== 'incompleta' || ctx.turnRunning || envio.motivo?.startsWith(TURN_ERROR_PREFIX)) return null
  const missing = describeMissing(envio, cards)
  if (!missing && envio.entregas.length > 0 && ctx.completedNow) {
    return { status: 'concluida', concluidoEm: ctx.now, motivo: null }
  }
  if (!missing) return null
  const motivo = truncate(missing, HANDOFF_ENVIO_MOTIVO_MAX)
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
export function errorPatch(envio: HandoffEnvio, text: string): HandoffEnvioPatch | null {
  if (envio.status === 'concluida' || !isEnvioSent(envio)) return null
  const motivo = truncate(text, HANDOFF_ERROR_MOTIVO_MAX) || 'o turno terminou com erro'
  return envio.status === 'falhou' && envio.motivo === motivo ? null : { status: 'falhou', motivo }
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/**
 * Para onde vai uma fatia de tempo ATIVO (turno rodando, sem pergunta aberta).
 * Envio não concluído: tempo ativo do envio e de cada entrega em andamento.
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
    const entregas = envio.entregas.filter((e) => e.status === 'em_andamento').map((e) => ({ id: e.id, ativoMs: slice }))
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
  const motivo = truncate(describeMissing(envio, cards), HANDOFF_ENVIO_MOTIVO_MAX)
  if (acao === 'reabrir' && envio.status === 'concluida') return { status: 'incompleta', concluidoEm: null, motivo }
  // Incompleto continua incompleto, mas a lista do que falta acompanha a correção
  // (o motivo do erro do turno fica).
  if (envio.status === 'incompleta' && !envio.motivo?.startsWith(TURN_ERROR_PREFIX) && motivo !== envio.motivo) {
    return { motivo }
  }
  return null
}
