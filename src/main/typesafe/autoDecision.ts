import { choice, score, type Questions } from '@typesafe-ai/sdk'
import {
  AUTO_EFFORT,
  AUTO_MODEL,
  AUTO_MODEL_FALLBACK,
  clampEffortToModel,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  isAutoEffort,
  isAutoModel,
  type AutoPrompt,
  type EffortLevel
} from '../../shared/ipc'
import { isEffortLevel } from '../../shared/autoEffort'
import { askTypeSafe, typeSafeMinConfidence, type AskTypeSafeOptions } from './client'
import {
  autoEffortCandidates,
  autoEffortLadder,
  autoModelCandidates,
  AUTO_EFFORT_DESCRIPTIONS,
  AUTO_EFFORT_INSTRUCTION,
  AUTO_MODEL_DESCRIPTIONS,
  AUTO_MODEL_INSTRUCTION,
  AUTO_NO_LIVE_MODEL
} from './autoCatalog'

/**
 * A decisão do Automático: modelo e esforço são DUAS dimensões independentes, e
 * só a que está em Automático é perguntada.
 *
 * | Modelo | Esforço | Pergunta                                              |
 * |--------|---------|-------------------------------------------------------|
 * | auto   | auto    | choice + score numa chamada só; esforço recortado no fim |
 * | auto   | fixo    | só o choice; o esforço fixo passa por clampEffortToModel |
 * | fixo   | auto    | só o score, na escada MODEL_EFFORT desse modelo        |
 * | fixo   | fixo    | nada — nenhuma chamada                                 |
 *
 * Nada aqui lança e nada aqui trava o envio: cada dimensão automática que não
 * foi decidida cai no seu padrão (`AUTO_MODEL_FALLBACK`), porque a mensagem do
 * usuário tem de sair de qualquer jeito.
 */

/** `type`, não `interface`: o `EntryType` do SDK exige assinatura de índice, e
 *  só um alias de tipo a ganha implicitamente. */
export type AutoExecutionState = {
  conversa: { quem: 'usuario' | 'agente'; texto: string }[]
  mensagem_nova: string
  /**
   * O modelo em que esta conversa já está rodando, ou `AUTO_NO_LIVE_MODEL`.
   * Com o modelo fixo, é ele mesmo (é quem vai rodar o esforço perguntado).
   *
   * Está aqui por CUSTO: o cache de prompt da Anthropic é por modelo, e alternar
   * a cada turno chega a custar MAIS do que a economia do turno barato. O campo
   * dá ao modelo a informação que faltava para preferir ficar onde está.
   */
  modelo_atual: string
}

/** O corpo exato que vai ao serviço, mais a escada na ordem em que virou
 *  `score` — o número devolvido INDEXA essa escada. */
export interface AutoExecutionPayload {
  state: AutoExecutionState
  questions: Questions
  ladder: EffortLevel[]
}

/**
 * De onde veio o valor de UMA dimensão automática:
 *
 * - `typesafe`: o serviço decidiu.
 * - `fallback`: havia o que decidir e a decisão não veio (desligado, sem chave,
 *   timeout, erro, resposta inválida). É informação que o usuário precisa ter.
 * - `unprompted`: não havia turno para julgar (Conectar, religar, recuperar) ou
 *   não havia entre o que escolher. Nada foi perguntado, e chamar isso de falha
 *   seria dizer ao usuário que um serviço no ar está fora.
 */
export type AutoExecutionSource = 'typesafe' | 'fallback' | 'unprompted'

/** A origem por dimensão. Só a dimensão AUTOMÁTICA tem origem; a fixa fica
 *  ausente — ninguém a decidiu, foi o usuário. */
export interface AutoSources {
  model?: AutoExecutionSource
  effort?: AutoExecutionSource
}

/** O que a conversa escolheu no seletor: cada campo é o valor fixo ou o
 *  sentinel (AUTO_MODEL / AUTO_EFFORT). Esforço ausente ou inválido = fixo em
 *  "nenhum" (a sessão sobe sem `effort`). */
