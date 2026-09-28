// @vitest-environment node
// Código do processo principal: `./client` é trocado por um duplo, então a
// cadeia config → store → `node:sqlite` nunca é carregada aqui.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_MODEL_FALLBACK,
  clampEffortToModel,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  MODEL_EFFORT,
  OPENAI_MODELS,
  type EffortLevel
} from '../../shared/ipc'
import {
  BOTH_FALLBACK,
  BOTH_TYPESAFE,
  BOTH_UNPROMPTED,
  choiceAnswer,
  DECIDED_BOTH,
  MODELO_TETO_HIGH,
  scoreAnswer
} from './autoTestKit'

const askTypeSafe = vi.fn()
/** O piso configurado pelo usuário. O padrão do app é 0,2. */
const minConfidence = { value: 0.2 }
vi.mock('./client', () => ({ askTypeSafe, typeSafeMinConfidence: () => minConfidence.value }))

const {
  autoEffortCandidates,
  autoExecutionNote,
  autoModelCandidates,
  autoModelLabel,
  buildAutoExecutionPayload,
  chooseAutoExecution,
  effortFromScore,
  resolveAutoStart,
  AUTO_MODEL_DESCRIPTIONS,
  AUTO_NO_LIVE_MODEL
} = await import('./execution')
const { typeSafePause } = await import('./pause')

function answers(model: string, score: number): void {
  askTypeSafe.mockResolvedValue({ which_model: choiceAnswer(model), which_effort: scoreAnswer(score) })
}

