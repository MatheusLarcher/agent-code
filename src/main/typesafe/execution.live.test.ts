// @vitest-environment node
// O par vivo: histerese, recuo por confiança baixa e a origem que sobrevive a um
// religar — tudo POR DIMENSÃO. `./client` é trocado por um duplo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_MODEL_FALLBACK, clampEffortToModel, MODEL_EFFORT, type EffortLevel } from '../../shared/ipc'
import {
  BOTH_TYPESAFE,
  BOTH_UNPROMPTED,
  choiceAnswer,
  DECIDED_BOTH,
  MODELO_TETO_HIGH,
  scoreAnswer
} from './autoTestKit'

const askTypeSafe = vi.fn()
const minConfidence = { value: 0.2 }
vi.mock('./client', () => ({ askTypeSafe, typeSafeMinConfidence: () => minConfidence.value }))

const { autoExecutionUnprompted, chooseAutoExecution, resolveAutoStart, AUTO_MODEL_INSTRUCTION, AUTO_NO_LIVE_MODEL } =
  await import('./execution')
const { typeSafePause } = await import('./pause')

function respond(model: string, modelConfidence: number, score: number, effortConfidence = modelConfidence): void {
  askTypeSafe.mockResolvedValue({
    which_model: choiceAnswer(model, modelConfidence),
    which_effort: scoreAnswer(score, effortConfidence)
  })
}

beforeEach(() => {
  typeSafePause.reset()
  askTypeSafe.mockReset()
  minConfidence.value = 0.2
  respond('claude-sonnet-5', 0.7, 1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  ;(MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH] = ['low', 'medium', 'high']
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH]
})

/**
 * Histerese. O cache de prompt da Anthropic é POR MODELO: alternar a cada turno
 * pode custar mais do que a economia do turno barato. Daí o par vivo entrar na
 * decisão em vez de ficar só na comparação de reaproveitamento.
 */
describe('histerese: o par que já está no ar entra na decisão', () => {
  const live = { model: 'claude-opus-5-5', effort: 'high' as const }
  const decidedLive = { ...live, decided: DECIDED_BOTH }

  it('o modelo no ar vai no `state`, e a instrução manda mantê-lo sem motivo claro', async () => {
    await chooseAutoExecution({ message: 'e agora?' }, { live })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe('claude-opus-5-5')
    expect(AUTO_MODEL_INSTRUCTION).toContain('state.modelo_atual')
    expect(AUTO_MODEL_INSTRUCTION).toContain('MANTENHA')
  })

  it('conversa nova manda o rótulo de "nenhum", nunca um campo vazio', async () => {
    await chooseAutoExecution({ message: 'oi' })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
  })

  it('um par no ar fora da lista de candidatos não é anunciado — a resposta seria inválida', async () => {
    await chooseAutoExecution({ message: 'oi' }, { live, models: ['claude-sonnet-5', 'claude-fable-5-1'] })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
  })

  it('escolha CONFIANTE troca o par normalmente', async () => {
    respond('claude-sonnet-5', 0.9, 0)

    expect(await chooseAutoExecution({ message: 'traduz isto' }, { live })).toEqual({
      model: 'claude-sonnet-5',
      effort: 'low',
      source: BOTH_TYPESAFE
    })
  })

  it('escolha FRACA mantém o par vivo: 0,15 não troca o modelo de uma conversa', async () => {
    respond('claude-sonnet-5', 0.15, 0)

    expect(await chooseAutoExecution({ message: 'e aí?' }, { live })).toEqual({ ...live, source: BOTH_TYPESAFE })
  })

  it('o gate é POR DIMENSÃO: modelo confiante troca, esforço fraco fica no vivo', async () => {
    respond('claude-sonnet-5', 0.9, 0, 0.1)

    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toEqual({
      model: 'claude-sonnet-5',
      effort: 'high',
      source: BOTH_TYPESAFE
    })
  })

  it('e o contrário: modelo fraco fica no vivo, esforço confiante troca', async () => {
    respond('claude-sonnet-5', 0.1, 0, 0.9)

    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toEqual({
      model: 'claude-opus-5-5',
      effort: 'low',
      source: BOTH_TYPESAFE
    })
  })

  it('o piso é o do usuário: subindo `minConfidence`, uma escolha antes aceita passa a manter o par', async () => {
    respond('claude-sonnet-5', 0.7, 0)
    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toMatchObject({ model: 'claude-sonnet-5' })

    minConfidence.value = 0.8
    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toMatchObject({ model: 'claude-opus-5-5' })
  })

  it('sem par no ar, confiança baixa continua valendo: não há para onde recuar', async () => {
    respond('claude-sonnet-5', 0.2, 0)

    expect(await chooseAutoExecution({ message: 'oi' })).toMatchObject({ model: 'claude-sonnet-5', effort: 'low' })
  })

  it('resposta sem confiança declarada é aceita — ausência de número não é desconfiança', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: { type: 'choice', choice: 'claude-sonnet-5', probabilities: {} },
      which_effort: scoreAnswer(0, 0.9)
    })

    expect(await chooseAutoExecution({ message: 'traduz' }, { live })).toMatchObject({ model: 'claude-sonnet-5' })
  })

  it('o par recuado continua sendo recortado para o que o modelo suporta', async () => {
    respond('claude-opus-5-5', 0.1, 4)

    expect(
      await chooseAutoExecution(
        { message: 'oi' },
        { live: { model: MODELO_TETO_HIGH, effort: 'max' }, models: [MODELO_TETO_HIGH, 'claude-opus-5-5'] }
      )
    ).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: BOTH_TYPESAFE })
  })

  it('`resolveAutoStart` repassa o par da conversa — não é opção só de quem chama direto', async () => {
    respond('claude-sonnet-5', 0.1, 0)

    const decision = await resolveAutoStart({ autoPrompt: { message: 'e agora?' }, live: decidedLive, hasSession: true })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe('claude-opus-5-5')
    expect(decision.execution).toEqual({ ...live, source: BOTH_TYPESAFE })
    expect(decision.reuse).toBe(true)
  })

  it('a queda do serviço continua caindo no par padrão, não no par vivo', async () => {
    askTypeSafe.mockResolvedValue(null)

    const decision = await resolveAutoStart({ autoPrompt: { message: 'oi' }, live: decidedLive, hasSession: true })

    expect(decision.execution).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: clampEffortToModel(AUTO_MODEL_FALLBACK.model, AUTO_MODEL_FALLBACK.effort),
      source: { model: 'fallback', effort: 'fallback' }
    })
  })
})

