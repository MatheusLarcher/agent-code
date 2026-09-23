import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_MODEL,
  AUTO_MODEL_FALLBACK,
  CLAUDE_MODELS,
  MODEL_EFFORT,
  PLANNING_AUTO_FALLBACK,
  type AutoPrompt,
  type EffortLevel
} from '../../shared/ipc'
import type { AutoExecution, AutoExecutionOptions } from '../typesafe/execution'
import {
  PLANNING_AUTO_MODELS,
  planningAutoCandidates,
  resolvePlanningExecution,
  type PlanningExecutionDeps
} from './planningModelChoice'

/** O modelo mais forte do catálogo atual (Opus), sem fixar a versão: o teste
 *  vale antes e depois de uma troca de catálogo. */
const STRONG = PLANNING_AUTO_MODELS[0]

/** Nenhum modelo real do catálogo tem teto abaixo de `max`: id sintético só para
 *  exercitar o recorte (mesmo recurso de execution.test.ts). */
const MODELO_TETO_HIGH = '__teste_planejamento_teto_high__'

const PROMPT: AutoPrompt = { message: 'monta o roteiro da migração do banco' }

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

describe('resolvePlanningExecution', () => {
  it('manual: devolve o par da configuração sem consultar o TypeSafe', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: 'typesafe' })
    const result = await resolvePlanningExecution({ model: STRONG, effort: 'high' }, PROMPT, d)

    expect(result).toEqual({ model: STRONG, effort: 'high', source: 'manual' })
    expect(d.typeSafeConfigured).not.toHaveBeenCalled()
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('manual com esforço acima do suportado: recorta para o teto do modelo', async () => {
    const result = await resolvePlanningExecution({ model: MODELO_TETO_HIGH, effort: 'max' }, PROMPT, deps(new Error('x')))
    expect(result).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: 'manual' })
  })

  it('Automático com TypeSafe ligado: aceita o par que ele escolheu, sobre a lista do Manager', async () => {
    const d = deps({ model: 'claude-fable-5-1', effort: 'xhigh', source: 'typesafe' })
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'low' }, PROMPT, d)

    expect(result).toEqual({ model: 'claude-fable-5-1', effort: 'xhigh', source: 'typesafe' })
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: PLANNING_AUTO_MODELS })
    expect(PLANNING_AUTO_MODELS).toEqual(CLAUDE_MODELS.map((m) => m.id))
  })

  it('Automático com TypeSafe desligado (ou sem chave): Sonnet 5 médio, sem chamar a escolha', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: 'typesafe' }, false)
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'max' }, PROMPT, d)

    expect(result).toEqual({ ...PLANNING_AUTO_FALLBACK, source: 'fallback' })
    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('Automático quando chooseAutoExecution devolve o recuo DELA: usa o do Manager, não o Opus', async () => {
    const d = deps({ model: AUTO_MODEL_FALLBACK.model, effort: AUTO_MODEL_FALLBACK.effort, source: 'fallback' })
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)

    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
    expect(result.model).not.toBe(AUTO_MODEL_FALLBACK.model)
  })

  it('Automático quando não havia o que decidir (unprompted): também cai no recuo do Manager', async () => {
    const d = deps({ model: STRONG, effort: 'high', source: 'unprompted' })
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, { message: '' }, d)
    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })

  it('Automático com erro na escolha ou na checagem do TypeSafe: nunca lança, cai no recuo', async () => {
    const erroNaEscolha = await resolvePlanningExecution(
      { model: AUTO_MODEL, effort: 'medium' },
      PROMPT,
      deps(new Error('timeout'))
    )
    expect(erroNaEscolha).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })

    const erroNaChecagem = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, {
      typeSafeConfigured: () => {
        throw new Error('cofre ilegível')
      },
      chooseAutoExecution: vi.fn()
    })
    expect(erroNaChecagem).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })

  it('Automático: par "typesafe" fora da lista do Manager é descartado', async () => {
    const d = deps({ model: 'gpt-6-sol', effort: 'high', source: 'typesafe' })
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)
    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })

  it('lista do Automático vazia (padrão) = todos os modelos do Manager', async () => {
    const d = deps({ model: STRONG, effort: 'high', source: 'typesafe' }, true, [])
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)

    expect(result).toEqual({ model: STRONG, effort: 'high', source: 'typesafe' })
    expect(d.allowedAutoModels).toHaveBeenCalledTimes(1)
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: PLANNING_AUTO_MODELS })
  })

  it('lista restrita: só a interseção com os do Manager vai para chooseAutoExecution', async () => {
    // GPT fica de fora: está na lista do usuário, mas não no seletor do Manager.
    const d = deps({ model: 'claude-sonnet-5', effort: 'high', source: 'typesafe' }, true, [
      'gpt-6-sol',
      'claude-sonnet-5',
      'claude-fable-5-1'
    ])
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)

    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'high', source: 'typesafe' })
    // Ordem do seletor do Manager, não a da lista do usuário.
    expect(d.chooseAutoExecution).toHaveBeenCalledWith(PROMPT, { models: ['claude-sonnet-5', 'claude-fable-5-1'] })
  })

  it('lista restrita: par "typesafe" fora da restrição é descartado', async () => {
    const d = deps({ model: STRONG, effort: 'max', source: 'typesafe' }, true, ['claude-fable-5-1'])
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)
    expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })

  it('interseção vazia: recuo do Manager, sem chamar a escolha', async () => {
    const d = deps({ model: 'gpt-6-sol', effort: 'high', source: 'typesafe' }, true, ['gpt-6-sol'])
    const result = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, d)

    expect(result).toEqual({ ...PLANNING_AUTO_FALLBACK, source: 'fallback' })
    expect(d.chooseAutoExecution).not.toHaveBeenCalled()
  })

  it('lista só é lida no Automático, e erro ao lê-la cai no recuo', async () => {
    const manual = deps({ model: STRONG, effort: 'max', source: 'typesafe' }, true, ['claude-fable-5-1'])
    await resolvePlanningExecution({ model: STRONG, effort: 'high' }, PROMPT, manual)
    expect(manual.allowedAutoModels).not.toHaveBeenCalled()

    const erro = await resolvePlanningExecution({ model: AUTO_MODEL, effort: 'medium' }, PROMPT, {
      ...deps({ model: STRONG, effort: 'max', source: 'typesafe' }),
      allowedAutoModels: () => {
        throw new Error('config ilegível')
      }
    })
    expect(erro).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })

  it('planningAutoCandidates: vazia/malformada = todos; restrita = interseção na ordem do Manager', () => {
    expect(planningAutoCandidates([])).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates(undefined)).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates('claude-sonnet-5')).toEqual(PLANNING_AUTO_MODELS)
    expect(planningAutoCandidates(['claude-fable-5-1', STRONG])).toEqual([STRONG, 'claude-fable-5-1'])
    expect(planningAutoCandidates(['gpt-6-sol'])).toEqual([])
  })

  it('configuração sem modelo utilizável: recuo, sem lançar', async () => {
    const semModelo = await resolvePlanningExecution(
      { model: '', effort: 'high' },
      PROMPT,
      deps(new Error('x'))
    )
    expect(semModelo).toEqual({ model: 'claude-sonnet-5', effort: 'medium', source: 'fallback' })
  })
})