beforeEach(() => {
  // A pausa é do processo: uma falha de um teste não pode calar o seguinte.
  typeSafePause.reset()
  askTypeSafe.mockReset()
  minConfidence.value = 0.2
  answers('claude-sonnet-5', 1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  ;(MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH] = ['low', 'medium', 'high']
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (MODEL_EFFORT as Record<string, EffortLevel[]>)[MODELO_TETO_HIGH]
})

describe('candidatos', () => {
  it('oferece os modelos reais do seletor, e cada um com descrição', () => {
    const models = autoModelCandidates()

    expect(models).toEqual(['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1'])
    // Sem descrição o Jev escolheria pelo nome do modelo, não pelo trabalho pedido.
    for (const model of models) expect(AUTO_MODEL_DESCRIPTIONS[model]).toBeTruthy()
  })

  it('oferece a escada de esforço INTEIRA, na ordem', () => {
    expect(autoEffortCandidates()).toEqual([...EFFORT_LEVELS])
  })

  it('os GPT ficam fora do padrão, mas prontos para quando o ChatGPT estiver logado', () => {
    const gpt = OPENAI_MODELS.map((model) => model.id)

    for (const model of gpt) expect(autoModelCandidates()).not.toContain(model)
    for (const model of gpt) expect(AUTO_MODEL_DESCRIPTIONS[model]).toBeTruthy()
    for (const { id, label } of OPENAI_MODELS) expect(autoModelLabel(id)).toBe(label)
  })

  it('escolhe entre os GPT quando eles são os candidatos oferecidos', async () => {
    answers('gpt-6-sol', 2)
    const models = [...autoModelCandidates(), ...OPENAI_MODELS.map((model) => model.id)]

    const execution = await chooseAutoExecution({ message: 'refatora o agendador inteiro' }, { models })

    expect(execution).toEqual({ model: 'gpt-6-sol', effort: 'high', source: BOTH_TYPESAFE })
    expect(autoExecutionNote(execution)).toBe('Automático: GPT-6 Sol (ChatGPT), esforço alto.')
  })
})

describe('payload das perguntas', () => {
  it('leva as DUAS perguntas numa chamada só', async () => {
    await chooseAutoExecution({ message: 'refatora o módulo de sessão' })

    expect(askTypeSafe).toHaveBeenCalledTimes(1)
    const [request] = askTypeSafe.mock.calls[0]
    expect(Object.keys(request.questions).sort()).toEqual(['which_effort', 'which_model'])
  })

  it('pergunta o esforço por `score` e o modelo por `choice`', () => {
    const payload = buildAutoExecutionPayload({ message: 'oi' })

    expect(payload?.questions.which_model).toMatchObject({ type: 'choice' })
    expect(payload?.questions.which_effort).toMatchObject({ type: 'score' })
  })

  it('manda a mensagem nova separada do histórico, que é só contexto', () => {
    const payload = buildAutoExecutionPayload({
      message: 'agora faz o resto',
      history: [
        { who: 'user', text: 'cria o parser' },
        { who: 'agent', text: 'feito' }
      ]
    })

    expect(payload?.state).toEqual({
      mensagem_nova: 'agora faz o resto',
      conversa: [
        { quem: 'usuario', texto: 'cria o parser' },
        { quem: 'agente', texto: 'feito' }
      ],
      modelo_atual: AUTO_NO_LIVE_MODEL
    })
  })

  it('a escada devolvida no payload é a que INDEXA o score', () => {
    expect(buildAutoExecutionPayload({ message: 'oi' })?.ladder).toEqual([...EFFORT_LEVELS])
  })
})

describe('esforço a partir do score', () => {
  it.each([
    [0, 'low'],
    [0.4, 'low'],
    [1.5, 'high'],
    [2, 'high'],
    [2.4, 'high'],
    [2.6, 'xhigh'],
    [4, 'max']
  ])('score %s vira o degrau mais próximo: %s', (value, expected) => {
    expect(effortFromScore(value as number, [...EFFORT_LEVELS])).toBe(expected)
  })

  it('prende na faixa válida em vez de sair da escada', () => {
    expect(effortFromScore(-3, [...EFFORT_LEVELS])).toBe('low')
    expect(effortFromScore(99, [...EFFORT_LEVELS])).toBe('max')
  })

  it('um número inválido não vira `undefined`', () => {
    expect(effortFromScore(Number.NaN, [...EFFORT_LEVELS])).toBe(DEFAULT_EFFORT)
  })
})

describe('recorte do par modelo+esforço', () => {
  it('um modelo com teto reduzido para em `high`: `max` nunca chega ao provedor', async () => {
    answers(MODELO_TETO_HIGH, 4)

    // Candidato único: o modelo não é perguntado, mas a chamada (do esforço)
    // respondeu — as duas dimensões saem com a origem dela.
    expect(await chooseAutoExecution({ message: 'traduz isto' }, { models: [MODELO_TETO_HIGH] })).toEqual({
      model: MODELO_TETO_HIGH,
      effort: 'high',
      source: BOTH_TYPESAFE
    })
  })

  it('o recorte é DEPOIS das duas respostas — modelo capaz mantém `max`', async () => {
    answers('claude-opus-5-5', 4)

    expect(await chooseAutoExecution({ message: 'projeta a arquitetura do zero' })).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'max'
    })
  })

  it('clampEffortToModel desce para o teto do modelo, nunca sobe', () => {
    expect(clampEffortToModel(MODELO_TETO_HIGH, 'max')).toBe('high')
    expect(clampEffortToModel(MODELO_TETO_HIGH, 'xhigh')).toBe('high')
    expect(clampEffortToModel(MODELO_TETO_HIGH, 'low')).toBe('low')
    expect(clampEffortToModel('claude-opus-5-5', 'max')).toBe('max')
  })

  it('modelo sem tabela de esforço não tem contra o que recortar', () => {
    expect(clampEffortToModel('gpt-oss:120b-cloud', 'max')).toBe('max')
    expect(clampEffortToModel(undefined, 'low')).toBe('low')
  })
})

