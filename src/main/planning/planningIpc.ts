import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  Channels,
  type OpenedPlanningDto,
  type PlanningCardDto,
  type PlanningChangedMsg,
  type PlanningFailure,
  type PlanningHandoffDto,
  type PlanningResult,
  type PlanningRoteiroDto
} from '../../shared/ipc'
import { notifyPlanningChanged, setPlanningChangeSink } from './planningEvents'
import { CARD_TYPES, isValidName, PlanningValidationError, STAGE_STATUSES } from './planningModel'
import * as realStore from './planningStore'
import { PlanNotFoundError, PlanningPathError, RevConflictError, RoteiroConflictError } from './planningStore'
import { PlanningWatcher, type PlanningChange } from './planningWatcher'

/**
 * Os handlers planning:* do processo main. Toda a lógica mora aqui; o index.ts
 * só chama registerPlanningIpc com o ipcMain e o send dele.
 *
 * Fronteira: todo payload passa por zod antes de tocar o store, e nenhuma
 * exceção atravessa o IPC — o renderer recebe um PlanningResult tipado.
 */

export interface PlanningStoreApi {
  listPlans: typeof realStore.listPlans
  createPlan: typeof realStore.createPlan
  openPlan: typeof realStore.openPlan
  saveCard: typeof realStore.saveCard
  deleteCard: typeof realStore.deleteCard
  saveRoteiro: typeof realStore.saveRoteiro
  saveLayout: typeof realStore.saveLayout
  listHandoffs: typeof realStore.listHandoffs
  writeHandoff: typeof realStore.writeHandoff
}

export interface PlanningWatcherLike {
  watch(projectCwd: string, slug: string): void
  unwatch(projectCwd: string, slug: string): void
  revive?(projectCwd: string, slug: string): void
  closeAll(): void
}

export type PlanningIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface PlanningIpcDeps {
  /** Mesmo formato de ipcMain.handle. */
  handle: (channel: string, listener: PlanningIpcListener) => void
  /** Main → renderer (o send() do index.ts). */
  send: (channel: string, payload: unknown) => void
  store?: PlanningStoreApi
  createWatcher?: (onChange: (change: PlanningChange) => void) => PlanningWatcherLike
  isDirectory?: (p: string) => Promise<boolean>
}

export interface PlanningIpcHandle {
  /** Fecha todas as vigias e esquece quem abriu o quê (encerramento do app). */
  close(): void
}

const NAME_MSG = 'use [a-z0-9-], de 1 a 64 caracteres'
const Name = z.string().refine(isValidName, NAME_MSG)
const ProjectCwd = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), 'projectCwd deve ser caminho absoluto')
const Rev = z.number().int().min(0)
const Text = z.string().max(1000)

const refShape = { projectCwd: ProjectCwd, slug: Name }

const CardSchema = z.strictObject({
  id: Name,
  tipo: z.enum(CARD_TYPES),
  titulo: Text,
  etapa: Name.optional(),
  status: z.string().max(64).optional(),
  links: z.array(Name).max(1000),
  fonte: z.string().max(4096).optional(),
  rev: Rev,
  corpo: z.string().max(1_000_000)
})

const RoteiroSchema = z.strictObject({
  titulo: Text,
  etapas: z.array(z.strictObject({ id: Name, titulo: Text, status: z.enum(STAGE_STATUSES) })).max(500)
})

const Point = z.strictObject({ x: z.number(), y: z.number() })
const LayoutSchema = z.strictObject({
  positions: z.record(z.string(), Point),
  viewport: z.strictObject({ x: z.number(), y: z.number(), zoom: z.number() }).optional()
})

const ListReq = z.strictObject({ projectCwd: ProjectCwd })
const RefReq = z.strictObject(refShape)
const CreateReq = z.strictObject({ ...refShape, titulo: Text })
const SaveCardReq = z.strictObject({ ...refShape, card: CardSchema, expectedRev: Rev })
const DeleteCardReq = z.strictObject({ ...refShape, id: Name, expectedRev: Rev })
const SaveRoteiroReq = z.strictObject({ ...refShape, roteiro: RoteiroSchema, expectedRev: Rev })
const SaveLayoutReq = z.strictObject({ ...refShape, layout: LayoutSchema })
const WriteHandoffReq = z.strictObject({
  ...refShape,
  conteudo: z.string().max(1_000_000).refine((s) => s.trim() !== '', 'o prompt de handoff está vazio')
})