export interface AutoSelection {
  model: string
  effort?: string
}

/** O padrão: as duas dimensões automáticas (o memorista, o Automático antigo). */
export const AUTO_SELECTION_BOTH: AutoSelection = { model: AUTO_MODEL, effort: AUTO_EFFORT }

/** Um par modelo+esforço concreto. `effort` ausente = modelo sem esforço. */
export interface AutoPair {
  model: string
  effort?: EffortLevel
}

/** O par escolhido para o turno, e de onde veio cada dimensão automática. */
export interface AutoExecution extends AutoPair {
  source: AutoSources
}

/** O que do par vivo pode se defender neste turno (histerese e recuo por
 *  confiança baixa): só a dimensão que o TypeSafe DECIDIU. */
export type AutoLiveDefaults = Partial<AutoPair>

export interface AutoExecutionOptions extends AskTypeSafeOptions {
  /** Os modelos entre os quais escolher. Padrão: a lista do seletor da
   *  conversa. O memorista e o Agent Manager passam a deles. */
  models?: readonly string[]
  /** O que cada dimensão do par vivo pode defender. Ausente = nada. */
  live?: AutoLiveDefaults
  /** Quais dimensões são automáticas. Padrão: as duas. */
  selection?: AutoSelection
}

/** O plano de um turno: o que é fixo, o que é perguntado e a escada. */
interface AutoPlan {
  autoModel: boolean
  autoEffort: boolean
  fixedModel: string
  fixedEffort?: EffortLevel
  askModel: boolean
  /** A escada da dimensão esforço quando ela é automática; vazia = sem esforço. */
  ladder: EffortLevel[]
  askEffort: boolean
}

function autoPlan(selection: AutoSelection, models: readonly string[]): AutoPlan {
  const autoModel = isAutoModel(selection.model)
  const autoEffort = isAutoEffort(selection.effort)
  const ladder = !autoEffort ? [] : autoModel ? autoEffortCandidates() : autoEffortLadder(selection.model)
  return {
    autoModel,
    autoEffort,
    fixedModel: selection.model,
    fixedEffort: !autoEffort && isEffortLevel(selection.effort) ? selection.effort : undefined,
    // Com menos de DOIS candidatos numa dimensão não há escolha a fazer ali.
    askModel: autoModel && models.length >= 2,
    ladder,
    askEffort: autoEffort && ladder.length >= 2
  }
}

/** O modelo padrão dentro de uma lista: o de `AUTO_MODEL_FALLBACK` quando ele
 *  está nela, senão o primeiro — quem restringe a lista não pode vê-la furada. */
function fallbackModel(models: readonly string[]): string {
  return models.includes(AUTO_MODEL_FALLBACK.model) ? AUTO_MODEL_FALLBACK.model : (models[0] ?? AUTO_MODEL_FALLBACK.model)
}

/** Só o que pode se defender: o modelo vivo precisa estar entre os candidatos
 *  (senão furaria a lista) e cada dimensão só vale se for automática. */
function defendable(live: AutoLiveDefaults | undefined, models: readonly string[], plan: AutoPlan): AutoLiveDefaults {
  return {
    ...(plan.autoModel && live?.model && models.includes(live.model) ? { model: live.model } : {}),
    ...(plan.autoEffort && live?.effort ? { effort: live.effort } : {})
  }
}

/**
 * Monta o pedido. `undefined` quando não há nada a perguntar (nenhuma dimensão
 * automática com dois candidatos ou mais): aí não há chamada nenhuma.
 */
