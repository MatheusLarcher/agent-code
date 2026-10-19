import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { ChatEvent, RemoteConversationAction, RemoteStatePayload } from '../../shared/ipc'
import { isValidMediaName, mediaKindOf } from '../../shared/planningMedia'
import {
  MAX_REMOTE_HANDOFF_PROMPTS,
  MAX_REMOTE_PLAN_PEDIDO,
  PLANNING_BRIDGE_CONV,
  type PlanningChangedEvent,
  type RemotePlan,
  type RemotePlanHandoffs,
  type RemotePlanningErrorCode,
  type RemotePlanningFailure,
  type RemotePlanSummary
} from '../../shared/planningRemote'
import { planEnviosOf, planProgress, roteiroProgress } from '../../shared/stepProgress'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import { listHandoffs } from '../planning/handoffFiles'
import { HandoffFileName, readHandoffsSent } from '../planning/handoffSent'
import { discardStaleHandoffs, findStaleHandoffs, planLastChange } from '../planning/handoffStale'
import { notifyPlanningChanged, onPlanningChanged } from '../planning/planningEvents'
import { toPlanningFailure } from '../planning/planningIpc'
import * as realMedia from '../planning/planningMedia'
import { isValidName, type RoteiroStage } from '../planning/planningModel'
import * as realStore from '../planning/planningStore'

/**
 * Rotas /api/planning/* da ponte do celular (contrato em shared/planningRemote.ts).
 * Lê direto do store de planejamento do main — o mesmo do planningIpc — e só
 * serve planos de projetos que o PC conhece (os do retrato publicado pelo
 * renderer). Não há rota de escrita de card: no celular quem mexe nos cards é
 * o Agent Manager. "Novo planejamento" vira uma RemoteConversationAction
 * `plan`, que o renderer executa com o startOfficePlan; "Enviar para
 * implementação" vira `handoff` (o startHandoff da Tela de Planejamento) e
 * "Gerar prompts", `handoff-generate` (o managerHandoffRequest ao Manager).
 * "Descartar os antigos" chama o mesmo discardStaleHandoffs do planningIpc.
 * Na lista, as etapas de um plano já enviado contam a implementação, lida dos
 * envios no banco (planEtapasProgress).
 */

export interface PlanningBridgeStore {
  listPlans: typeof realStore.listPlans
  openPlan: typeof realStore.openPlan
  listMedia: typeof realMedia.listMedia
  readMedia: typeof realMedia.readMedia
  /** Última modificação do plano (roteiro e cards), em ms: a ordem da lista do celular. */
  planLastChange?: typeof planLastChange
  /** Os prompts de _handoff/ (pendentes e enviados). Padrão: readRemoteHandoffs. */
  handoffs?: (cwd: string, slug: string) => Promise<RemotePlanHandoffs>
  discardHandoffs?: typeof discardStaleHandoffs
}

export interface PlanningBridgeCtx {
  /** O retrato publicado pelo renderer: de onde saem os projetos conhecidos. */
  state: RemoteStatePayload
  onConversationAction?: (action: RemoteConversationAction) => void
  store?: PlanningBridgeStore
  isDirectory?: (p: string) => Promise<boolean>
  /** Os envios de handoff do projeto (de qualquer conversa), para o progresso da
   *  implementação na lista. Padrão: o banco do app; lança sem ele. */
  envios?: (cwd: string) => Promise<HandoffEnvio[]>
}

async function defaultEnvios(cwd: string): Promise<HandoffEnvio[]> {
  // Sob demanda: o lifecycle carrega os bancos (node:sqlite, Electron) só quando a lista pede.
  const { storageLifecycle } = await import('../persistence/lifecycle')
  const repo = storageLifecycle.repository()
  const { projectId } = await resolveProjectIdentity(cwd)
  return repo.listHandoffEnvios({ projectIds: [projectId], limit: 1000 })
}

