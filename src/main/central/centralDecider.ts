import type { EntryType, Questions } from '@typesafe-ai/sdk'
import { existsSync } from 'node:fs'
import type { CentralRecent, CentralRouteRequest, CentralRouteResult, CentralRule, CentralTarget } from '../../shared/central'
import { SANDBOX_PROJECT_NAME, clipText, type CentralIndex, type CentralProject } from './centralIndex'
import {
  NEW_SANDBOX,
  conversationTarget,
  heuristicOptions,
  newConversation,
  probableOptions,
  sameTarget,
  type ChoiceAnswer,
  type ConversationTarget,
  type ProjectCandidate,
  type RecentCandidate,
  type Trace
} from './centralOptions'
import {
  CENTRAL_PROMPT_LANG,
  NEW_CONVERSATION,
  NO_PROJECT,
  OTHER_SUBJECT,
  Q_CONTINUA,
  Q_CONVERSA,
  Q_PROJETO,
  firstCallRequest,
  secondCallRequest,
  type CentralMessagePrompt,
  type CentralPromptLang
} from './centralPrompts'

/**
 * O decisor da Central: para onde vai uma mensagem, por perguntas tipadas ao
 * TypeSafe (nunca por LLM). Puro fora de `deps`: não importa electron, config
 * nem o cliente do TypeSafe — o IPC passa `askTypeSafe`, a calibração (Etapa 8)
 * passa o dela.
 *
 * 1ª chamada, em leque: `continua` (algum destino recente?) × `projeto` (qual
 * projeto?). 2ª chamada, só dentro do projeto escolhido (ou do sandbox): qual
 * conversa, ou `nova`. Cada passo só vale com confiança ≥ piso; abaixo dele em
 * qualquer passo a resposta é "Para onde vai?" com os destinos mais prováveis.
 * TypeSafe sem resposta, resposta malformada ou fora da lista oferecida = falha:
 * "Para onde vai?" com candidatos de heurística. Nenhuma mensagem se perde.
 * As opções do "Para onde vai?" são montadas em centralOptions.ts.
 */

/** Piso PRÓPRIO da Central (não o `typeSafeMinConfidence()` do Automático, 0,20). A calibração ajusta. */
export const CENTRAL_MIN_CONFIDENCE = 0.6

/** O formato de `askTypeSafe` sem as opções (`askTypeSafe` cabe aqui). `null` = sem decisão. */
export type AskFn = (request: { state: EntryType; questions: Questions }) => Promise<Readonly<Record<string, unknown>> | null>

export interface CentralDeciderDeps {
  ask: AskFn
  /** Padrão: CENTRAL_MIN_CONFIDENCE. */
  floor?: number
  /** Padrão: CENTRAL_PROMPT_LANG. */
  lang?: CentralPromptLang
  /** A pasta existe nesta máquina? Para o destino recente que o índice não tem. Padrão: `fs.existsSync`. */
  exists?: (path: string) => boolean
  /** A pasta é do sandbox? Para o destino recente que o índice não tem. Padrão: não. */
  isSandbox?: (cwd: string) => boolean
}

/** Tudo de `deps` menos o `ask`: o que a heurística usa. */
export type CentralFallbackDeps = Omit<CentralDeciderDeps, 'ask'>

const MAX_RECENTS = 5
/** Mesmo teto do IPC: o harness pode chamar sem passar por ele. */
const MESSAGE_MAX_CHARS = 20_000
const MAX_ATTACHMENTS = 20
/** Mesmo critério de `isCentralConversation` (shared/central.ts), por dado literal: a Central nunca é destino. */
const CENTRAL_ID = 'central'

type Direct = Extract<CentralRouteResult, { kind: 'direct' }>
type Step = Direct | { kind: 'low' } | { kind: 'failed' }
const LOW: Step = { kind: 'low' }
const FAILED: Step = { kind: 'failed' }

