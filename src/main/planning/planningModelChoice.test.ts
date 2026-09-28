import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_EFFORT,
  AUTO_MODEL,
  AUTO_MODEL_FALLBACK,
  CLAUDE_MODELS,
  MODEL_EFFORT,
  PLANNING_AUTO_FALLBACK,
  type AutoPrompt,
  type EffortLevel,
  type PlanningConfig
} from '../../shared/ipc'
import type { AutoExecution, AutoExecutionOptions, AutoSources } from '../typesafe/execution'
import {
  PLANNING_AUTO_MODELS,
  planningAutoCandidates,
  resolvePlanningExecution,
  type PlanningExecutionDeps
} from './planningModelChoice'

/** O modelo mais forte do catálogo atual (Opus), sem fixar a versão. */
const STRONG = PLANNING_AUTO_MODELS[0]

/** Id sintético com teto `high`, só para exercitar o recorte. */
const MODELO_TETO_HIGH = '__teste_planejamento_teto_high__'

const PROMPT: AutoPrompt = { message: 'monta o roteiro da migração do banco' }

const TS: AutoSources = { model: 'typesafe', effort: 'typesafe' }
const AUTO_AUTO: PlanningConfig = { model: AUTO_MODEL, effort: AUTO_EFFORT }
const FALLBACK = { model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' }

/** Dependências falsas: a checagem do TypeSafe responde `configured`, a escolha
 *  devolve `execution` (ou lança, se for um Error) e a lista do Automático das
 *  configurações é `allowed` (vazia = sem restrição). */
function deps(execution: AutoExecution | Error, configured = true, allowed: readonly string[] = []) {
  const fakes = {
    typeSafeConfigured: vi.fn(async (): Promise<boolean> => configured),
    chooseAutoExecution: vi.fn(async (_prompt: AutoPrompt, _options?: AutoExecutionOptions): Promise<AutoExecution> => {
      if (execution instanceof Error) throw execution
      return execution
    }),
    allowedAutoModels: vi.fn((): readonly string[] => allowed)
  }
  return fakes satisfies PlanningExecutionDeps
}

beforeEach(() => {
  ;(MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH] = ['low', 'medium', 'high']
})

afterEach(() => {
  delete (MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH]
})

describe('resolvePlanningExecution: as quatro combinações', () => {
  it('fixo + fixo: o par da configuração, sem consultar o TypeSafe', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: TS })
    const result = await resolvePlanningExecution({ model: STRONG, effort: 'high' }, PROMPT, d)

    expect(result).toEqual({ model: STRONG, effort: 'high', source: 'manual' })
    expect(d.typeSafeConfigured).not.toHaveBeenCalled()
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('fixo + fixo com esforço acima do suportado: recorta para o teto do modelo', async () => {
    const result = await resolvePlanningExecution({ model: MODELO_TETO_HIGH, effort: 'max' }, PROMPT, deps(new Error('x')))
    expect(result).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: 'manual' })
  })

  it('Automático + Automático: aceita o par escolhido, sobre a lista do Manager', async () => {
    const d = deps({ model: 'claude-fable-5-1', effort: 'xhigh', source: TS })
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh', source: 'typesafe' })
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: PLANNING_AUTO_MODELS, selection: AUTO_AUTO })
    expect(PLANNING_AUTO_MODELS).toEqual(CLAUDE_MODELS.map((m) => m.id))
  })

  it('Automático + fixo: só o modelo vem do TypeSafe; o esforço fixo é recortado ao modelo escolhido', async () => {
    const cfg: PlanningConfig = { model: AUTO_MODEL, effort: 'max' }
    const d = deps({ model: STRONG, effort: 'max', source: { model: 'typesafe' } })
    const ok = await resolvePlanningExecution(cfg, PROMPT, d)

    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: PLANNING_AUTO_MODELS, selection: cfg })
    expect(ok).toEqual({ model: STRONG, effort: 'max', source: 'typesafe' })

    // Modelo fora dos candidatos do Manager: o modelo cai no padrão, o esforço continua o fixo.
    const fora = deps({ model: MODELO_TETO_HIGH, effort: 'high', source: { model: 'typesafe' } })
    expect(await resolvePlanningExecution(cfg, PROMPT, fora)).toEqual({
      model: 'claude-sonnet-5',
      effort: 'max',
      source: 'fallback'
    })
  })

  it('fixo + Automático: só o esforço vem do TypeSafe; a lista do usuário nem é lida', async () => {
    const cfg: PlanningConfig = { model: STRONG, effort: AUTO_EFFORT }
    const d = deps({ model: STRONG, effort: 'low', source: { effort: 'typesafe' } }, true, ['claude-fable-5-1'])
    const result = await resolvePlanningExecution(cfg, PROMPT, d)

    expect(result).toEqual({ model: STRONG, effort: 'low', source: 'typesafe' })
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { selection: cfg })
    expect(d.allowedAutoModels).not.toHaveBeenCalled()
  })
})

