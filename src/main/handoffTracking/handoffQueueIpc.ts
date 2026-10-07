import path from 'node:path'
import { z } from 'zod'
import type {
  HandoffProjectActionResult,
  HandoffProjectDirtyResult,
  HandoffProjectReplyResult,
  HandoffProjectStatusResult,
  HandoffQueueDispatchedResult,
  HandoffQueueGateResult,
  HandoffQueueListResult
} from '../../shared/api'
import { editQueued, removeQueued, reorderQueued, type QueueEditResult } from './handoffQueueEdit'
import { projectFolderKey } from '../../shared/handoffProject'
import {
  currentEnvio,
  HANDOFF_PO_HOLD_PREFIX,
  isEnvioHeldByPo,
  isEnvioRemoved,
  isRoutineEnvio,
  type HandoffEnvio,
  type HandoffQueueItem
} from '../../shared/handoffTracking'
import { Channels } from '../../shared/ipc'
import type { HandoffRepository } from '../persistence/types'
import { decideQueue, previousRunning, queuedEnvios } from './handoffQueue'
import type { HandoffTracker } from './handoffTracker'
import { queuedPrompt } from './projectQueueRules'
import type { ProjectDescription, ProjectQueueService } from './projectQueueService'

/** A fila parada pelo Stop do usuário (o envio anterior pode até ter concluído). */
export const STOP_HOLD_REASON = 'você parou o prompt anterior (Stop) — a fila espera você'

/**
 * Os canais da FILA DO QUADRO (handoffQueue.ts) e da FILA DO PROJETO
 * (projectQueueService.ts): a decisão do despachante, a marca "despachado" pelo
 * id, a lista para a faixa "Próximos prompts", a foto da fila do projeto e as
 * ações do usuário. A decisão mora no main, num lugar só; o renderer só
 * pergunta e despacha.
 *
 * Fronteira: payload por zod; nenhuma exceção atravessa o IPC.
 */

export type HandoffQueueIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface HandoffQueueIpcDeps {
  handle: (channel: string, listener: HandoffQueueIpcListener) => void
  repository(): HandoffRepository | null
  tracker: Pick<HandoffTracker, 'settled' | 'dispatched'> & Partial<Pick<HandoffTracker, 'stoppedByUser'>>
  /** A fila do projeto; sem ela, só a regra da fila do quadro (por conversa). */
  project?: Pick<ProjectQueueService, 'gate' | 'describe' | 'snapshot' | 'action' | 'reply'> &
    Partial<Pick<ProjectQueueService, 'reorder' | 'dirtyFiles'>>
  /** Uma ação da faixa mudou os envios da conversa (handoff:changed + fila do projeto). */
  changed?(conversationId: string): void
}

const ConversationId = z.string().min(1).max(200)
const GateReq = z.strictObject({ conversationId: ConversationId, force: z.boolean().optional() })
const DispatchedReq = z.strictObject({ conversationId: ConversationId, envioId: z.string().min(1).max(200) })
const ListReq = z
  .strictObject({ projectCwd: z.string().min(1).max(4096).refine((p) => path.isAbsolute(p), 'caminho absoluto').optional() })
  .optional()
const StatusReq = z.strictObject({}).optional()
const ActionReq = z.strictObject({
  conversationId: ConversationId,
  acao: z.enum(['comecar', 'passar', 'retomar_a', 'esperar_b', 'enviar_agora'])
})
/** O texto vai para o pedido do PO: o mesmo teto de um prompt de handoff. */
const ReplyReq = z.strictObject({ conversationId: ConversationId, texto: z.string().max(1_000_000) })
const EnvioId = z.string().min(1).max(200)
const EditReq = z.discriminatedUnion('acao', [
  z.strictObject({ envioId: EnvioId, acao: z.literal('tirar') }),
  z.strictObject({ envioId: EnvioId, acao: z.literal('editar'), conteudo: z.string().min(1).max(1_000_000) })
])
const ReorderReq = z.strictObject({ conversationId: ConversationId, envioIds: z.array(EnvioId).min(1).max(200) })
const ProjectReorderReq = z.strictObject({
  projectCwd: z.string().min(1).max(4096).refine((p) => path.isAbsolute(p), 'caminho absoluto'),
  loteIds: z.array(z.string().min(1).max(200)).min(1).max(200)
})
const DirtyReq = z.strictObject({ conversationId: ConversationId })