describe('falha nunca trava o envio', () => {
  const fallback = { model: AUTO_MODEL_FALLBACK.model, effort: AUTO_MODEL_FALLBACK.effort, source: BOTH_FALLBACK }

  it('sem decisão (desligado, sem chave, timeout, erro) sai o par padrão', async () => {
    askTypeSafe.mockResolvedValue(null)

    expect(await chooseAutoExecution({ message: 'qualquer coisa' })).toEqual(fallback)
  })

  it('o par padrão é um modelo CONCRETO e um esforço que ele suporta', () => {
    expect(AUTO_MODEL_FALLBACK.model).not.toBe('auto')
    expect(clampEffortToModel(AUTO_MODEL_FALLBACK.model, AUTO_MODEL_FALLBACK.effort)).toBe(
      AUTO_MODEL_FALLBACK.effort
    )
  })

  it('não gasta chamada com mensagem vazia — e isso NÃO é falha', async () => {
    expect(await chooseAutoExecution({ message: '   ' })).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: AUTO_MODEL_FALLBACK.effort,
      source: BOTH_UNPROMPTED
    })
    expect(askTypeSafe).not.toHaveBeenCalled()
  })

  it('uma exceção inesperada vira par padrão, não rejeição', async () => {
    askTypeSafe.mockRejectedValue(new Error('formato novo'))

    await expect(chooseAutoExecution({ message: 'oi' })).resolves.toEqual(fallback)
  })

  it('modelo desconhecido na resposta cai no padrão NESSA dimensão; o esforço decidido fica', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-inventado-9'),
      which_effort: scoreAnswer(1)
    })

    expect(await chooseAutoExecution({ message: 'oi' })).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: 'medium',
      source: { model: 'fallback', effort: 'typesafe' }
    })
  })

  it('resposta só de modelo: o esforço cai no padrão, marcado como fallback só nele', async () => {
    askTypeSafe.mockResolvedValue({ which_model: choiceAnswer('claude-sonnet-5') })

    expect(await chooseAutoExecution({ message: 'oi' })).toEqual({
      model: 'claude-sonnet-5',
      effort: DEFAULT_EFFORT,
      source: { model: 'typesafe', effort: 'fallback' }
    })
  })
})

describe('a nota que a UI mostra', () => {
  it('diz o modelo e o esforço do turno quando os dois são automáticos', () => {
    expect(autoExecutionNote({ model: 'claude-sonnet-5', effort: 'medium', source: BOTH_TYPESAFE })).toBe(
      'Automático: Sonnet 5, esforço médio.'
    )
  })

  it('avisa quando o par é o padrão, para a escolha não parecer uma decisão', () => {
    expect(autoExecutionNote({ model: 'claude-opus-5-5', effort: 'high', source: BOTH_FALLBACK })).toContain(
      'par padrão'
    )
  })

  it('não anuncia nada quando não havia turno para decidir', () => {
    expect(autoExecutionNote({ model: 'claude-opus-5-5', effort: 'high', source: BOTH_UNPROMPTED })).toBeNull()
  })

  it('só o modelo automático: a nota fala só do modelo', () => {
    expect(autoExecutionNote({ model: 'claude-sonnet-5', effort: 'high', source: { model: 'typesafe' } })).toBe(
      'Automático: Sonnet 5.'
    )
  })

  it('só o esforço automático: a nota fala só do esforço', () => {
    expect(autoExecutionNote({ model: 'claude-opus-5-5', effort: 'low', source: { effort: 'typesafe' } })).toBe(
      'Automático: esforço baixo.'
    )
  })

  it('fallback numa dimensão só: a nota diz qual', () => {
    const note = autoExecutionNote({
      model: 'claude-sonnet-5',
      effort: 'high',
      source: { model: 'typesafe', effort: 'fallback' }
    })
    expect(note).toContain('Automático: Sonnet 5, esforço alto.')
    expect(note).toContain('esforço padrão')
    expect(note).not.toContain('par padrão')
    expect(autoExecutionNote({ model: 'claude-opus-5-5', effort: 'low', source: { model: 'fallback' } })).toContain(
      'modelo padrão'
    )
  })

  it('nada automático (ou modelo sem esforço): nada a anunciar', () => {
    expect(autoExecutionNote({ model: 'claude-opus-5-5', effort: 'high', source: {} })).toBeNull()
    expect(autoExecutionNote({ model: 'gpt-oss:120b-cloud', source: {} })).toBeNull()
  })
})

