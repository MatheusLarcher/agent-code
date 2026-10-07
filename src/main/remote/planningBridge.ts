import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import type { ChatEvent, RemoteConversationAction, RemoteStatePayload } from '../../shared/ipc'
import { isValidMediaName, mediaKindOf } from '../../shared/planningMedia'
import {
  MAX_REMOTE_PLAN_PEDIDO,
  PLANNING_BRIDGE_CONV,
  type PlanningChangedEvent,
  type RemotePlan,
  type RemotePlanningErrorCode,
  type RemotePlanningFailure,
  type RemotePlanSummary
} from '../../shared/planningRemote'
import { onPlanningChanged } from '../planning/planningEvents'
import { toPlanningFailure } from '../planning/planningIpc'
import * as realMedia from '../planning/planningMedia'
import { isValidName } from '../planning/planningModel'
import * as realStore from '../planning/planningStore'

/**
 * Rotas /api/planning/* da ponte do celular (contrato em shared/planningRemote.ts).
 * Lê direto do store de planejamento do main — o mesmo do planningIpc — e só
 * serve planos de projetos que o PC conhece (os do retrato publicado pelo
 * renderer). Não há rota de escrita de card: no celular quem mexe nos cards é
 * o Agent Manager. "Novo planejamento" vira uma RemoteConversationAction
 * `plan`, que o renderer executa com o startOfficePlan.
 */

export interface PlanningBridgeStore {
  listPlans: typeof realStore.listPlans
  openPlan: typeof realStore.openPlan
  listMedia: typeof realMedia.listMedia
  readMedia: typeof realMedia.readMedia
}

export interface PlanningBridgeCtx {
  /** O retrato publicado pelo renderer: de onde saem os projetos conhecidos. */
  state: RemoteStatePayload
  onConversationAction?: (action: RemoteConversationAction) => void
  store?: PlanningBridgeStore
  isDirectory?: (p: string) => Promise<boolean>
}

const defaultStore: PlanningBridgeStore = {
  listPlans: realStore.listPlans,
  openPlan: realStore.openPlan,
  listMedia: realMedia.listMedia,
  readMedia: realMedia.readMedia
}

const STATUS: Record<RemotePlanningErrorCode, number> = { invalid: 400, unknown_project: 403, not_found: 404, io: 500 }
const MAX_BODY = 256 * 1024

const Cwd = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), 'cwd deve ser caminho absoluto')
const Slug = z.string().refine(isValidName, 'slug: use [a-z0-9-], de 1 a 64 caracteres')
const ListReq = z.strictObject({ cwd: Cwd })
const PlanReq = z.strictObject({ cwd: Cwd, slug: Slug })
const MediaReq = z.strictObject({ cwd: Cwd, slug: Slug, name: z.string().refine(isValidMediaName, 'nome de mídia inválido') })
const CreateReq = z.strictObject({ cwd: Cwd, pedido: z.string().max(MAX_REMOTE_PLAN_PEDIDO).optional() })

class BridgeError extends Error {
  constructor(
    readonly code: RemotePlanningErrorCode,
    message: string
  ) {
    super(message)
  }
}

function fail(res: ServerResponse, code: RemotePlanningErrorCode, message: string): void {
  sendJson(res, STATUS[code], { ok: false, code, message } satisfies RemotePlanningFailure)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const msg = r.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
  throw new BridgeError('invalid', msg)
}

/** Só pastas que o PC já conhece (as mesmas do "nova conversa" do celular). */
export function knownProjects(state: RemoteStatePayload): Set<string> {
  return new Set<string>([...(state.projects ?? []), ...state.conversations.map((c) => c.cwd)].filter(Boolean))
}

async function defaultIsDirectory(p: string): Promise<boolean> {
  return fs.stat(p).then(
    (s) => s.isDirectory(),
    () => false
  )
}

async function assertProject(cwd: string, ctx: PlanningBridgeCtx): Promise<void> {
  if (!knownProjects(ctx.state).has(cwd)) throw new BridgeError('unknown_project', 'projeto desconhecido')
  if (!(await (ctx.isDirectory ?? defaultIsDirectory)(cwd))) throw new BridgeError('not_found', 'pasta do projeto não encontrada')
}

/** A query como objeto (só os parâmetros da rota; token/dev são da ponte). */
function query(url: URL, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = url.searchParams.get(k)
    if (v !== null) out[k] = v
  }
  return out
}