/** A pasta deste PC como chave da fila: o mesmo caminho escrito de dois jeitos é uma pasta só. */
export function folderKey(cwd: string): string {
  return projectFolderKey(path.resolve(cwd), process.platform === 'win32')
}

/**
 * A faixa "Próximos prompts" de uma pasta (null: todas): os envios das
 * conversas com prompt esperando, com a decisão da fila do projeto quando há.
 * O IPC da faixa e o contexto do "Fala, PO" leem daqui.
 */
export async function listQueueItems(
  repo: HandoffRepository,
  projectCwd: string | null,
  project?: Pick<NonNullable<HandoffQueueIpcDeps['project']>, 'describe'>
): Promise<HandoffQueueItem[]> {
  const waiting = await repo.listHandoffEnvios({ statuses: ['na_fila', 'parada'], limit: 1000 })
  const folder = projectCwd ? folderKey(projectCwd) : null
  const convIds = [...new Set(waiting.filter((e) => !folder || folderKey(e.projectCwd) === folder).map((e) => e.conversationId))]
  const envios: HandoffEnvio[] = []
  const described = new Map<string, ProjectDescription>()
  for (const conversationId of convIds) {
    const list = await repo.listHandoffEnvios({ conversationId })
    envios.push(...list)
    if (project) described.set(conversationId, await project.describe(conversationId, list))
  }
  return queueItems(envios, (id) => described.get(id))
}

/**
 * Os prompts que esperam, por conversa, com o estado do primeiro (parada ou
 * esperando). `described`: a decisão da fila do projeto, quando a conversa
 * está nela (a vez de outro plano, a pasta suja).
 */
export function queueItems(envios: readonly HandoffEnvio[], described?: (conversationId: string) => ProjectDescription | undefined): HandoffQueueItem[] {
  const byConv = new Map<string, HandoffEnvio[]>()
  for (const envio of envios) byConv.set(envio.conversationId, [...(byConv.get(envio.conversationId) ?? []), envio])
  const items: HandoffQueueItem[] = []
  for (const [conversationId, list] of byConv) {
    const project = described?.(conversationId)
    const decision = project?.decision ?? decideQueue(list)
    const previous = currentEnvio(list)
    const stopped = project?.estado
      ? project.estado === 'parada'
      : decision.kind === 'hold' && previous !== null && !previousRunning(previous)
    queuedEnvios(list).forEach((envio, index) => {
      const head = index === 0
      const lote = list.filter((e) => e.loteId === envio.loteId && !isEnvioRemoved(e) && !isRoutineEnvio(e))
      // O PO segurou este prompt: a faixa mostra "segurada pelo PO: <motivo>".
      const heldByPo = isEnvioHeldByPo(envio)
      // A rotina autorizada (commit/push), na frente dos prompts.
      const routine = isRoutineEnvio(envio)
      items.push({
        envioId: envio.id,
        conversationId: envio.conversationId,
        conversationTitle: envio.conversationTitle,
        projectCwd: envio.projectCwd,
        planSlug: envio.planSlug,
        planTitulo: envio.planTitulo,
        loteId: envio.loteId,
        ordem: envio.ordem,
        arquivo: envio.arquivo,
        estado: routine ? 'rotina' : heldByPo ? 'segurada' : head && stopped ? 'parada' : 'esperando',
        motivo: routine
          ? /dê push/.test(envio.conteudo)
            ? 'commit + push autorizado'
            : 'commit autorizado'
          : heldByPo
            ? (envio.motivo ?? '').slice(HANDOFF_PO_HOLD_PREFIX.length)
            : head && decision.kind === 'hold'
              ? decision.motivo
              : null,
        estimativaTotal: envio.estimativaTotal,
        ...(project?.posicao ? { planPosicao: project.posicao } : {}),
        etapas: [...envio.entregas].sort((a, b) => a.ordem - b.ordem).map((e) => ({ id: e.etapaId, titulo: e.etapaTitulo })),
        totalPrompts: lote.length,
        conteudo: envio.conteudo
      })
    })
  }
  return items
}