interface Context {
  message: CentralMessagePrompt
  floor: number
  lang: CentralPromptLang
  forceAsk: boolean
  exclude?: CentralTarget
  /** Recentes válidos (sem a Central, sem repetir), antes de tirar o excluído. */
  valid: RecentCandidate[]
  /** Os oferecidos: os válidos sem o excluído, até 5, com as chaves d1… */
  recents: RecentCandidate[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unit = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

/** O nome da pasta: a última parte do caminho (\ ou /). */
const folderName = (cwd: string): string => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd

const label = (t: ConversationTarget): string => t.title || t.project

const direct = (target: CentralTarget, rule: CentralRule, confidence: number, why: string): Direct => ({
  kind: 'direct',
  target,
  rule,
  confidence,
  why
})

/** O destino de um recente: do índice; sem ele, do cwd/título da tela, se a pasta existe. */
function recentTarget(
  recent: CentralRecent,
  index: CentralIndex | null,
  exists: (path: string) => boolean,
  isSandbox: (cwd: string) => boolean
): ConversationTarget | null {
  const summary = index?.byId.get(recent.convId)
  if (summary) return conversationTarget(summary)
  const cwd = typeof recent.cwd === 'string' ? recent.cwd.trim() : ''
  if (!cwd) return null
  try {
    if (!exists(cwd)) return null
  } catch {
    return null
  }
  let sandbox = false
  try {
    sandbox = Boolean(isSandbox(cwd))
  } catch {
    sandbox = false
  }
  return {
    kind: 'conversation',
    convId: recent.convId,
    cwd,
    project: sandbox ? SANDBOX_PROJECT_NAME : folderName(cwd),
    title: clipText(recent.title ?? ''),
    sandbox
  }
}

/** O pedido normalizado (o IPC já validou; o harness pode não ter) e os recentes resolvidos. */
function context(req: CentralRouteRequest, index: CentralIndex | null, deps: CentralFallbackDeps): Context {
  const exists = deps.exists ?? existsSync
  const isSandbox = deps.isSandbox ?? (() => false)
  const exclude = isRecord(req?.exclude) ? req.exclude : undefined
  const valid: RecentCandidate[] = []
  const seen = new Set<string>()
  for (const recent of Array.isArray(req?.recent) ? req.recent : []) {
    if (!isRecord(recent) || typeof recent.convId !== 'string' || !recent.convId) continue
    if (recent.convId === CENTRAL_ID || seen.has(recent.convId)) continue
    const target = recentTarget(recent, index, exists, isSandbox)
    if (!target) continue
    seen.add(recent.convId)
    valid.push({ option: '', target, request: clipText(recent.request), replyStart: clipText(recent.replyStart) })
  }
  const recents = valid
    .filter((r) => !exclude || !sameTarget(r.target, exclude))
    .slice(0, MAX_RECENTS)
    .map((r, i) => ({ ...r, option: `d${i + 1}` }))
  return {
    message: {
      text: typeof req?.text === 'string' ? req.text.slice(0, MESSAGE_MAX_CHARS) : '',
      attachments: (Array.isArray(req?.attachments) ? req.attachments : [])
        .filter((name): name is string => typeof name === 'string')
        .slice(0, MAX_ATTACHMENTS)
    },
    floor: typeof deps.floor === 'number' && Number.isFinite(deps.floor) ? deps.floor : CENTRAL_MIN_CONFIDENCE,
    lang: deps.lang ?? CENTRAL_PROMPT_LANG,
    forceAsk: req?.forceAsk === true,
    exclude,
    valid,
    recents
  }
}

/** Uma resposta `choice` só vale se é bem formada e aponta uma chave OFERECIDA. */
function readChoice(answers: Readonly<Record<string, unknown>>, name: string, offered: readonly string[]): ChoiceAnswer | null {
  const answer = answers[name]
  if (!isRecord(answer) || answer.type !== 'choice') return null
  if (typeof answer.choice !== 'string' || !offered.includes(answer.choice)) return null
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) return null
  if (!isRecord(answer.probabilities)) return null
  const probabilities = new Map<string, number>()
  for (const key of offered) probabilities.set(key, unit(answer.probabilities[key]))
  return { choice: answer.choice, confidence: unit(answer.confidence), probabilities }
}

/** Os títulos recentes do projeto sem a conversa excluída (o critério do índice: 5 conversas, título vazio fora). */
function projectTitles(project: CentralProject, excludedConvId: string | undefined): string[] {
  if (!excludedConvId || !project.conversations.some((c) => c.convId === excludedConvId)) return project.recentTitles
  return project.conversations
    .filter((c) => c.convId !== excludedConvId)
    .slice(0, 5)
    .map((c) => c.title)
    .filter((title) => title !== '')
}

const excludedConvId = (ctx: Context): string | undefined =>
  ctx.exclude?.kind === 'conversation' ? ctx.exclude.convId : undefined

const minOf = (values: number[]): number => (values.length > 0 ? Math.min(...values) : 1)

/** As duas chamadas e as regras 1–4. */
async function resolve(ctx: Context, deps: CentralDeciderDeps, index: CentralIndex, trace: Trace): Promise<Step> {
  const excluded = excludedConvId(ctx)
  const candidates = index.projects.filter((p) => !p.sandbox).map((project, i) => ({ option: `p${i + 1}`, project }))
  const first = firstCallRequest(
    ctx.message,
    ctx.recents.map((r) => ({ option: r.option, project: r.target.project, title: r.target.title, request: r.request, replyStart: r.replyStart })),
    candidates.map((c) => ({ option: c.option, name: c.project.name, recentTitles: projectTitles(c.project, excluded) })),
    ctx.lang
  )
  trace.projects = candidates.slice(0, first.projects.length)

  if (first.request) {
    const answers = await deps.ask(first.request)
    if (!answers) return FAILED
    if (ctx.recents.length > 0) {
      trace.continua = readChoice(answers, Q_CONTINUA, [...ctx.recents.map((r) => r.option), OTHER_SUBJECT]) ?? undefined
      if (!trace.continua) return FAILED
    }
    if (trace.projects.length > 0) {
      trace.projeto = readChoice(answers, Q_PROJETO, [...trace.projects.map((p) => p.option), NO_PROJECT]) ?? undefined
      if (!trace.projeto) return FAILED
    }
  }

  const gates: number[] = []
  const { continua, projeto } = trace
  if (continua) {
    if (continua.confidence < ctx.floor) return LOW
    const recent = ctx.recents.find((r) => r.option === continua.choice)
    if (recent) return direct(recent.target, 'continua', continua.confidence, `continua “${label(recent.target)}”`)
    gates.push(continua.confidence)
  }
  // Sem projeto nenhum para escolher, o assunto novo é do sandbox.
  let scope: ProjectCandidate | null = null
  if (projeto) {
    if (projeto.confidence < ctx.floor) return LOW
    gates.push(projeto.confidence)
    scope = trace.projects.find((p) => p.option === projeto.choice) ?? null
  }
  return resolveInScope(ctx, deps, index, scope, gates, trace)
}

/** 2ª chamada: só as conversas do projeto escolhido (ou do sandbox) + `nova`. */
async function resolveInScope(
  ctx: Context,
  deps: CentralDeciderDeps,
  index: CentralIndex,
  scope: ProjectCandidate | null,
  gates: number[],
  trace: Trace
): Promise<Step> {
  const group = scope ? scope.project : index.projects.find((p) => p.sandbox)
  const newTarget = scope ? newConversation(scope.project) : NEW_SANDBOX
  const newRule: CentralRule = scope ? 'nova' : 'sandbox'
  const newWhy = scope ? `assunto novo em ${scope.project.name}` : 'sem projeto'
  const excluded = excludedConvId(ctx)
  const candidates = (group?.conversations ?? [])
    .filter((c) => c.convId !== excluded)
    .map((summary, i) => ({ option: `c${i + 1}`, summary }))
  const call = secondCallRequest(
    ctx.message,
    { project: scope ? scope.project.name : SANDBOX_PROJECT_NAME, sandbox: !scope },
    candidates.map((c) => ({
      option: c.option,
      title: c.summary.title,
      firstRequest: c.summary.firstRequest,
      lastRequests: c.summary.lastRequests,
      files: c.summary.files,
      answerStart: c.summary.answerStart
    })),
    ctx.lang
  )
  // Nenhuma conversa para retomar: o assunto novo é o único destino possível.
  if (!call.request) return direct(newTarget, newRule, minOf(gates), newWhy)

  const items = candidates.slice(0, call.conversations.length).map((c) => ({ option: c.option, target: conversationTarget(c.summary) }))
  const answers = await deps.ask(call.request)
  if (!answers) return FAILED
  const answer = readChoice(answers, Q_CONVERSA, [...items.map((i) => i.option), NEW_CONVERSATION])
  if (!answer) return FAILED
  trace.second = { scopeOption: scope ? scope.option : NO_PROJECT, items, newTarget, answer }

  if (answer.confidence < ctx.floor) return LOW
  const confidence = minOf([...gates, answer.confidence])
  if (answer.choice === NEW_CONVERSATION) return direct(newTarget, newRule, confidence, newWhy)
  const picked = items.find((i) => i.option === answer.choice)
  if (!picked) return FAILED
  return scope
    ? direct(picked.target, 'conversa-antiga', confidence, `retoma “${label(picked.target)}”`)
    : direct(picked.target, 'sandbox', confidence, `continua “${label(picked.target)}” no sandbox`)
}

function askFrom(ctx: Context, trace: Trace, reason: 'low-confidence' | 'moved'): CentralRouteResult {
  const options = probableOptions(trace, ctx.exclude)
  return options[0]?.probability !== undefined ? { kind: 'ask', options, reason, best: 0 } : { kind: 'ask', options, reason }
}

const fallback = (ctx: Context): CentralRouteResult => ({
  kind: 'ask',
  options: heuristicOptions(ctx.recents, ctx.valid[0]?.target, ctx.exclude),
  reason: ctx.forceAsk ? 'moved' : 'typesafe-failed'
})

/**
 * "Para onde vai?" sem perguntar nada (TypeSafe desligado ou sem chave): a mesma
 * heurística da falha. `index` null = só o que a tela mandou (cwd/título).
 */
export function fallbackRoute(req: CentralRouteRequest, index: CentralIndex | null, deps: CentralFallbackDeps = {}): CentralRouteResult {
  return fallback(context(req, index, deps))
}

/**
 * Para onde vai a mensagem. `index` null = o índice não carregou (heurística sem
 * chamar o TypeSafe). Nunca lança. Nunca registra o `state` nem as respostas.
 */
export async function decideRoute(
  req: CentralRouteRequest,
  index: CentralIndex | null,
  deps: CentralDeciderDeps
): Promise<CentralRouteResult> {
  const ctx = context(req, index, deps)
  if (!index) return fallback(ctx)
  const trace: Trace = { recents: ctx.recents, projects: [] }
  let step: Step
  try {
    step = await resolve(ctx, deps, index, trace)
  } catch (error) {
    // O `ask` do app nunca lança; um injetado (ou um defeito aqui) cai na heurística. Só a mensagem.
    console.error(`[central] decisão descartada: ${(error as Error)?.message ?? error}`)
    step = FAILED
  }
  if (step.kind === 'failed') return fallback(ctx)
  if (step.kind === 'low') return askFrom(ctx, trace, ctx.forceAsk ? 'moved' : 'low-confidence')
  if (ctx.forceAsk || (ctx.exclude && sameTarget(step.target, ctx.exclude))) return askFrom(ctx, trace, 'moved')
  return step
}