describe('o par que sobrevive a um religar', () => {
  it('um par inválido guardado não passa adiante sem recorte', () => {
    expect(
      autoExecutionUnprompted({ model: MODELO_TETO_HIGH, effort: 'max' }, [MODELO_TETO_HIGH, 'claude-opus-5-5'])
    ).toEqual({ model: MODELO_TETO_HIGH, effort: 'high', source: BOTH_UNPROMPTED })
  })

  it('um modelo vivo fora dos candidatos (veio de um modelo fixo) não vira o modelo do Automático', () => {
    expect(autoExecutionUnprompted({ model: 'gpt-oss:120b-cloud', effort: 'low' })).toMatchObject({
      model: AUTO_MODEL_FALLBACK.model,
      effort: 'low'
    })
  })
})

/**
 * O fallback é TRANSITÓRIO, e por dimensão: guardar como decisão o valor de um
 * fallback fazia uma queda momentânea virar uma escolha permanente que ninguém
 * tomou — o turno seguinte o defendia mesmo com o TypeSafe de volta.
 */
describe('o fallback não se defende no turno seguinte', () => {
  it('o par do fallback roda a sessão, mas não é guardado como decisão', async () => {
    askTypeSafe.mockResolvedValue(null)

    const turno = await resolveAutoStart({ autoPrompt: { message: 'oi' }, hasSession: false })

    expect(turno.live).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: clampEffortToModel(AUTO_MODEL_FALLBACK.model, AUTO_MODEL_FALLBACK.effort),
      decided: { model: false, effort: false }
    })
  })

  it('serviço fora no 1º turno não prende o 2º no modelo mais caro', async () => {
    askTypeSafe.mockResolvedValue(null)
    const primeiro = await resolveAutoStart({ autoPrompt: { message: 'e agora?' }, hasSession: false })

    respond('claude-sonnet-5', 0.3, 0)
    const segundo = await resolveAutoStart({ autoPrompt: { message: 'traduz isto' }, live: primeiro.live, hasSession: true })

    expect(segundo.execution).toEqual({ model: 'claude-sonnet-5', effort: 'low', source: BOTH_TYPESAFE })
    // O Opus do fallback não é anunciado como `modelo_atual`: não é para ser mantido.
    expect(askTypeSafe.mock.calls[1][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
    expect(segundo.live).toEqual({ model: 'claude-sonnet-5', effort: 'low', decided: DECIDED_BOTH })
  })

  it('fallback SÓ no esforço: o modelo decidido se defende, o esforço não', async () => {
    // 1º turno: o modelo veio, o esforço não.
    askTypeSafe.mockResolvedValue({ which_model: choiceAnswer('claude-sonnet-5', 0.9) })
    const primeiro = await resolveAutoStart({ autoPrompt: { message: 'oi' }, hasSession: false })
    expect(primeiro.live.decided).toEqual({ model: true, effort: false })

    // 2º turno: as duas respostas fracas. O modelo recua para o vivo; o esforço
    // do fallback NÃO vira histerese — vale a resposta fraca.
    respond('claude-opus-5-5', 0.1, 0, 0.1)
    askTypeSafe.mockClear()
    const segundo = await resolveAutoStart({ autoPrompt: { message: 'e aí?' }, live: primeiro.live, hasSession: true })

    expect(segundo.execution).toEqual({ model: 'claude-sonnet-5', effort: 'low', source: BOTH_TYPESAFE })
  })

  it('`unprompted` preserva o par vivo e a origem de CADA dimensão', async () => {
    const decided = await resolveAutoStart({
      live: { model: 'claude-sonnet-5', effort: 'low', decided: { model: true, effort: false } },
      hasSession: true
    })
    expect(decided.execution).toEqual({ model: 'claude-sonnet-5', effort: 'low', source: BOTH_UNPROMPTED })
    expect(decided.live.decided).toEqual({ model: true, effort: false })
  })

  it('o reaproveitamento da sessão continua olhando o par REAL, decidido ou não', async () => {
    respond('claude-opus-5-5', 0.7, 2)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'e aí?' },
      live: { model: 'claude-opus-5-5', effort: 'high', decided: { model: false, effort: false } },
      hasSession: true
    })

    expect(decision.reuse).toBe(true)
    expect(decision.live).toEqual({ model: 'claude-opus-5-5', effort: 'high', decided: DECIDED_BOTH })
  })
})
