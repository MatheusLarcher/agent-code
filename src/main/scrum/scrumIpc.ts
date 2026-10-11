import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Channels, type ScrumMasterConfig } from '../../shared/ipc'
import { isEnvioRemoved, isEnvioSent, type HandoffEnvio } from '../../shared/handoffTracking'
import {
  SCRUM_HIST_FILTROS,
  SCRUM_HIST_PERIODOS,
  type ScrumActionResult,
  type ScrumAskResult,
  type ScrumChatHistoryResult,
  type ScrumDecisao,
  type ScrumHistoryResult,
  type ScrumPanelResult
} from '../../shared/scrumPanel'
import { noticeEntrega } from '../handoffTracking/handoffDeadline'
import type { HandoffRepository } from '../persistence/types'
import type { ScrumChatService } from './scrumChatService'
import type { ScrumChatStore } from './scrumChatStore'
import type { ScrumLogWriter } from './scrumLog'
import type { ScrumMaster } from './scrumMaster'
import { buildScrumPanel, isScrumStopped, scrumHistory } from './scrumPanelView'

/**
 * Os canais do PAINEL do Scrum Master (o celular fica fora): a aba Agora, o
 * Histórico filtrado, a conversa com o SM e o Aprovar/Recusar da declaração
 * acima do teto. Entrada validada com zod; nada aqui lança para a tela.
 * Retomar, Tirar da fila e "Pode parar envios" usam os canais que já existem
 * (agent:send, handoff:queue-edit, config:set).
 */

export interface ScrumIpcDeps {
  repository(): HandoffRepository | null
  master: Pick<ScrumMaster, 'pendingDeclarations' | 'decideDeclaration'>
  config(): ScrumMasterConfig
  /** O diário inteiro (readScrumLog). */
  history(): Promise<ScrumDecisao[]>
  /** O diário da aba Histórico (readScrumLogStrict): ilegível vira o erro da aba, não "nada feito". */
  historyStrict?(): Promise<ScrumDecisao[]>
  /** O gravador com aviso à tela (scrumFeed.log). */
  log: ScrumLogWriter
  logFile(): Promise<string | null>
  chat: Pick<ScrumChatService, 'ask'>
  chatStore: Pick<ScrumChatStore, 'page'>
  /** "Etapa N de M" de um envio (loadPlanProgress); falha = a das entregas do envio. */
  place(envio: HandoffEnvio, etapaId: string): Promise<{ n: number; total: number } | null>
  now?(): number
}

const HistoryReq = z.object({
  filtro: z.enum(SCRUM_HIST_FILTROS),
  periodo: z.enum(SCRUM_HIST_PERIODOS),
  busca: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(5_000).optional()
})

const ChatHistoryReq = z.object({
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5_000).optional()
})

const AskReq = z.object({
  text: z.string().max(4_000),
  sobre: z.string().min(1).max(200).nullable(),
  contestar: z.boolean().optional()
})

const DecideReq = z.object({
  envioId: z.string().min(1).max(200),
  entregaId: z.string().min(1).max(200),
  aprovar: z.boolean()
})

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** O próximo prompt que espera na fila de cada conversa (o "Tirar da fila"). */
async function queuedByConversation(repo: HandoffRepository, convIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const conversationId of new Set(convIds)) {
    const envios = await repo.listHandoffEnvios({ conversationId }).catch((): HandoffEnvio[] => [])
    const next = envios.filter((e) => !isEnvioSent(e) && !isEnvioRemoved(e)).sort((a, b) => a.ordem - b.ordem)[0]
    if (next) out.set(conversationId, next.id)
  }
  return out
}