describe('resolvePlanningExecution: recuo por dimensão', () => {
  it('Automático + Automático com TypeSafe desligado: Sonnet 5 médio, sem chamar a escolha', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: TS }, false)
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual({ ...PLANNING_AUTO_FALLBACK, source: 'fallback' })
    expect(result).toEqual(FALLBACK)
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('fixo + Automático com TypeSafe desligado: o modelo salvo fica, o esforço é o padrão recortado', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: TS }, false)
    expect(await resolvePlanningExecution({ model: MODELO_TETO_HIGH, effort: AUTO_EFFORT }, PROMPT, d)).toEqual({
      model: MODELO_TETO_HIGH,
      effort: 'medium',
      source: 'fallback'
    })
    expect(await resolvePlanningExecution({ model: STRONG, effort: AUTO_EFFORT }, PROMPT, d)).toEqual({
      model: STRONG,
      effort: PLANNING_AUTO_FALLBACK.effort,
      source: 'fallback'
    })
  })

  it('Automático + fixo com TypeSafe desligado: o modelo padrão, o esforço fixo', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: TS }, false)
    expect(await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'xhigh' }, PROMPT, d)).toEqual({
      model: PLANNING_AUTO_FALLBACK.model,
      effort: 'xhigh',
      source: 'fallback'
    })
  })

  it('o recuo DE LÁ não passa: usa o do Manager, não o Opus', async () => {
    const d = deps({
      model: AUTO_MODEL_FALLBACK.model,
      effort: AUTO_MODEL_FALLBACK.effort,
      source: { model: 'fallback', effort: 'fallback' }
    })
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual(FALLBACK)
    expect(result.model).not.toBe(AUTO_MODEL_FALLBACK.model)
  })

  it('fallback só no esforço: o modelo decidido passa, o esforço cai no do Manager', async () => {
    const d = deps({ model: STRONG, effort: 'high', source: { model: 'typesafe', effort: 'fallback' } })
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)).toEqual({ model: STRONG, effort: 'medium', source: 'fallback' })
  })

  it('não havia o que decidir (unprompted): também cai no recuo do Manager', async () => {
    const d = deps({ model: STRONG, effort: 'high', source: { model: 'unprompted', effort: 'unprompted' } })
    expect(await resolvePlanningExecution(AUTO_AUTO, { message: '' }, d)).toEqual(FALLBACK)
  })

  it('erro na escolha ou na checagem do TypeSafe: nunca lança, cai no recuo', async () => {
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, deps(new Error('timeout')))).toEqual(FALLBACK)

    const erroNaChecagem = await resolvePlanningExecution(AUTO_AUTO, PROMPT, {
      typeSafeConfigured: () => {
        throw new Error('cofre ilegível')
      },
      chooseAutoExecution: vi.fn()
    })
    expect(erroNaChecagem).toEqual(FALLBACK)
  })

  it('modelo "typesafe" fora da lista do Manager é descartado', async () => {
    const d = deps({ model: 'gpt-6-sol', effort: 'high', source: TS })
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)).toEqual({ model: 'claude-sonnet-5', effort: 'high', source: 'fallback' })
  })
})

