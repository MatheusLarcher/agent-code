import type { HandoffEnvio } from '../../shared/handoffTracking'
import { avisouVoce } from '../../shared/scrumPanel'
import type {
  ScrumDecisao,
  ScrumDecisaoTipo,
  ScrumEnvioView,
  ScrumFala,
  ScrumHistoryItem,
  ScrumHistoryRequest,
  ScrumMarco,
  ScrumPanelSnapshot
} from '../../shared/scrumPanel'
import { noticeEntrega } from '../handoffTracking/handoffDeadline'
import type { ScrumDeclaracao } from './scrumTypes'

/**
 * O que o PAINEL do Scrum Master mostra, montado sem I/O: a aba "Agora" (um
 * cartão por envio acompanhado) e a aba "Histórico" (as decisões do diário com
 * a contestação e a resposta do agente anexadas). Quem lê o banco e o diário é
 * o scrumIpc.ts.
 */

const MIN_MS = 60_000
const DAY_MS = 86_400_000
export const SCRUM_STOP_PREFIX = 'Scrum Master: '
export const SCRUM_HISTORY_LIMIT = 500

/** As decisões que viram item do histórico (as demais se anexam a elas ou ficam só no diário). */
const HIST_TIPOS: ReadonlySet<ScrumDecisaoTipo> = new Set(['parou', 'interrompeu', 'cobrou', 'falha', 'avisou', 'deixou-seguir'])
/** As falas do SM no cartão do envio. */
const FALA_TIPOS: ReadonlySet<ScrumDecisaoTipo> = new Set(['cobrou', 'falha', 'interrompeu', 'parou'])
const CORTE_TIPOS: ReadonlySet<ScrumDecisaoTipo> = new Set(['parou', 'interrompeu'])
const COBRANCA_TIPOS: ReadonlySet<ScrumDecisaoTipo> = new Set(['cobrou', 'falha'])

export { avisouVoce }