export async function scrumPanelSnapshot(deps: ScrumIpcDeps): Promise<ScrumPanelResult> {
  const repo = deps.repository()
  if (!repo) return { ok: false, message: 'O banco do app está indisponível agora.' }
  const [listed, log, logFile] = await Promise.all([
    repo.listHandoffEnvios({ statuses: ['em_execucao', 'parada'], limit: 500 }),
    deps.history(),
    deps.logFile().catch(() => null)
  ])
  // Só os que o painel mostra: cada um custa uma leitura do plano e uma da fila.
  const envios = listed.filter((e) => e.status === 'em_execucao' || isScrumStopped(e))
  const places = new Map<string, { n: number; total: number }>()
  for (const envio of envios) {
    const entrega = noticeEntrega(envio)
    const place = entrega ? await deps.place(envio, entrega.etapaId).catch(() => null) : null
    if (place) places.set(envio.id, place)
  }
  const cfg = deps.config()
  const snapshot = buildScrumPanel({
    envios,
    log,
    declaracoes: deps.master.pendingDeclarations(),
    now: deps.now?.() ?? Date.now(),
    enabled: cfg.enabled,
    podeParar: cfg.podeParar,
    logFile,
    places,
    queued: await queuedByConversation(repo, envios.map((e) => e.conversationId))
  })
  return { ok: true, snapshot }
}

/** Aprovar/Recusar: a decisão do usuário vira linha do diário, ligada à declaração. */
export function decideDeclaration(deps: ScrumIpcDeps, log: readonly ScrumDecisao[], req: z.infer<typeof DecideReq>): ScrumActionResult {
  const decided = deps.master.decideDeclaration(req.envioId, req.entregaId, req.aprovar)
  if (!decided) return { ok: false, message: 'Esta declaração já foi decidida ou não existe mais (o app reiniciou).' }
  const declarou = [...log].reverse().find((d) => d.tipo === 'declarou' && d.envioId === req.envioId && d.entregaId === req.entregaId)
  if (declarou) {
    deps.log({
      ...declarou,
      id: randomUUID(),
      at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      tipo: req.aprovar ? 'aprovou' : 'recusou',
      declaradoMin: decided.validoMin,
      motivo: req.aprovar ? `você aprovou ${decided.pedidoMin} min` : `você recusou: vale o teto de ${decided.validoMin} min`,
      refId: declarou.id,
      texto: null
    })
  }
  return { ok: true }
}

export function registerScrumIpc(deps: ScrumIpcDeps): void {
  ipcMain.handle(Channels.scrumPanel, async (): Promise<ScrumPanelResult> => {
    try {
      return await scrumPanelSnapshot(deps)
    } catch (err) {
      return { ok: false, message: message(err) }
    }
  })

  ipcMain.handle(Channels.scrumHistory, async (_e, req: unknown): Promise<ScrumHistoryResult> => {
    const parsed = HistoryReq.safeParse(req)
    if (!parsed.success) return { ok: false, message: 'pedido inválido' }
    try {
      const log = deps.historyStrict ? await deps.historyStrict() : await deps.history()
      return { ok: true, ...scrumHistory(log, parsed.data, deps.now?.() ?? Date.now()) }
    } catch (err) {
      return { ok: false, message: message(err) }
    }
  })

  ipcMain.handle(Channels.scrumChatHistory, async (_e, req: unknown): Promise<ScrumChatHistoryResult> => {
    const parsed = ChatHistoryReq.safeParse(req ?? {})
    if (!parsed.success) return { ok: false, message: 'pedido inválido' }
    try {
      return { ok: true, ...(await deps.chatStore.page(parsed.data.skip, parsed.data.limit)) }
    } catch (err) {
      return { ok: false, message: message(err) }
    }
  })

  ipcMain.handle(Channels.scrumAsk, async (_e, req: unknown): Promise<ScrumAskResult> => {
    const parsed = AskReq.safeParse(req)
    if (!parsed.success) return { ok: false, message: 'mensagem inválida' }
    return deps.chat.ask(parsed.data)
  })

  ipcMain.handle(Channels.scrumDecideDeclaration, async (_e, req: unknown): Promise<ScrumActionResult> => {
    const parsed = DecideReq.safeParse(req)
    if (!parsed.success) return { ok: false, message: 'pedido inválido' }
    try {
      return decideDeclaration(deps, await deps.history(), parsed.data)
    } catch (err) {
      return { ok: false, message: message(err) }
    }
  })
}