const defaultStore: PlanningBridgeStore = {
  listPlans: realStore.listPlans,
  openPlan: realStore.openPlan,
  listMedia: realMedia.listMedia,
  readMedia: realMedia.readMedia,
  planLastChange
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
const HandoffSendReq = z.strictObject({
  cwd: Cwd,
  slug: Slug,
  names: z.array(HandoffFileName).min(1).max(MAX_REMOTE_HANDOFF_PROMPTS),
  override: z.boolean().optional()
})
const HandoffGenerateReq = z.strictObject({ cwd: Cwd, slug: Slug, override: z.boolean().optional() })

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

/**
 * O "N/M" da lista (shared/stepProgress, a regra das telas do PC): com envios,
 * a IMPLEMENTAÇÃO — prontas de total pela posição no plano (planProgress com o
 * roteiro); sem, a ESPECIFICAÇÃO do roteiro (roteiroProgress: especificadas de
 * total), nunca as duas misturadas. `fonte` diz qual das duas, para o celular
 * escrever "prontas" ou "especificadas".
 */
export function planEtapasProgress(roteiro: readonly RoteiroStage[], planEnvios: readonly HandoffEnvio[]): RemotePlanSummary['etapas'] {
  if (planEnvios.length > 0) {
    const p = planProgress(planEnvios, roteiro)
    return { total: p.total, concluidas: p.prontas, fonte: 'implementacao' }
  }
  const r = roteiroProgress(roteiro)
  return { total: r.total, concluidas: r.feitas, fonte: 'especificacao' }
}

async function summary(store: PlanningBridgeStore, cwd: string, slug: string, planEnvios: HandoffEnvio[]): Promise<RemotePlanSummary> {
  try {
    const p = await store.openPlan(cwd, slug)
    // Sem a data (falha de stat), o celular ordena pelo fallback dele.
    const atualizadoEm = await (store.planLastChange ?? planLastChange)(cwd, slug).catch(() => 0)
    return {
      slug,
      titulo: p.roteiro.titulo,
      etapas: planEtapasProgress(p.roteiro.etapas, planEnvios),
      cards: p.cards.length,
      ambiguidadesAbertas: openAmbiguities(p.cards),
      ...(atualizadoEm > 0 ? { atualizadoEm } : {})
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { slug, titulo: slug, etapas: { total: 0, concluidas: 0 }, cards: 0, ambiguidadesAbertas: 0, erro: message }
  }
}

/**
 * Os prompts de _handoff/ como a folha do celular os usa — a mesma leitura do
 * planningListHandoffs (listHandoffs + enviados.json + os antigos): "a enviar"
 * é quem não tem registro em enviados.json; os enviados, só os que foram a
 * uma conversa (substituído ou marcado à mão não interessa ao celular).
 */
export async function readRemoteHandoffs(cwd: string, slug: string): Promise<RemotePlanHandoffs> {
  const [files, sent] = await Promise.all([listHandoffs(cwd, slug), readHandoffsSent(cwd, slug)])
  const sentNames = sent.entries.map((e) => e.nome)
  // Os antigos não derrubam a leitura: sem eles, nada sai marcado como antigo.
  const old = await findStaleHandoffs(cwd, slug, { handoffs: files, sentNames }).catch(() => null)
  const stale = new Set(old?.stale.map((h) => h.name) ?? [])
  const done = new Set(sentNames)
  return {
    pendentes: files
      .filter((h) => !done.has(h.name))
      .map((h) => ({
        name: h.name,
        createdAt: h.createdAt,
        content: h.content,
        ...(h.etapas?.length ? { etapas: h.etapas } : {}),
        ...(stale.has(h.name) ? { antigo: true } : {})
      })),
    enviados: sent.entries.flatMap((e) =>
      e.conversaId ? [{ nome: e.nome, enviadoEm: e.enviadoEm, conversaId: e.conversaId, ...(e.conversaTitulo ? { conversaTitulo: e.conversaTitulo } : {}) }] : []
    )
  }
}

async function plan(store: PlanningBridgeStore, cwd: string, slug: string): Promise<RemotePlan> {
  const p = await store.openPlan(cwd, slug)
  const media = await store.listMedia(cwd, slug)
  // _handoff/ ilegível não tira o plano da tela: a folha avisa que o envio fica no PC.
  const handoffs = await (store.handoffs ?? readRemoteHandoffs)(cwd, slug).catch(
    (err): RemotePlanHandoffs => ({ pendentes: [], enviados: [], erro: err instanceof Error ? err.message : String(err) })
  )
  return {
    slug: p.slug,
    roteiro: p.roteiro,
    cards: p.cards,
    invalid: p.invalid,
    media: media.map(({ name, kind, size, mediaType }) => ({ name, kind, size, mediaType })),
    handoffs
  }
}

const openAmbiguities = (cards: readonly { tipo: string; status?: string }[]): number =>
  cards.filter((c) => c.tipo === 'ambiguidade' && c.status !== 'resolvida').length

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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req)
  if (body === null) throw new BridgeError('invalid', 'corpo grande demais')
  try {
    return JSON.parse(body || 'null')
  } catch {
    throw new BridgeError('invalid', 'JSON inválido')
  }
}

function actionSink(ctx: PlanningBridgeCtx, what: string): (action: RemoteConversationAction) => void {
  if (!ctx.onConversationAction) throw new BridgeError('io', `o PC não aceita ${what} agora`)
  return ctx.onConversationAction
}

const AMBIGUITY_BLOCK = 'há ambiguidade aberta no plano: marque "enviar mesmo assim" para seguir'