/** Envio parado pelo SM: a parada do 300% grava o motivo com o prefixo. */
export function isScrumStopped(envio: Pick<HandoffEnvio, 'status' | 'motivo'>): boolean {
  return envio.status === 'parada' && !!envio.motivo?.startsWith(SCRUM_STOP_PREFIX)
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function falaText(d: ScrumDecisao): string {
  if (d.tipo === 'parou') return `Parei o envio: ${d.motivo ?? 'sem motivo registrado'}.`
  return d.cobranca ?? d.motivo ?? ''
}

function falas(decisoes: readonly ScrumDecisao[]): ScrumFala[] {
  const out: ScrumFala[] = []
  for (const d of decisoes) {
    if (d.tipo === 'resposta') {
      if (d.texto) out.push({ id: d.id, at: d.at, quem: 'agente', marco: d.marco, veredito: null, tipoDesvio: null, texto: d.texto, avisouVoce: false })
    } else if (FALA_TIPOS.has(d.tipo)) {
      out.push({ id: d.id, at: d.at, quem: 'sm', marco: d.marco, veredito: d.veredito, tipoDesvio: d.tipoDesvio, texto: falaText(d), avisouVoce: avisouVoce(d) })
    }
  }
  return out
}

export interface ScrumPanelInput {
  /** Os envios em execução e os parados (o filtro do SM é feito aqui). */
  envios: readonly HandoffEnvio[]
  log: readonly ScrumDecisao[]
  declaracoes: readonly ScrumDeclaracao[]
  now: number
  enabled: boolean
  podeParar: boolean
  logFile: string | null
  /** A posição da etapa no plano por envio ("Etapa N de M"); ausente = a das entregas do envio. */
  places: ReadonlyMap<string, { n: number; total: number }>
  /** O próximo prompt que espera na fila, por conversa. */
  queued: ReadonlyMap<string, string>
}

function envioView(envio: HandoffEnvio, input: ScrumPanelInput): ScrumEnvioView | null {
  const entrega = noticeEntrega(envio)
  if (!entrega) return null
  const prazoMin = entrega.estimativaPlano
  const vezes = prazoMin && prazoMin > 0 ? entrega.tempoAtivoMs / (prazoMin * MIN_MS) : null
  const parado = isScrumStopped(envio)
  const decisoes = input.log.filter((d) => d.envioId === envio.id && d.entregaId === entrega.id)
  const marcos = [...new Set(decisoes.filter((d) => FALA_TIPOS.has(d.tipo) && typeof d.marco === 'number').map((d) => d.marco as ScrumMarco))].sort(
    (a, b) => a - b
  )
  const conversa = falas(decisoes)
  const lastSm = [...conversa].reverse().find((f) => f.quem === 'sm')
  const semResposta = !!lastSm && lastSm.texto !== '' && !conversa.some((f) => f.quem === 'agente' && f.at >= lastSm.at)
  const decl = input.declaracoes.find((d) => d.envioId === envio.id && d.entregaId === entrega.id && d.acimaDoTeto && !d.decidida)
  const place = input.places.get(envio.id)
  return {
    envioId: envio.id,
    convId: envio.conversationId,
    conversationTitle: envio.conversationTitle || 'Conversa',
    projectCwd: envio.projectCwd,
    estado: parado ? 'parado' : entrega.atrasada || (vezes !== null && vezes > 1) ? 'atrasado' : 'no-prazo',
    vezes,
    etapaN: place?.n ?? entrega.ordem,
    etapaTotal: place?.total ?? envio.entregas.length,
    etapaTitulo: entrega.etapaTitulo || null,
    entregaId: entrega.id,
    tempoAtivoMs: entrega.tempoAtivoMs,
    prazoMin,
    marcos,
    falas: conversa,
    semResposta: !parado && semResposta,
    paradoMotivo: parado ? (envio.motivo ?? '').slice(SCRUM_STOP_PREFIX.length) : null,
    proximoNaFila: input.queued.get(envio.conversationId) ?? null,
    declaracao: decl ? { entregaId: decl.entregaId, pedidoMin: decl.pedidoMin, validoMin: decl.validoMin, motivo: decl.motivo } : null
  }
}

/** Quantas decisões têm contestação do usuário (o selo da aba Histórico). */
export function contestedCount(log: readonly ScrumDecisao[]): number {
  return new Set(log.filter((d) => d.tipo === 'contestado' && d.refId).map((d) => d.refId)).size
}

/** A aba "Agora", os tiles e o selo. Parados primeiro, depois os mais atrasados. */
export function buildScrumPanel(input: ScrumPanelInput): ScrumPanelSnapshot {
  const envios = input.envios
    .filter((e) => e.status === 'em_execucao' || isScrumStopped(e))
    .map((e) => envioView(e, input))
    .filter((v): v is ScrumEnvioView => v !== null)
  const rank = { parado: 0, atrasado: 1, 'no-prazo': 2 } as const
  envios.sort((a, b) => rank[a.estado] - rank[b.estado] || (b.vezes ?? 0) - (a.vezes ?? 0))
  const cobrancasHoje = input.log.filter((d) => COBRANCA_TIPOS.has(d.tipo) && sameLocalDay(Date.parse(d.at), input.now)).length
  return {
    enabled: input.enabled,
    podeParar: input.podeParar,
    logFile: input.logFile,
    tiles: { acompanhados: envios.length, cobrancasHoje, parados: envios.filter((e) => e.estado === 'parado').length },
    contestados: contestedCount(input.log),
    envios
  }
}

function matchesFiltro(item: ScrumHistoryItem, filtro: ScrumHistoryRequest['filtro']): boolean {
  const d = item.decisao
  switch (filtro) {
    case 'cortes':
      return CORTE_TIPOS.has(d.tipo)
    case 'contestados':
      return item.contestacao !== null
    case 'cobrancas':
      return COBRANCA_TIPOS.has(d.tipo)
    case 'avisos':
      return avisouVoce(d)
    default:
      return true
  }
}

function matchesBusca(d: ScrumDecisao, busca: string): boolean {
  if (!busca) return true
  const hay = `${d.conversationTitle ?? ''}\n${d.projectCwd ?? ''}\n${d.etapaId ?? ''}`.toLocaleLowerCase('pt-BR')
  return hay.includes(busca)
}

/** A aba "Histórico": do mais novo para o mais antigo, com contestação e resposta anexadas. */
export function scrumHistory(log: readonly ScrumDecisao[], req: ScrumHistoryRequest, now: number): { items: ScrumHistoryItem[]; total: number } {
  const contestacoes = new Map<string, { frase: string; at: string }>()
  const respostas = new Map<string, string>()
  for (const d of log) {
    if (!d.refId) continue
    if (d.tipo === 'contestado') contestacoes.set(d.refId, { frase: d.texto ?? '', at: d.at })
    else if (d.tipo === 'resposta' && d.texto && !respostas.has(d.refId)) respostas.set(d.refId, d.texto)
  }
  const desde = req.periodo === '7d' ? now - 7 * DAY_MS : req.periodo === '30d' ? now - 30 * DAY_MS : -Infinity
  const busca = (req.busca ?? '').trim().toLocaleLowerCase('pt-BR')
  const items = log
    .filter((d) => HIST_TIPOS.has(d.tipo) && Date.parse(d.at) >= desde && matchesBusca(d, busca))
    .map((d): ScrumHistoryItem => ({ decisao: d, contestacao: contestacoes.get(d.id) ?? null, resposta: respostas.get(d.id) ?? null }))
    .filter((item) => matchesFiltro(item, req.filtro))
    .sort((a, b) => Date.parse(b.decisao.at) - Date.parse(a.decisao.at))
  const limit = Math.max(1, Math.min(req.limit ?? SCRUM_HISTORY_LIMIT, 5_000))
  return { items: items.slice(0, limit), total: items.length }
}