export function buildAutoExecutionPayload(
  prompt: AutoPrompt,
  models: readonly string[] = autoModelCandidates(),
  live?: AutoLiveDefaults,
  selection: AutoSelection = AUTO_SELECTION_BOTH
): AutoExecutionPayload | undefined {
  const plan = autoPlan(selection, models)
  if (!plan.askModel && !plan.askEffort) return undefined

  const questions: Record<string, Questions[string]> = {}
  if (plan.askModel) {
    const criteria: Record<string, string | null> = {}
    for (const model of models) criteria[model] = AUTO_MODEL_DESCRIPTIONS[model] ?? null
    questions.which_model = choice(AUTO_MODEL_INSTRUCTION, criteria)
  }
  if (plan.askEffort) {
    // `score`, NÃO `choice`: a escala é ORDENADA e o score devolve a posição
    // ponderada — o meio-termo entre dois níveis é o próprio número. Com
    // `choice`, uma distribuição espalhada virava empate resolvido por argmax.
    questions.which_effort = score(
      AUTO_EFFORT_INSTRUCTION,
      plan.ladder.map((level) => AUTO_EFFORT_DESCRIPTIONS[level]) as [string, string, ...string[]]
    )
  }

  const liveModel = defendable(live, models, plan).model
  return {
    state: {
      conversa: (prompt.history ?? []).map((turn) => ({
        quem: turn.who === 'user' ? ('usuario' as const) : ('agente' as const),
        texto: turn.text
      })),
      mensagem_nova: prompt.message,
      modelo_atual: plan.autoModel ? (liveModel ?? AUTO_NO_LIVE_MODEL) : plan.fixedModel
    },
    questions,
    ladder: plan.askEffort ? plan.ladder : []
  }
}

/**
 * O degrau da escada que o `score` aponta: arredonda para o mais próximo e
 * prende na faixa válida — um score fora da faixa (ou NaN) não pode virar
 * `undefined` no lugar de um nível.
 */
export function effortFromScore(value: number, ladder: readonly EffortLevel[]): EffortLevel {
  if (ladder.length === 0) return DEFAULT_EFFORT
  if (!Number.isFinite(value)) return ladder[Math.min(ladder.length - 1, EFFORT_LEVELS.indexOf(DEFAULT_EFFORT))]
  const index = Math.min(ladder.length - 1, Math.max(0, Math.round(value)))
  return ladder[index]
}

/** A resposta é confiável o bastante para MUDAR o que já está rodando? Abaixo
 *  do piso do usuário (`typeSafeMinConfidence`), a dimensão viva vale mais que
 *  um palpite fraco. Sem confiança declarada, a resposta é aceita. */
function confident(confidence: unknown): boolean {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return true
  return confidence >= typeSafeMinConfidence()
}

type Answers = Record<string, { type?: string; choice?: string; score?: number; confidence?: unknown } | undefined>

/**
 * O par a partir das respostas (ou da falta delas). `outcome` é a origem de uma
 * dimensão automática que não precisou ser perguntada (candidato único): a da
 * chamada, quando houve uma, ou `unprompted`.
 */
function resolvePlan(
  plan: AutoPlan,
  models: readonly string[],
  live: AutoLiveDefaults,
  answers: Answers | null,
  ladder: readonly EffortLevel[],
  outcome: AutoExecutionSource
): AutoExecution {
  const source: AutoSources = {}
  let model = plan.fixedModel
  if (plan.autoModel) {
    const answer = answers?.which_model
    if (!plan.askModel) {
      model = fallbackModel(models)
      source.model = outcome
    } else if (answer?.type === 'choice' && typeof answer.choice === 'string' && models.includes(answer.choice)) {
      // Validado contra a lista OFERECIDA; com confiança abaixo do piso e um
      // modelo vivo decidido, fica no que já está rodando.
      model = live.model && !confident(answer.confidence) ? live.model : answer.choice
      source.model = 'typesafe'
    } else {
      model = fallbackModel(models)
      source.model = 'fallback'
    }
  }

  let effort = plan.fixedEffort
  if (plan.autoEffort && plan.ladder.length > 0) {
    const answer = answers?.which_effort
    if (!plan.askEffort) {
      effort = plan.ladder[0]
      source.effort = outcome
    } else if (answer?.type === 'score' && typeof answer.score === 'number') {
      effort = live.effort && !confident(answer.confidence) ? live.effort : effortFromScore(answer.score, ladder)
      source.effort = 'typesafe'
    } else {
      effort = AUTO_MODEL_FALLBACK.effort
      source.effort = 'fallback'
    }
  }

  // O recorte do par, DEPOIS das duas dimensões: só agora se sabe contra qual
  // teto recortar, e o provedor recusa um par inválido em vez de degradá-lo.
  return { model, ...(effort ? { effort: clampEffortToModel(model, effort) } : {}), source }
}

