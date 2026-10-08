/**
 * O "FALA, PO" no processo principal: o serviço com o mundo de verdade (quadro,
 * prints, envios, fila, conversas, tarefas, o modelo do PO) e os dois canais da
 * tela (o histórico e a pergunta). Sem banco gravável, o histórico abre (é
 * arquivo) e a pergunta responde que o quadro está fora do ar.
 */
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Channels } from '../../shared/ipc'
import { PO_REQUEST_FILE, type HandoffEnvio, type HandoffQueueItem } from '../../shared/handoffTracking'
import { CARD_ETAPA_PREFIX } from '../handoffTracking/handoffRules'
import type { PoChatMessage } from '../../shared/poChat'
import type { PersistenceRepository } from '../persistence/types'
import type { BoardService } from '../board/boardService'
import { folderKey, listQueueItems, type HandoffQueueIpcDeps } from '../handoffTracking/handoffQueueIpc'
import { claudeObserverEnv, runObserverAttempt } from '../observerQuery'
import { runPoAgentQuery } from '../po/poAgentQuery'
import { presenceSnapshot } from '../crossConversation'
import { createAppMcpServer } from '../appTools'
import { attachPrintFromAgent } from '../board/printRuntime'
import { PoChatService, type PoChatAskResult } from './poChatService'
import { PoChatStore } from './poChatStore'
import { verifyGuard } from './poChatVerify'

export interface PoChatBootDeps {
  repository(): PersistenceRepository | null
  board: Pick<BoardService, 'projectId' | 'list' | 'applyPo' | 'createPoItem'>
  /** A decisão da fila do projeto (a vez de outro plano, a pasta suja). */
  project?: Pick<NonNullable<HandoffQueueIpcDeps['project']>, 'describe'>
  tasks(cwd: string): Promise<Array<{ title: string; status: string }>>
  /** O modelo do PO (o mesmo das rodadas do quadro). */
  model(): string
  /**
   * Um plano novo registrado (o "Pedido do PO"): o acompanhamento, a fila do
   * projeto e o aviso ao despachante — o mesmo caminho do "Enviar para implementação".
   */
  registered?(envios: HandoffEnvio[]): Promise<void>
}

export type PoChatHistoryResult = { ok: true; messages: PoChatMessage[] } | { ok: false; message: string }

const cwdOf = (req: unknown): string | null => {
  const cwd = (req as { projectCwd?: unknown } | null)?.projectCwd
  return typeof cwd === 'string' && cwd.trim() ? cwd : null
}