function invalid(message: string): PlanningFailure {
  return { ok: false, code: 'invalid', message }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

/** Exceção do store → resultado tipado. */
export function toPlanningFailure(err: unknown): PlanningFailure {
  if (err instanceof RevConflictError) {
    const current: PlanningCardDto | null = err.current
    return { ok: false, code: 'rev_conflict', current }
  }
  if (err instanceof RoteiroConflictError) {
    const current: PlanningRoteiroDto = err.current
    return { ok: false, code: 'roteiro_conflict', message: err.message, current }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof PlanNotFoundError) return { ok: false, code: 'not_found', message }
  if (err instanceof PlanningValidationError || err instanceof PlanningPathError) return invalid(message)
  // JSON quebrado em _canvas.json (editado à mão): dado inválido, não falha de disco.
  if (err instanceof SyntaxError) return invalid(message)
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, code: 'not_found', message }
  return { ok: false, code: 'io', message }
}

async function defaultIsDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function senderIdOf(event: unknown): number {
  const id = (event as { sender?: { id?: unknown } } | null | undefined)?.sender?.id
  return typeof id === 'number' ? id : 0
}

/** Chave de um plano aberto: projeto + slug, não a pasta — a pasta sai da pasta
 *  de dados do app (planDirPath), que pode trocar entre o open e o close. */
function planKey(projectCwd: string, slug: string): string {
  const key = `${path.resolve(projectCwd)}\u0000${slug}`
  return process.platform === 'win32' ? key.toLowerCase() : key
}