describe('resolvePlanningExecution: lista do Automático', () => {
  it('lista vazia (padrão) = todos os modelos do Manager', async () => {
    const d = deps({ model: STRONG, effort: 'high', source: TS }, true, [])
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual({ model: STRONG, effort: 'high', source: 'typesafe' })
    expect(d.allowedAutoModels).toHaveBeenCalledTimes(1)
  })

  it('lista restrita: só a interseção com os do Manager vai para chooseAutoExecution', async () => {
    const d = deps({ model: 'claude-sonnet-5', effort: 'high', source: TS }, true, [
      'gpt-6-sol',
      'claude-sonnet-5',
      'claude-fable-5-1'
    ])
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'high', source: 'typesafe' })
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, {
      models: ['claude-sonnet-5', 'claude-fable-5-1'],
      selection: AUTO_AUTO
    })
  })

  it('lista restrita: modelo "typesafe" fora da restrição é descartado', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: TS }, true, ['claude-fable-5-1', 'claude-sonnet-5'])
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)).toEqual({ model: 'claude-sonnet-5', effort: 'max', source: 'fallback' })
  })

  it('lista restrita a UM modelo + esforço fixo: usa o modelo permitido, sem chamar a escolha', async () => {
    const cfg: PlanningConfig = { model: AUTO_MODEL, effort: 'xhigh' }
    // A escolha real devolveria `unprompted` (candidato único não é perguntado).
    const d = deps({ model: 'claude-fable-5-1', effort: 'xhigh', source: { model: 'unprompted' } }, true, [
      'claude-fable-5-1'
    ])
    const result = await resolvePlanningExecution(cfg, PROMPT, d)

    expect(result).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh', source: 'typesafe' })
    expect(result.model).not.toBe(PLANNING_AUTO_FALLBACK.model)
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('lista restrita a UM modelo + esforço Automático: o modelo é o permitido, só o esforço é decidido', async () => {
    const d = deps({ model: STRONG, effort: 'low', source: { model: 'unprompted', effort: 'typesafe' } }, true, [
      'claude-fable-5-1'
    ])
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)).toEqual({
      model: 'claude-fable-5-1',
      effort: 'low',
      source: 'typesafe'
    })
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: ['claude-fable-5-1'], selection: AUTO_AUTO })

    // Esforço sem decisão: o modelo continua o permitido, o esforço cai no do Manager.
    const semEsforco = deps({ model: STRONG, effort: 'high', source: { model: 'unprompted', effort: 'fallback' } }, true, [
      'claude-fable-5-1'
    ])
    expect(await resolvePlanningExecution(AUTO_AUTO, PROMPT, semEsforco)).toEqual({
      model: 'claude-fable-5-1',
      effort: PLANNING_AUTO_FALLBACK.effort,
      source: 'fallback'
    })
  })

  it('interseção vazia: recuo do Manager, sem chamar a escolha', async () => {
    const d = deps({ model: 'gpt-6-sol', effort: 'high', source: TS }, true, ['gpt-6-sol'])
    const result = await resolvePlanningExecution(AUTO_AUTO, PROMPT, d)

    expect(result).toEqual({ ...PLANNING_AUTO_FALLBACK, source: 'fallback' })
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('lista só é lida com o modelo em Automático, e erro ao lê-la cai no recuo', async () => {
    const manual = deps({ model: STRONG, effort: 'max', source: TS }, true, ['claude-fable-5-1'])
    await resolvePlanningExecution({ model: STRONG, effort: 'high' }, PROMPT, manual)
    expect(manual.allowedAutoModels).not.toHaveBeenCalled()

    const erro = await resolvePlanningExecution(AUTO_AUTO, PROMPT, {
      ...deps({ model: STRONG, effort: 'max', source: TS }),
      allowedAutoModels: () => {
        throw new Error('config ilegível')
      }
    })
    expect(erro).toEqual(FALLBACK)
  })

  it('planningAutoCandidates: vazia/malformada = todos; restrita = interseção na ordem do Manager', () => {
    expect(planningAutoCandidates([])).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates(undefined)).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates('claude-sonnet-5')).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates(['claude-fable-5-1', STRONG])).toEqual([STRONG, 'claude-fable-5-1'])
    expect(planningAutoCandidates(['gpt-6-sol'])).toEqual([])
  })

  it('configuração sem modelo utilizável: recuo, sem lançar', async () => {
    expect(await resolvePlanningExecution({ model: '', effort: 'high' }, PROMPT, deps(new Error('x')))).toEqual(FALLBACK)
  })
})