export function startPoChat(deps: PoChatBootDeps): PoChatService {
  const repo = (): PersistenceRepository => {
    const r = deps.repository()
    if (!r) throw new Error('o banco do app está indisponível agora')
    return r
  }
  const service = new PoChatService({
    store: new PoChatStore(join(app.getPath('userData'), 'po-chat')),
    key: folderKey,
    board: async (cwd) => {
      const projectId = await deps.board.projectId(cwd)
      if (!projectId) return null
      const items = await deps.board.list(cwd)
      return items ? { projectId, items } : null
    },
    prints: async (projectId) =>
      (await repo().listBoardItemPrints({ projectId })).map((p) => ({
        boardItemId: p.boardItemId,
        thumbUrl: `data:image/jpeg;base64,${Buffer.from(p.thumb).toString('base64')}`
      })),
    envios: async (cwd) => {
      const projectId = await deps.board.projectId(cwd)
      return projectId ? repo().listHandoffEnvios({ projectIds: [projectId], limit: 200 }) : []
    },
    queue: async (cwd): Promise<HandoffQueueItem[]> => listQueueItems(repo(), cwd, deps.project),
    conversations: async ({ cwd, ids }) => {
      const r = repo()
      const found = new Map<string, Record<string, unknown> | null>()
      const add = (list: Awaited<ReturnType<PersistenceRepository['loadConversations']>>): void => {
        for (const c of list) if (!c.deletedAt) found.set(c.id, (c.payload as unknown as Record<string, unknown>) ?? null)
      }
      if (ids.length > 0) add(await r.loadConversations({ ids }))
      add(await r.loadConversations({ cwd }))
      return [...found].map(([id, payload]) => ({ id, payload }))
    },
    tasks: deps.tasks,
    ask: async (prompt, conversationId) => {
      const attempt = await runObserverAttempt({ prompt, model: deps.model(), provider: 'claude', conversationId })
      return attempt.state === 'completed' ? attempt.text : ''
    },
    // Com agente rodando nesta pasta, a verificação só lê (poChatVerify.ts).
    projectBusy: (cwd) => presenceSnapshot().some((p) => p.working && folderKey(p.cwd) === folderKey(cwd)),
    verify: async ({ prompt, cwd, timeoutMs, busy, signal, conversationId }) => {
      const model = deps.model()
      return runPoAgentQuery({
        prompt,
        cwd,
        model,
        env: await claudeObserverEnv(conversationId, model),
        timeoutMs,
        signal,
        hooks: { PreToolUse: [{ hooks: [verifyGuard(busy)] }] },
        // O print que serviu de evidência pode ir para o cartão (app_anexar_print).
        mcpServers: {
          app: createAppMcpServer({ cwd, attachPrint: conversationId ? (p) => attachPrintFromAgent({ ...p, conversationId, cwd }) : undefined })
        }
      })
    },
    applyCorrection: async (cwd, option) => {
      if (option.action === 'reabrir') {
        await deps.board.applyPo({ id: option.cardId, poStatus: 'pending', poReason: `o PO verificou (Fala, PO): ${option.reason}` })
        return
      }
      const projectId = await deps.board.projectId(cwd)
      if (!projectId) throw new Error('o quadro está indisponível agora')
      await deps.board.createPoItem({ projectId, projectCwd: cwd, conversationId: option.conversationId, title: option.title, status: 'pending', reason: option.reason })
    },
    // "Mandar fazer": um plano "Pedido do PO" na fila do projeto (um plano por vez).
    registerRequest: async ({ cwd, conversationId, conversationTitle, planTitulo, text, cards }) => {
      const projectId = await deps.board.projectId(cwd)
      if (!projectId) throw new Error('o quadro está indisponível agora')
      const id = randomUUID().slice(0, 8)
      const envios = await repo().createHandoffEnvios([
        {
          planSlug: `pedido-po-${id}`,
          planTitulo,
          projectId,
          projectCwd: cwd,
          conversationId,
          conversationTitle,
          arquivo: PO_REQUEST_FILE,
          ordem: 1,
          loteId: `pedido-po-${id}`,
          conteudo: text,
          // Conclui quando todos os cartões citados estão concluídos no Quadro (e não
          // contestados pelo PO) — mesmo que o turno tenha terminado com erro.
          entregas: cards.map((c) => ({ etapaId: `${CARD_ETAPA_PREFIX}${c.id}`, etapaTitulo: c.title, estimativaPlano: null }))
        }
      ])
      await deps.registered?.(envios)
    }
  })

  ipcMain.handle(Channels.poChatHistory, async (_e, req: unknown): Promise<PoChatHistoryResult> => {
    const cwd = cwdOf(req)
    if (!cwd) return { ok: false, message: 'projeto inválido' }
    return { ok: true, messages: await service.history(cwd) }
  })

  // Uma verificação por projeto; o "Cancelar" aborta a dela.
  const running = new Map<string, AbortController>()
  ipcMain.handle(Channels.poChatVerify, async (_e, req: unknown): Promise<PoChatAskResult> => {
    const cwd = cwdOf(req)
    const messageId = (req as { messageId?: unknown } | null)?.messageId
    if (!cwd || typeof messageId !== 'string') return { ok: false, message: 'pedido inválido' }
    const key = folderKey(cwd)
    if (running.has(key)) return { ok: false, message: 'já tem uma verificação rodando neste projeto' }
    const abort = new AbortController()
    running.set(key, abort)
    try {
      return await service.verify(cwd, messageId, abort.signal)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      running.delete(key)
    }
  })
  ipcMain.handle(Channels.poChatCancel, async (_e, req: unknown): Promise<{ ok: boolean }> => {
    const cwd = cwdOf(req)
    const abort = cwd ? running.get(folderKey(cwd)) : undefined
    abort?.abort()
    return { ok: !!abort }
  })
  ipcMain.handle(Channels.poChatApply, async (_e, req: unknown): Promise<PoChatAskResult> => {
    const cwd = cwdOf(req)
    const r = req as { messageId?: unknown; index?: unknown } | null
    if (!cwd || typeof r?.messageId !== 'string' || typeof r.index !== 'number') return { ok: false, message: 'pedido inválido' }
    return service.apply(cwd, r.messageId, r.index)
  })
  ipcMain.handle(Channels.poChatSend, async (_e, req: unknown): Promise<PoChatAskResult> => {
    const cwd = cwdOf(req)
    const r = req as { messageId?: unknown; index?: unknown; conversationId?: unknown; conversationTitle?: unknown } | null
    if (!cwd || typeof r?.messageId !== 'string' || typeof r.index !== 'number') return { ok: false, message: 'pedido inválido' }
    const target =
      typeof r.conversationId === 'string' && r.conversationId
        ? { conversationId: r.conversationId, conversationTitle: typeof r.conversationTitle === 'string' && r.conversationTitle ? r.conversationTitle : 'Pedido do PO' }
        : undefined
    return service.send(cwd, r.messageId, r.index, target)
  })

  ipcMain.handle(Channels.poChatAsk, async (_e, req: unknown): Promise<PoChatAskResult> => {
    const cwd = cwdOf(req)
    const question = (req as { question?: unknown } | null)?.question
    if (!cwd || typeof question !== 'string') return { ok: false, message: 'pergunta inválida' }
    try {
      return await service.ask(cwd, question)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  return service
}
