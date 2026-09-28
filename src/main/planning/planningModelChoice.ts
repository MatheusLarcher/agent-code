import {
  clampEffortToModel,
  isAutoEffort,
  isAutoModel,
  PLANNING_AUTO_FALLBACK,
  PLANNING_MODELS,
  type AutoPrompt,
  type EffortLevel,
  type PlanningConfig
} from '../../shared/ipc'
import { isEffortLevel } from '../../shared/autoEffort'
import type { AutoExecution, AutoExecutionOptions } from '../typesafe/execution'

/**
 * O modelo e o esforço do Agent Manager (Tela de Planejamento) para UMA mensagem.
 *
 * Modelo e esforço são automáticos de forma independente. Os dois fixos: o par
 * da configuração, sem chamada nenhuma. Com alguma dimensão em Automático, o
 * MESMO caminho que escolhe o par da conversa (`chooseAutoExecution`), que só
 * pergunta a dimensão automática, restrito à lista do seletor do Manager.
 *
 * A diferença está no recuo. O Automático da conversa cai no modelo mais caro
 * (AUTO_MODEL_FALLBACK); o do Manager cai em PLANNING_AUTO_FALLBACK (Sonnet 5,
 * médio), dimensão a dimensão. E só aceita uma dimensão quando o TypeSafe a
 * DECIDIU de fato (`source.<dimensão> === 'typesafe'`).
 *
 * A restrição do usuário (`typesafe.allowedAutoModels`, Configurações → TypeSafe)
 * vale aqui também: com a lista preenchida, os candidatos são a interseção dela
 * com os do Manager; interseção vazia é o recuo, sem chamar a escolha.
 *
 * Nunca lança: a mensagem do usuário tem de sair de qualquer jeito.
 */

/** De onde saiu o par: fixado pelo usuário, escolhido pelo TypeSafe ou recuo. */
export type PlanningExecutionSource = 'manual' | 'typesafe' | 'fallback'

export interface PlanningExecution {
  model: string
  effort: EffortLevel
  source: PlanningExecutionSource
}

/** O que o resolvedor precisa de fora. Injetável para teste; ausente, usa os reais. */
export interface PlanningExecutionDeps {
  /** TypeSafe ligado E com chave utilizável (config ou cofre). */
  typeSafeConfigured: () => boolean | Promise<boolean>
  chooseAutoExecution: (prompt: AutoPrompt, options?: AutoExecutionOptions) => Promise<AutoExecution>
  /** A lista do Automático das configurações do TypeSafe. Vazia = sem restrição. */
  allowedAutoModels: () => readonly string[] | Promise<readonly string[]>
}

/** Os modelos entre os quais o Automático do Manager escolhe: exatamente os do
 *  seletor dele, menos o próprio Automático. */
export const PLANNING_AUTO_MODELS: readonly string[] = PLANNING_MODELS.filter(
  (option) => !isAutoModel(option.id)
).map((option) => option.id)

function planningFallback(): PlanningExecution {
  return { model: PLANNING_AUTO_FALLBACK.model, effort: PLANNING_AUTO_FALLBACK.effort, source: 'fallback' }
}

/**
 * Os reais só são carregados no caminho Automático, e por import dinâmico: o
 * cliente do TypeSafe puxa a config (electron, banco), e o modo manual — e os
 * testes — não têm por que pagar por isso.
 */
async function realTypeSafeConfigured(): Promise<boolean> {
  const { typeSafeConfigured } = await import('../typesafe/client')
  return typeSafeConfigured()
}

async function realChooseAutoExecution(prompt: AutoPrompt, options?: AutoExecutionOptions): Promise<AutoExecution> {
  const { chooseAutoExecution } = await import('../typesafe/execution')
  return chooseAutoExecution(prompt, options)
}

async function realAllowedAutoModels(): Promise<readonly string[]> {
  const { loadConfig } = await import('../config')
  return loadConfig().typesafe.allowedAutoModels
}