async function create(req: IncomingMessage, res: ServerResponse, ctx: PlanningBridgeCtx): Promise<void> {
  const { cwd, pedido } = parse(CreateReq, await readJson(req))
  await assertProject(cwd, ctx)
  const emit = actionSink(ctx, 'criar planejamento')
  const convId = `c-${randomBytes(6).toString('hex')}`
  emit({ type: 'plan', cwd, convId, pedido: (pedido ?? '').trim() })
  sendJson(res, 200, { ok: true, convId })
}

/** "Enviar": só prompts a enviar, na ordem de _handoff/ (a de envio), com o texto lido do disco. */
async function handoffSend(req: IncomingMessage, res: ServerResponse, ctx: PlanningBridgeCtx, store: PlanningBridgeStore): Promise<void> {
  const { cwd, slug, names, override } = parse(HandoffSendReq, await readJson(req))
  await assertProject(cwd, ctx)
  const emit = actionSink(ctx, 'enviar para implementação')
  const p = await store.openPlan(cwd, slug)
  if (openAmbiguities(p.cards) > 0 && !override) throw new BridgeError('invalid', AMBIGUITY_BLOCK)
  if (new Set(names).size !== names.length) throw new BridgeError('invalid', 'prompt repetido no envio')
  const { pendentes } = await (store.handoffs ?? readRemoteHandoffs)(cwd, slug)
  const wanted = new Set(names)
  const missing = names.filter((n) => !pendentes.some((h) => h.name === n))
  if (missing.length > 0) throw new BridgeError('invalid', `prompt que não está a enviar: ${missing.join(', ')}`)
  const prompts = pendentes.filter((h) => wanted.has(h.name)).map((h) => ({ name: h.name, text: h.content }))
  emit({ type: 'handoff', cwd, slug, titulo: p.roteiro.titulo.trim() || slug, prompts })
  sendJson(res, 200, { ok: true })
}

/** "Gerar prompts": o que o pedido ao Manager precisa saber do plano (a pasta absoluta, ambiguidades, mídias). */
async function handoffGenerate(req: IncomingMessage, res: ServerResponse, ctx: PlanningBridgeCtx, store: PlanningBridgeStore): Promise<void> {
  const { cwd, slug, override } = parse(HandoffGenerateReq, await readJson(req))
  await assertProject(cwd, ctx)
  const emit = actionSink(ctx, 'gerar os prompts')
  const p = await store.openPlan(cwd, slug)
  const abertas = openAmbiguities(p.cards)
  if (abertas > 0 && !override) throw new BridgeError('invalid', AMBIGUITY_BLOCK)
  const media = await store.listMedia(cwd, slug)
  emit({ type: 'handoff-generate', cwd, slug, planDir: p.dir, openAmbiguities: override ? abertas : 0, mediaCount: media.length })
  sendJson(res, 200, { ok: true })
}

/** "Descartar os antigos" (o celular já perguntou): só MOVE os antigos não enviados para _handoff/_descartados/. */
async function handoffDiscard(req: IncomingMessage, res: ServerResponse, ctx: PlanningBridgeCtx, store: PlanningBridgeStore): Promise<void> {
  const { cwd, slug } = parse(PlanReq, await readJson(req))
  await assertProject(cwd, ctx)
  await store.openPlan(cwd, slug) // plano inexistente → not_found
  const discarded = await (store.discardHandoffs ?? discardStaleHandoffs)(cwd, slug)
  // A Tela do PC (e o celular, pelo SSE) relê _handoff/.
  if (discarded.length > 0) notifyPlanningChanged({ projectCwd: cwd, slug })
  sendJson(res, 200, { ok: true, discarded })
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
      const slugs = await store.listPlans(cwd)
      // Uma leitura dos envios por lista; sem banco, cada plano sai com a especificação.
      const envios = slugs.length > 0 ? await (ctx.envios ?? defaultEnvios)(cwd).catch((): HandoffEnvio[] => []) : []
      for (const slug of slugs) plans.push(await summary(store, cwd, slug, planEnviosOf(envios, cwd, slug)))
      return sendJson(res, 200, { ok: true, plans })
    }
    if (route === '/api/planning/plan' && get) {
      const { cwd, slug } = parse(PlanReq, query(url, ['cwd', 'slug']))
      await assertProject(cwd, ctx)
      return sendJson(res, 200, { ok: true, plan: await plan(store, cwd, slug) })
    }
    if (route === '/api/planning/media' && get) return await media(url, res, ctx, store)
    const post = req.method === 'POST'
    if (route === '/api/planning/create' && post) return await create(req, res, ctx)
    if (route === '/api/planning/handoff' && post) return await handoffSend(req, res, ctx, store)
    if (route === '/api/planning/handoff-generate' && post) return await handoffGenerate(req, res, ctx, store)
    if (route === '/api/planning/handoff-discard' && post) return await handoffDiscard(req, res, ctx, store)
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