type Failure = { ok: false; message: string }

export function registerHandoffQueueIpc(deps: HandoffQueueIpcDeps): void {
  function handle<Req, Res extends { ok: true }>(channel: string, schema: z.ZodType<Req>, run: (req: Req) => Promise<Res | Failure>): void {
    deps.handle(channel, async (_event, payload): Promise<Res | Failure> => {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'pedido inválido' }
      try {
        return await run(parsed.data)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[handoff] ${channel} falhou:`, message)
        return { ok: false, message }
      }
    })
  }
  const repository = (): HandoffRepository | null => {
    try {
      return deps.repository()
    } catch {
      return null
    }
  }
  const offline = { ok: false as const, message: 'O banco está indisponível agora.' }
  const noProject = { ok: false as const, message: 'A fila do projeto não está ativa.' }

  handle(Channels.handoffQueueGate, GateReq, async (req): Promise<HandoffQueueGateResult> => {
    const repo = repository()
    if (!repo) return offline
    // Antes de decidir, o fim do turno assenta: o acompanhamento só fecha o envio
    // depois do fechamento do Quadro, que espera o PO (até o teto dele).
    await deps.tracker.settled(req.conversationId)
    const envios = await repo.listHandoffEnvios({ conversationId: req.conversationId })
    // Stop do usuário não é erro nem fim: a fila espera ele (só o "mesmo assim" solta).
    const next = queuedEnvios(envios)[0]
    if (!req.force && next && deps.tracker.stoppedByUser?.(req.conversationId)) {
      return { ok: true, decision: { kind: 'hold', envio: queuedPrompt(next), motivo: STOP_HOLD_REASON } }
    }
    const decision = deps.project
      ? await deps.project.gate(req.conversationId, envios, req.force === true)
      : decideQueue(envios, { force: req.force })
    return { ok: true, decision }
  })

  handle(Channels.handoffQueueDispatched, DispatchedReq, async (req): Promise<HandoffQueueDispatchedResult> => ({
    ok: true,
    dispatched: await deps.tracker.dispatched(req.conversationId, req.envioId)
  }))

  handle(Channels.handoffQueueList, ListReq, async (req): Promise<HandoffQueueListResult> => {
    const repo = repository()
    if (!repo) return offline
    return { ok: true, items: await listQueueItems(repo, req?.projectCwd ?? null, deps.project) }
  })

  handle(Channels.handoffProjectStatus, StatusReq, async (): Promise<HandoffProjectStatusResult> => {
    if (!deps.project) return noProject
    return { ok: true, snapshot: await deps.project.snapshot() }
  })

  handle(Channels.handoffProjectAction, ActionReq, async (req): Promise<HandoffProjectActionResult> => {
    if (!deps.project) return noProject
    return deps.project.action(req.conversationId, req.acao)
  })

  handle(Channels.handoffProjectReply, ReplyReq, async (req): Promise<HandoffProjectReplyResult> => {
    if (!deps.project) return { ok: true, stored: false }
    return { ok: true, ...(await deps.project.reply(req.conversationId, req.texto)) }
  })

  // As ações da faixa "Próximos prompts" (handoffQueueEdit.ts).
  const edit = { repository, changed: (id: string) => deps.changed?.(id) }
  handle(Channels.handoffQueueEdit, EditReq, async (req): Promise<QueueEditResult> =>
    req.acao === 'tirar' ? removeQueued(edit, req.envioId) : editQueued(edit, req.envioId, req.conteudo)
  )
  handle(Channels.handoffQueueReorder, ReorderReq, async (req): Promise<QueueEditResult> => reorderQueued(edit, req.conversationId, req.envioIds))
  handle(Channels.handoffProjectReorder, ProjectReorderReq, async (req): Promise<QueueEditResult> => {
    if (!deps.project?.reorder) return noProject
    return deps.project.reorder(req.projectCwd, req.loteIds)
  })
  handle(Channels.handoffProjectDirty, DirtyReq, async (req): Promise<HandoffProjectDirtyResult> => ({
    ok: true,
    files: (await deps.project?.dirtyFiles?.(req.conversationId)) ?? null
  }))
}