describe('lista de candidatos restrita (o memorista)', () => {
  const memorista = ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5']

  it('só oferece ao serviço os modelos que a lista permite', () => {
    const payload = buildAutoExecutionPayload({ message: 'oi' }, memorista)

    expect(Object.keys((payload?.questions.which_model as { criteria: object }).criteria)).toEqual(memorista)
  })

  it('um modelo fora da lista na resposta é resposta inválida, não escolha', async () => {
    answers('gpt-6-sol', 1)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: memorista })).toMatchObject({
      model: AUTO_MODEL_FALLBACK.model
    })
  })

  it('escolha dentro da lista passa normalmente', async () => {
    answers('claude-sonnet-5', 0)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: memorista })).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'low'
    })
  })

  it('o par padrão de uma lista sem o modelo padrão fica DENTRO dela', async () => {
    askTypeSafe.mockResolvedValue(null)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: ['claude-sonnet-5'] })).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
      source: BOTH_FALLBACK
    })
  })
})

describe('abrir a sessão em Automático', () => {
  const live = { model: 'claude-sonnet-5', effort: 'low' as const }
  /** O mesmo par como a conversa o guarda: escolhido pelo TypeSafe. */
  const decidedLive = { ...live, decided: DECIDED_BOTH }

  it('sem turno não pergunta nada, não anuncia nada e mantém o par que está no ar', async () => {
    const decision = await resolveAutoStart({ live: decidedLive, hasSession: true })

    expect(askTypeSafe).not.toHaveBeenCalled()
    expect(decision.note).toBeNull()
    expect(decision.execution).toEqual({ ...live, source: BOTH_UNPROMPTED })
  })

  it('sem turno e sem sessão viva cai no par padrão, ainda em silêncio', async () => {
    const decision = await resolveAutoStart({ hasSession: false })

    expect(decision.note).toBeNull()
    expect(decision.execution).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: AUTO_MODEL_FALLBACK.effort,
      source: BOTH_UNPROMPTED
    })
  })

  it('sem turno NUNCA reaproveita a sessão: quem religa está pedindo uma nova', async () => {
    expect((await resolveAutoStart({ live: decidedLive, hasSession: true })).reuse).toBe(false)
  })

  it('com turno pergunta, anuncia e reaproveita a sessão quando o par repete', async () => {
    answers('claude-sonnet-5', 0)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'traduz isto' },
      live: decidedLive,
      hasSession: true
    })

    expect(askTypeSafe).toHaveBeenCalledTimes(1)
    expect(decision.execution).toEqual({ ...live, source: BOTH_TYPESAFE })
    expect(decision.reuse).toBe(true)
    expect(decision.note).toBe('Automático: Sonnet 5, esforço baixo.')
  })

  it('com turno e par diferente, a sessão viva não serve', async () => {
    answers('claude-opus-5-5', 4)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'projeta isto' },
      live: decidedLive,
      hasSession: true
    })

    expect(decision.reuse).toBe(false)
    expect(decision.execution).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
  })

  it('par repetido sem sessão viva não é reaproveitamento', async () => {
    answers('claude-sonnet-5', 0)

    expect(
      (await resolveAutoStart({ autoPrompt: { message: 'oi' }, live: decidedLive, hasSession: false })).reuse
    ).toBe(false)
  })

  it('com turno, a queda do serviço AÍ sim é anunciada', async () => {
    askTypeSafe.mockResolvedValue(null)

    const decision = await resolveAutoStart({ autoPrompt: { message: 'oi' }, hasSession: false })

    expect(decision.note).toContain('par padrão')
    expect(decision.execution.source).toEqual(BOTH_FALLBACK)
  })
})