/** O par padrão, quando havia o que decidir e a decisão não veio. Só as
 *  dimensões automáticas caem no padrão; a fixa continua a do usuário. */
export function autoExecutionFallback(
  models: readonly string[] = autoModelCandidates(),
  selection: AutoSelection = AUTO_SELECTION_BOTH
): AutoExecution {
  return resolvePlan(autoPlan(selection, models), models, {}, null, [], 'fallback')
}

/**
 * O par quando NÃO havia turno para julgar. Mantém o que já estava no ar em
 * cada dimensão automática — trocar o modelo de uma sessão viva por causa de um
 * religar não tem por que acontecer — e cai no padrão só onde não há nada.
 * Nunca anuncia nada: ver `autoExecutionNote`.
 */
export function autoExecutionUnprompted(
  live?: AutoLiveDefaults,
  models: readonly string[] = autoModelCandidates(),
  selection: AutoSelection = AUTO_SELECTION_BOTH
): AutoExecution {
  const plan = autoPlan(selection, models)
  const source: AutoSources = {}
  let model = plan.fixedModel
  if (plan.autoModel) {
    model = live?.model && models.includes(live.model) ? live.model : fallbackModel(models)
    source.model = 'unprompted'
  }
  let effort = plan.fixedEffort
  if (plan.autoEffort && plan.ladder.length > 0) {
    effort = live?.effort ?? AUTO_MODEL_FALLBACK.effort
    source.effort = 'unprompted'
  }
  return { model, ...(effort ? { effort: clampEffortToModel(model, effort) } : {}), source }
}

/**
 * O modelo e o esforço deste turno. NUNCA lança e NUNCA devolve um par
 * inválido nem um sentinel: o esforço é recortado para o que o modelo suporta.
 */
export async function chooseAutoExecution(
  prompt: AutoPrompt,
  options: AutoExecutionOptions = {}
): Promise<AutoExecution> {
  const models = options.models ?? autoModelCandidates()
  const selection = options.selection ?? AUTO_SELECTION_BOTH
  const plan = autoPlan(selection, models)
  try {
    // Nada automático: nada a perguntar, e o par é o do usuário.
    if (!plan.autoModel && !plan.autoEffort) return resolvePlan(plan, models, {}, null, [], 'unprompted')
    // Sem mensagem não há o que julgar — e isso NÃO é uma decisão que falhou.
    if (!prompt.message.trim()) return autoExecutionUnprompted(options.live, models, selection)
    const live = defendable(options.live, models, plan)
    const payload = buildAutoExecutionPayload(prompt, models, live, selection)
    if (!payload) return resolvePlan(plan, models, live, null, [], 'unprompted')

    const answers = (await askTypeSafe({ state: payload.state, questions: payload.questions }, options)) as Answers | null
    return resolvePlan(plan, models, live, answers ?? null, payload.ladder, answers ? 'typesafe' : 'fallback')
  } catch (error) {
    // A camada de baixo já não lança; isto cobre o inesperado (uma resposta com
    // formato novo, por exemplo) sem deixar o envio da mensagem parado.
    console.error(`[typesafe] escolha automática descartada: ${(error as Error)?.message ?? error}`)
    return autoExecutionFallback(models, selection)
  }
}
