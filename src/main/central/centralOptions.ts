import type { CentralOption, CentralTarget } from '../../shared/central'
import type { CentralConversationSummary, CentralProject } from './centralIndex'
import { NEW_CONVERSATION, NO_PROJECT, OTHER_SUBJECT } from './centralPrompts'

/**
 * Os destinos do decisor (centralDecider.ts) e as opções do "Para onde vai?".
 * Puro. Com respostas do TypeSafe, as opções saem das probabilidades delas; sem
 * resposta (TypeSafe fora ou desligado), de uma heurística sobre os recentes.
 */

export type ConversationTarget = Extract<CentralTarget, { kind: 'conversation' }>

export const NEW_SANDBOX: CentralTarget = { kind: 'new-sandbox' }
/** Destinos prováveis no "Para onde vai?", fora "nova em <projeto>" e o sandbox. */
const MAX_PROBABLE = 3
const MAX_HEURISTIC_RECENTS = 3

/** Um destino recente oferecido ao `continua` (chave d1…; textos já cortados). */
export interface RecentCandidate {
  option: string
  target: ConversationTarget
  request: string
  replyStart: string
}

/** Um projeto oferecido ao `projeto` (chave p1…). */
export interface ProjectCandidate {
  option: string
  project: CentralProject
}

/** Uma resposta `choice` validada; `probabilities` só tem as chaves oferecidas. */
export interface ChoiceAnswer {
  choice: string
  confidence: number
  probabilities: Map<string, number>
}

/** O que foi perguntado e respondido numa decisão: as opções do "Para onde vai?" saem daqui. */
export interface Trace {
  recents: RecentCandidate[]
  projects: ProjectCandidate[]
  continua?: ChoiceAnswer
  projeto?: ChoiceAnswer
  second?: {
    /** A opção do 1º passo que levou a esta chamada (`pN` ou `sem_projeto`). */
    scopeOption: string
    items: { option: string; target: ConversationTarget }[]
    newTarget: CentralTarget
    answer: ChoiceAnswer
  }
}

/** O mesmo destino: conversa pelo id, conversa nova pela pasta, sandbox novo pelo tipo. */
export function sameTarget(a: CentralTarget, b: CentralTarget): boolean {
  if (a.kind === 'conversation') return b.kind === 'conversation' && a.convId === b.convId
  if (a.kind === 'new-conversation') return b.kind === 'new-conversation' && a.cwd === b.cwd
  return b.kind === 'new-sandbox'
}

const targetKey = (t: CentralTarget): string =>
  t.kind === 'conversation' ? `c:${t.convId}` : t.kind === 'new-conversation' ? `n:${t.cwd}` : 's'

export const conversationTarget = (s: CentralConversationSummary): ConversationTarget => ({
  kind: 'conversation',
  convId: s.convId,
  cwd: s.cwd,
  project: s.project,
  title: s.title,
  sandbox: s.sandbox
})

export const newConversation = (project: { cwd: string; name: string }): CentralTarget => ({
  kind: 'new-conversation',
  cwd: project.cwd,
  project: project.name
})

/** Probabilidade decrescente; sem probabilidade por último; empate mantém a ordem (sort estável). */
const byProbability = (options: CentralOption[]): CentralOption[] =>
  [...options].sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1))

/** O projeto mais provável na resposta do `projeto` que não seja o excluído. */
function mostProbableProject(trace: Trace, exclude: CentralTarget | undefined): ProjectCandidate | null {
  if (!trace.projeto) return null
  let best: ProjectCandidate | null = null
  let bestP = -1
  for (const candidate of trace.projects) {
    if (exclude && sameTarget(newConversation(candidate.project), exclude)) continue
    const p = trace.projeto.probabilities.get(candidate.option) ?? 0
    if (p > bestP) {
      best = candidate
      bestP = p
    }
  }
  return best
}

/**
 * "Para onde vai?" a partir das respostas: os 3 destinos mais prováveis + "nova
 * em <projeto mais provável>" + sandbox novo, sem repetir, por probabilidade.
 * As probabilidades das perguntas se encadeiam: chegar a uma conversa da 2ª
 * chamada é P(outro assunto) × P(projeto) × P(conversa) — assim um recente e uma
 * conversa da 2ª chamada ficam na mesma escala, e o mesmo destino pelos dois
 * caminhos soma. Pergunta que não foi feita conta 1; sem pergunta nenhuma, sem
 * probabilidade.
 */
export function probableOptions(trace: Trace, exclude?: CentralTarget): CentralOption[] {
  const { continua, projeto, second } = trace
  const excluded = (target: CentralTarget): boolean => Boolean(exclude && sameTarget(target, exclude))
  const pOther = continua ? (continua.probabilities.get(OTHER_SUBJECT) ?? 0) : 1
  const pScope = (option: string): number => (projeto ? (projeto.probabilities.get(option) ?? 0) : 1)

  const pool = new Map<string, CentralOption>()
  const add = (target: CentralTarget, probability: number): void => {
    if (excluded(target)) return
    const known = pool.get(targetKey(target))
    pool.set(targetKey(target), { target, probability: Math.min(1, (known?.probability ?? 0) + probability) })
  }
  if (continua) for (const r of trace.recents) add(r.target, continua.probabilities.get(r.option) ?? 0)
  if (second) {
    const path = pOther * pScope(second.scopeOption)
    for (const item of second.items) add(item.target, path * (second.answer.probabilities.get(item.option) ?? 0))
    add(second.newTarget, path * (second.answer.probabilities.get(NEW_CONVERSATION) ?? 0))
  }

  const options = byProbability([...pool.values()]).slice(0, MAX_PROBABLE)
  const extra = (target: CentralTarget, probability: number | undefined): void => {
    if (excluded(target) || options.some((o) => sameTarget(o.target, target))) return
    const known = pool.get(targetKey(target))
    options.push(known ?? (probability === undefined ? { target } : { target, probability }))
  }
  const top = mostProbableProject(trace, exclude)
  if (top) extra(newConversation(top.project), pOther * pScope(top.option))
  extra(NEW_SANDBOX, continua || projeto ? pOther * pScope(NO_PROJECT) : undefined)
  return byProbability(options)
}

/**
 * Heurística sem TypeSafe: até 3 recentes (o mais recente primeiro), conversa
 * nova no projeto do último destino (fora do sandbox) e sandbox novo. O último
 * destino conta mesmo excluído: "não era nesta conversa" não tira o projeto dela.
 */
export function heuristicOptions(
  recents: readonly RecentCandidate[],
  lastDestination: ConversationTarget | undefined,
  exclude?: CentralTarget
): CentralOption[] {
  const options: CentralOption[] = []
  const add = (target: CentralTarget): void => {
    if (exclude && sameTarget(target, exclude)) return
    if (options.some((o) => sameTarget(o.target, target))) return
    options.push({ target })
  }
  for (const recent of recents.slice(0, MAX_HEURISTIC_RECENTS)) add(recent.target)
  if (lastDestination && !lastDestination.sandbox) add(newConversation({ cwd: lastDestination.cwd, name: lastDestination.project }))
  add(NEW_SANDBOX)
  return options
}