async function summary(store: PlanningBridgeStore, cwd: string, slug: string): Promise<RemotePlanSummary> {
  try {
    const p = await store.openPlan(cwd, slug)
    return {
      slug,
      titulo: p.roteiro.titulo,
      etapas: { total: p.roteiro.etapas.length, concluidas: p.roteiro.etapas.filter((e) => e.status === 'concluida').length },
      cards: p.cards.length,
      ambiguidadesAbertas: p.cards.filter((c) => c.tipo === 'ambiguidade' && c.status !== 'resolvida').length
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { slug, titulo: slug, etapas: { total: 0, concluidas: 0 }, cards: 0, ambiguidadesAbertas: 0, erro: message }
  }
}

async function plan(store: PlanningBridgeStore, cwd: string, slug: string): Promise<RemotePlan> {
  const p = await store.openPlan(cwd, slug)
  const media = await store.listMedia(cwd, slug)
  return {
    slug: p.slug,
    roteiro: p.roteiro,
    cards: p.cards,
    invalid: p.invalid,
    media: media.map(({ name, kind, size, mediaType }) => ({ name, kind, size, mediaType }))
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = ''
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      data += chunk.toString()
      if (data.length > MAX_BODY) {
        over = true
        resolve(null)
      }
    })
    req.on('end', () => resolve(over ? null : data))
    req.on('error', () => resolve(over ? null : data))
  })
}

async function create(req: IncomingMessage, res: ServerResponse, ctx: PlanningBridgeCtx): Promise<void> {
  const body = await readBody(req)
  if (body === null) throw new BridgeError('invalid', 'corpo grande demais')
  let json: unknown
  try {
    json = JSON.parse(body || 'null')
  } catch {
    throw new BridgeError('invalid', 'JSON inválido')
  }
  const { cwd, pedido } = parse(CreateReq, json)
  await assertProject(cwd, ctx)
  if (!ctx.onConversationAction) throw new BridgeError('io', 'o PC não aceita criar planejamento agora')
  const convId = `c-${randomBytes(6).toString('hex')}`
  ctx.onConversationAction({ type: 'plan', cwd, convId, pedido: (pedido ?? '').trim() })
  sendJson(res, 200, { ok: true, convId })
}

async function media(url: URL, res: ServerResponse, ctx: PlanningBridgeCtx, store: PlanningBridgeStore): Promise<void> {
  const { cwd, slug, name } = parse(MediaReq, query(url, ['cwd', 'slug', 'name']))
  await assertProject(cwd, ctx)
  if (mediaKindOf(name) !== 'imagem') throw new BridgeError('invalid', 'só imagens são servidas ao celular')
  // readMedia: nome saneado + resolvePlanPath (symlink/junção para fora é recusado) + lstat de arquivo comum.
  const m = await store.readMedia(cwd, slug, name)
  const bytes = Buffer.from(m.base64, 'base64')
  res.writeHead(200, {
    'Content-Type': m.mediaType,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    // SVG aberto direto não roda script.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  })
  res.end(bytes)
}

/** Despacho das rotas /api/planning/* (chamado pelo RemoteServer, já autenticado). */
export async function servePlanningRoute(
  route: string,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  ctx: PlanningBridgeCtx
): Promise<void> {
  const store = ctx.store ?? defaultStore
  const get = req.method === 'GET'
  try {
    if (route === '/api/planning/list' && get) {
      const { cwd } = parse(ListReq, query(url, ['cwd']))
      await assertProject(cwd, ctx)
      const plans: RemotePlanSummary[] = []
      for (const slug of await store.listPlans(cwd)) plans.push(await summary(store, cwd, slug))
      return sendJson(res, 200, { ok: true, plans })
    }
    if (route === '/api/planning/plan' && get) {
      const { cwd, slug } = parse(PlanReq, query(url, ['cwd', 'slug']))
      await assertProject(cwd, ctx)
      return sendJson(res, 200, { ok: true, plan: await plan(store, cwd, slug) })
    }
    if (route === '/api/planning/media' && get) return await media(url, res, ctx, store)
    if (route === '/api/planning/create' && req.method === 'POST') return await create(req, res, ctx)
    return sendJson(res, 404, { error: 'rota desconhecida' })
  } catch (err) {
    if (err instanceof BridgeError) return fail(res, err.code, err.message)
    // Mesma tradução do planningIpc (PlanNotFound/ENOENT → not_found, validação/caminho → invalid).
    const f = toPlanningFailure(err)
    if (f.code === 'invalid' || f.code === 'not_found') return fail(res, f.code, f.message)
    return fail(res, 'io', err instanceof Error ? err.message : String(err))
  }
}

/** Quem a ponte avisa: o broadcast do RemoteServer (mesmo envelope {convId, event} do chat). */
export interface PlanningEventSink {
  broadcast(convId: string, event: ChatEvent): void
}

/**
 * Liga as mudanças de planejamento (agente e vigia, via planningEvents) ao SSE
 * do celular: `{ convId: 'planning', event: { kind: 'planning-changed', projectCwd, slug } }`.
 * O celular de hoje trata como evento de outra conversa. Devolve o desligar.
 */
export function attachPlanningEvents(remote: PlanningEventSink): () => void {
  return onPlanningChanged(({ projectCwd, slug }) => {
    const event: PlanningChangedEvent = { kind: 'planning-changed', projectCwd, slug }
    // Não é ChatEvent: o broadcast só serializa o envelope (como os office-call).
    remote.broadcast(PLANNING_BRIDGE_CONV, event as unknown as ChatEvent)
  })
}
