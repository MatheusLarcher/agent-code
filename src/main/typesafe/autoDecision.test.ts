// @vitest-environment node
// As quatro combinações modelo × esforço (Automático ou fixo) e o que cada uma
// pergunta ao TypeSafe. `./client` é trocado por um duplo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_EFFORT,
  AUTO_MODEL,
  AUTO_MODEL_FALLBACK,
  clampEffortToModel,
  MODEL_EFFORT,
  type EffortLevel
} from '../../shared/ipc'
import { choiceAnswer, DECIDED_BOTH, MODELO_SEM_ESFORCO, MODELO_TETO_HIGH, scoreAnswer } from './autoTestKit'

const askTypeSafe = vi.fn()
const minConfidence = { value: 0.2 }
vi.mock('./client', () => ({ askTypeSafe, typeSafeMinConfidence: () => minConfidence.value }))

const { autoExecutionNote, buildAutoExecutionPayload, chooseAutoExecution, resolveAutoStart } =
  await import('./execution')
const { typeSafePause } = await import('./pause')

const AUTO_AUTO = { model: AUTO_MODEL, effort: AUTO_EFFORT }
const AUTO_FIXO = { model: AUTO_MODEL, effort: 'max' }
const FIXO_AUTO = { model: MODELO_TETO_HIGH, effort: AUTO_EFFORT }
const FIXO_FIXO = { model: 'claude-sonnet-5', effort: 'low' }

beforeEach(() => {
  typeSafePause.reset()
  askTypeSafe.mockReset()
  minConfidence.value = 0.2
  askTypeSafe.mockResolvedValue({ which_model: choiceAnswer(MODELO_TETO_HIGH), which_effort: scoreAnswer(4) })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  ;(MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH] = ['low', 'medium', 'high']
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH]
})

const models = ['claude-opus-5-5', 'claude-sonnet-5', MODELO_TETO_HIGH]
const questionsOf = (call = 0): string[] => Object.keys(askTypeSafe.mock.calls[call][0].questions).sort()

describe('Automático + Automático', () => {
  it('UMA chamada com as duas perguntas; o esforço é recortado pelo modelo escolhido', async () => {
    const execution = await chooseAutoExecution({ message: 'oi' }, { models, selection: AUTO_AUTO })

    expect(askTypeSafe).toHaveBeenCalledTimes(1)
    expect(questionsOf()).toEqual(['which_effort', 'which_model'])
    expect(askTypeSafe.mock.calls[0][0].questions.which_effort.type).toBe('score')
    expect(execution).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: { model: 'typesafe', effort: 'typesafe' } })
  })
})

describe('Automático + fixo', () => {
  it('só o choice; o esforço fixo passa por clampEffortToModel e não tem origem', async () => {
    const execution = await chooseAutoExecution({ message: 'oi' }, { models, selection: AUTO_FIXO })

    expect(questionsOf()).toEqual(['which_model'])
    expect(execution).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: { model: 'typesafe' } })
    expect(autoExecutionNote(execution)).toBe(`Automático: ${MODELO_TETO_HIGH}.`)
  })

  it('TypeSafe fora: só o modelo cai no padrão; o esforço continua o fixo', async () => {
    askTypeSafe.mockResolvedValue(null)

    expect(await chooseAutoExecution({ message: 'oi' }, { models, selection: AUTO_FIXO })).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: 'max',
      source: { model: 'fallback' }
    })
  })
})