/**
 * Os candidatos do Automático do Manager: PLANNING_AUTO_MODELS, ou a interseção
 * com a lista do usuário quando ela não é vazia. Pode sair vazio — quem chama
 * trata como recuo. Lista que não é array (config malformada) = sem restrição.
 */
export function planningAutoCandidates(allowed: unknown): readonly string[] {
  const list = Array.isArray(allowed) ? allowed.filter((id): id is string => typeof id === 'string') : []
  if (list.length === 0) return PLANNING_AUTO_MODELS
  return PLANNING_AUTO_MODELS.filter((id) => list.includes(id))
}

export async function resolvePlanningExecution(
  cfg: PlanningConfig,
  prompt: AutoPrompt,
  deps: Partial<PlanningExecutionDeps> = {}
): Promise<PlanningExecution> {
  try {
    const model = cfg?.model
    // Sem modelo utilizável não há o que fixar — o recuo é o único par honesto.
    if (typeof model !== 'string' || !model.trim()) return planningFallback()

    const autoModel = isAutoModel(model)
    const autoEffort = isAutoEffort(cfg.effort)
    const fixedEffort = isEffortLevel(cfg.effort) ? cfg.effort : PLANNING_AUTO_FALLBACK.effort
    if (!autoModel && !autoEffort) return { model, effort: clampEffortToModel(model, fixedEffort), source: 'manual' }

    // O recuo é POR DIMENSÃO: só a automática cai no PLANNING_AUTO_FALLBACK; a
    // fixa continua a do usuário (recortada ao modelo que sair).
    const pair = (chosenModel?: string, chosenEffort?: EffortLevel): PlanningExecution => {
      const outModel = autoModel ? (chosenModel ?? PLANNING_AUTO_FALLBACK.model) : model
      const outEffort = autoEffort ? (chosenEffort ?? PLANNING_AUTO_FALLBACK.effort) : fixedEffort
      const decided = (!autoModel || chosenModel !== undefined) && (!autoEffort || chosenEffort !== undefined)
      return { model: outModel, effort: clampEffortToModel(outModel, outEffort), source: decided ? 'typesafe' : 'fallback' }
    }

    const configured = await (deps.typeSafeConfigured ?? realTypeSafeConfigured)()
    if (!configured) return pair()

    // A lista do usuário só restringe a dimensão MODELO; com o modelo fixo ela
    // não tem o que restringir.
    const candidates = autoModel
      ? planningAutoCandidates(await (deps.allowedAutoModels ?? realAllowedAutoModels)())
      : [model]
    // O usuário restringiu o Automático a modelos que o Manager não oferece:
    // não há entre o que escolher — o recuo é o par honesto.
    if (candidates.length === 0) return pair()
    // Um candidato só não é escolha: é o modelo que a restrição deixou. A
    // escolha não pergunta nada nesse caso (origem `unprompted`), e sem este
    // atalho o modelo cairia no PLANNING_AUTO_FALLBACK — fora da restrição.
    const onlyModel = autoModel && candidates.length === 1 ? candidates[0] : undefined
    if (onlyModel && !autoEffort) return pair(onlyModel)

    const choose = deps.chooseAutoExecution ?? realChooseAutoExecution
    const execution = await choose(prompt, {
      ...(autoModel ? { models: candidates } : {}),
      selection: { model, effort: cfg.effort }
    })
    // Só a dimensão DECIDIDA passa. `fallback`/`unprompted` de lá seriam o
    // padrão caro da conversa; e um modelo fora dos candidatos furaria o
    // seletor do Manager ou a restrição do usuário.
    const chosenModel =
      onlyModel ??
      (autoModel && execution?.source?.model === 'typesafe' && candidates.includes(execution.model)
        ? execution.model
        : undefined)
    const chosenEffort =
      autoEffort && execution?.source?.effort === 'typesafe' && isEffortLevel(execution.effort)
        ? execution.effort
        : undefined
    return pair(chosenModel, chosenEffort)
  } catch {
    return planningFallback()
  }
}