export function registerPlanningIpc(deps: PlanningIpcDeps): PlanningIpcHandle {
  const store = deps.store ?? realStore
  const isDirectory = deps.isDirectory ?? defaultIsDirectory
  const onChange = (change: PlanningChange): void => {
    const msg: PlanningChangedMsg = { projectCwd: change.projectCwd, slug: change.slug }
    deps.send(Channels.planningChanged, msg)
  }
  const watcher = deps.createWatcher ? deps.createWatcher(onChange) : new PlanningWatcher({ onChange })
  // Mudanças feitas pelo agente (plan_*) são gravações próprias, que o vigia
  // ignora; chegam à tela pelo mesmo canal por este sink.
  const releaseSink = setPlanningChangeSink(onChange)
  /** Quem (janela) abriu qual planejamento: reabrir para recarregar depois de
   *  planning:changed não pode inflar a contagem de referências do vigia. */
  const openers = new Map<string, { projectCwd: string; slug: string }>()
  /**
   * Quantos planning:close chegaram por chave (janela + plano). Um open lê o
   * contador ANTES do primeiro await; se ele mudou quando o open termina, um
   * close chegou no meio — a tela já saiu, e registrar a vigia agora a
   * deixaria viva sem ninguém para soltá-la.
   */
  const closes = new Map<string, number>()
  const openerKey = (senderId: number, projectCwd: string, slug: string): string =>
    `${senderId}\u0000${planKey(projectCwd, slug)}`

  function register<Req extends { projectCwd: string }, T extends object>(
    channel: string,
    schema: z.ZodType<Req>,
    run: (req: Req, senderId: number, snapshot: number) => Promise<PlanningResult<T>>,
    opts: {
      requireProject?: boolean
      /** Lido de forma síncrona, ANTES de qualquer await do handler (ver `closes`). */
      snapshot?: (req: Req, senderId: number) => number
    } = {}
  ): void {
    deps.handle(channel, async (event, payload) => {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) return invalid(describeIssues(parsed.error))
      const senderId = senderIdOf(event)
      const snapshot = opts.snapshot?.(parsed.data, senderId) ?? 0
      if (opts.requireProject !== false && !(await isDirectory(parsed.data.projectCwd))) {
        return { ok: false, code: 'not_found', message: 'pasta do projeto não encontrada' } satisfies PlanningFailure
      }
      try {
        return await run(parsed.data, senderId, snapshot)
      } catch (err) {
        return toPlanningFailure(err)
      }
    })
  }

  register(Channels.planningList, ListReq, async ({ projectCwd }): Promise<PlanningResult<{ slugs: string[] }>> => ({
    ok: true,
    slugs: await store.listPlans(projectCwd)
  }))

  register(
    Channels.planningCreate,
    CreateReq,
    async ({ projectCwd, slug, titulo }): Promise<PlanningResult<{ plan: OpenedPlanningDto }>> => ({
      ok: true,
      plan: await store.createPlan(projectCwd, slug, titulo)
    })
  )

  register(
    Channels.planningOpen,
    RefReq,
    async ({ projectCwd, slug }, senderId, closesAtStart): Promise<PlanningResult<{ plan: OpenedPlanningDto }>> => {
      const plan = await store.openPlan(projectCwd, slug)
      const key = openerKey(senderId, projectCwd, slug)
      // Fechado enquanto abria: devolve o plano (a tela descarta), sem vigia.
      if ((closes.get(key) ?? 0) !== closesAtStart) return { ok: true, plan }
      if (openers.has(key)) {
        watcher.revive?.(projectCwd, slug)
      } else {
        watcher.watch(projectCwd, slug)
        openers.set(key, { projectCwd, slug })
      }
      return { ok: true, plan }
    },
    { snapshot: ({ projectCwd, slug }, senderId) => closes.get(openerKey(senderId, projectCwd, slug)) ?? 0 }
  )

  // Fechar não exige a pasta: se o projeto sumiu, a vigia ainda precisa sair.
  register(
    Channels.planningClose,
    RefReq,
    async ({ projectCwd, slug }, senderId): Promise<PlanningResult> => {
      const key = openerKey(senderId, projectCwd, slug)
      closes.set(key, (closes.get(key) ?? 0) + 1)
      const opened = openers.get(key)
      if (opened) {
        openers.delete(key)
        watcher.unwatch(opened.projectCwd, opened.slug)
      }
      return { ok: true }
    },
    { requireProject: false }
  )

  register(
    Channels.planningSaveCard,
    SaveCardReq,
    async ({ projectCwd, slug, card, expectedRev }): Promise<PlanningResult<{ card: PlanningCardDto }>> => ({
      ok: true,
      card: await store.saveCard(projectCwd, slug, card, expectedRev)
    })
  )

  register(
    Channels.planningDeleteCard,
    DeleteCardReq,
    async ({ projectCwd, slug, id, expectedRev }): Promise<PlanningResult> => {
      await store.deleteCard(projectCwd, slug, id, expectedRev)
      return { ok: true }
    }
  )

  // A gravação é própria (o vigia a ignora), mas nem sempre sai da tela que
  // está aberta: o título sincronizado pela conversa (conversationTitle.ts)
  // também chega por aqui. Sem o aviso, o cabeçalho da tela aberta só veria o
  // nome novo no próximo planning:changed. Conflito/erro não gravou: sem aviso.
  register(
    Channels.planningSaveRoteiro,
    SaveRoteiroReq,
    async ({ projectCwd, slug, roteiro, expectedRev }): Promise<PlanningResult<{ roteiro: PlanningRoteiroDto }>> => {
      const saved = await store.saveRoteiro(projectCwd, slug, roteiro, expectedRev)
      notifyPlanningChanged({ projectCwd, slug })
      return { ok: true, roteiro: saved }
    }
  )

  register(Channels.planningSaveLayout, SaveLayoutReq, async ({ projectCwd, slug, layout }): Promise<PlanningResult> => {
    await store.saveLayout(projectCwd, slug, layout)
    return { ok: true }
  })

  register(
    Channels.planningListHandoffs,
    RefReq,
    async ({ projectCwd, slug }): Promise<PlanningResult<{ handoffs: PlanningHandoffDto[] }>> => ({
      ok: true,
      handoffs: await store.listHandoffs(projectCwd, slug)
    })
  )

  // _handoff/ é ignorado pelo vigia e quem grava por aqui é a própria tela,
  // que já sabe o que gravou: nada de planning:changed.
  register(
    Channels.planningWriteHandoff,
    WriteHandoffReq,
    async ({ projectCwd, slug, conteudo }): Promise<PlanningResult<{ name: string }>> => {
      const file = await store.writeHandoff(projectCwd, slug, conteudo)
      return { ok: true, name: path.basename(file) }
    }
  )

  return {
    close(): void {
      releaseSink()
      openers.clear()
      closes.clear()
      watcher.closeAll()
    }
  }
}