describe('fixo + Automático', () => {
  it('só o score, na escada MODEL_EFFORT DESSE modelo; o modelo não muda', async () => {
    askTypeSafe.mockResolvedValue({ which_effort: scoreAnswer(2) })

    const execution = await chooseAutoExecution({ message: 'oi' }, { models, selection: FIXO_AUTO })

    expect(questionsOf()).toEqual(['which_effort'])
    // A escada oferecida tem 3 degraus (a do modelo), e o score 2 é o topo dela.
    expect(buildAutoExecutionPayload({ message: 'oi' }, models, undefined, FIXO_AUTO)?.ladder).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(execution).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: { effort: 'typesafe' } })
    expect(autoExecutionNote(execution)).toBe('Automático: esforço alto.')
  })

  it('o `modelo_atual` do state é o modelo fixo — é ele quem vai rodar o esforço', async () => {
    await chooseAutoExecution({ message: 'oi' }, { models, selection: { model: 'claude-opus-5-5', effort: AUTO_EFFORT } })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe('claude-opus-5-5')
  })

  it('modelo sem esforço (Ollama): sem pergunta, sem effort, sem nota', async () => {
    const execution = await chooseAutoExecution(
      { message: 'oi' },
      { selection: { model: MODELO_SEM_ESFORCO, effort: AUTO_EFFORT } }
    )

    expect(askTypeSafe).not.toHaveBeenCalled()
    expect(execution).toEqual({ model: MODELO_SEM_ESFORCO, source: {} })
    expect(autoExecutionNote(execution)).toBeNull()
  })

  it('TypeSafe fora: o esforço é o padrão recortado ao modelo; o modelo salvo não troca', async () => {
    askTypeSafe.mockResolvedValue(null)

    const execution = await chooseAutoExecution({ message: 'oi' }, { models, selection: FIXO_AUTO })

    expect(execution).toEqual({
      model: MODELO_TETO_HIGH,
      effort: clampEffortToModel(MODELO_TETO_HIGH, AUTO_MODEL_FALLBACK.effort),
      source: { effort: 'fallback' }
    })
    expect(autoExecutionNote(execution)).toContain('esforço padrão')
  })
})

describe('fixo + fixo', () => {
  it('nenhuma chamada ao decisor', async () => {
    const execution = await chooseAutoExecution({ message: 'projeta a arquitetura' }, { models, selection: FIXO_FIXO })

    expect(askTypeSafe).toHaveBeenCalledTimes(0)
    expect(execution).toEqual({ model: 'claude-sonnet-5', effort: 'low', source: {} })
    expect(autoExecutionNote(execution)).toBeNull()
  })
})

describe('o par vivo por dimensão entre combinações', () => {
  it('fixo + Automático: o esforço vivo decidido se defende de um score fraco', async () => {
    askTypeSafe.mockResolvedValue({ which_effort: scoreAnswer(0, 0.05) })

    const decision = await resolveAutoStart(
      {
        autoPrompt: { message: 'oi' },
        live: { model: 'claude-opus-5-5', effort: 'xhigh', decided: DECIDED_BOTH },
        hasSession: true
      },
      { selection: { model: 'claude-opus-5-5', effort: AUTO_EFFORT } }
    )

    expect(decision.execution).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', source: { effort: 'typesafe' } })
    expect(decision.reuse).toBe(true)
    // O modelo é fixo: não é decisão de ninguém e não vira histerese.
    expect(decision.live.decided).toEqual({ model: false, effort: true })
  })

  it('Automático + fixo: com modelo decidido no ar, escolha fraca mantém o modelo', async () => {
    askTypeSafe.mockResolvedValue({ which_model: choiceAnswer('claude-sonnet-5', 0.05) })

    const decision = await resolveAutoStart(
      {
        autoPrompt: { message: 'oi' },
        live: { model: 'claude-opus-5-5', effort: 'max', decided: DECIDED_BOTH },
        hasSession: true
      },
      { selection: AUTO_FIXO }
    )

    expect(decision.execution).toEqual({ model: 'claude-opus-5-5', effort: 'max', source: { model: 'typesafe' } })
    expect(decision.live.decided).toEqual({ model: true, effort: false })
  })

  it('sem turno, as dimensões fixas continuam as do usuário', async () => {
    const decision = await resolveAutoStart(
      { live: { model: 'claude-sonnet-5', effort: 'low', decided: DECIDED_BOTH }, hasSession: true },
      { selection: { model: 'claude-opus-5-5', effort: AUTO_EFFORT } }
    )

    expect(askTypeSafe).not.toHaveBeenCalled()
    expect(decision.note).toBeNull()
    expect(decision.execution).toEqual({ model: 'claude-opus-5-5', effort: 'low', source: { effort: 'unprompted' } })
  })
})
