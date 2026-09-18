// @vitest-environment node
// Código do processo principal: `./client` é trocado por um duplo, então a
// cadeia config → store → `node:sqlite` nunca é carregada aqui.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_MODEL_FALLBACK, clampEffortToModel, DEFAULT_EFFORT, EFFORT_LEVELS } from '../../shared/ipc'

const askTypeSafe = vi.fn()
/** O piso configurado pelo usuário. O padrão do app é 0,2. */
const minConfidence = { value: 0.2 }
vi.mock('./client', () => ({ askTypeSafe, typeSafeMinConfidence: () => minConfidence.value }))

const {
  autoEffortCandidates,
  autoExecutionNote,
  autoExecutionUnprompted,
  autoModelCandidates,
  buildAutoExecutionPayload,
  chooseAutoExecution,
  effortFromScore,
  resolveAutoStart,
  AUTO_MODEL_DESCRIPTIONS,
  AUTO_MODEL_INSTRUCTION,
  AUTO_NO_LIVE_MODEL
} = await import('./execution')

/** Uma resposta de `choice` como o serviço a devolve. */
function choiceAnswer(model: string, confidence = 0.7): unknown {
  return { type: 'choice', choice: model, confidence, probabilities: { [model]: confidence } }
}

/** Uma resposta de `score`: o número pode cair ENTRE dois degraus. */
function scoreAnswer(value: number, confidence = 0.6): unknown {
  return { type: 'score', score: value, confidence, legend: {}, probabilities: {} }
}

function answers(model: string, score: number): void {
  askTypeSafe.mockResolvedValue({ which_model: choiceAnswer(model), which_effort: scoreAnswer(score) })
}

beforeEach(() => {
  askTypeSafe.mockReset()
  minConfidence.value = 0.2
  answers('claude-sonnet-5', 1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('candidatos', () => {
  it('oferece os modelos reais do seletor, e cada um com descrição', () => {
    const models = autoModelCandidates()

    expect(models).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5-1'
    ])
    // Sem descrição o Jev escolheria pelo nome do modelo, não pelo trabalho pedido.
    for (const model of models) expect(AUTO_MODEL_DESCRIPTIONS[model]).toBeTruthy()
  })

  it('oferece a escada de esforço INTEIRA, na ordem', () => {
    expect(autoEffortCandidates()).toEqual([...EFFORT_LEVELS])
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
    // `score`, e não `choice`: a escala é ordenada, e o meio-termo precisa ser
    // um número — com `choice` ele viraria empate resolvido por argmax.
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
  it('Haiku para em `high`: `max` nunca chega ao provedor', async () => {
    answers('claude-haiku-4-5', 4)

    expect(await chooseAutoExecution({ message: 'traduz isto' })).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
      source: 'typesafe'
    })
  })

  it('o recorte é DEPOIS das duas respostas — modelo capaz mantém `max`', async () => {
    answers('claude-opus-5', 4)

    expect(await chooseAutoExecution({ message: 'projeta a arquitetura do zero' })).toMatchObject({
      model: 'claude-opus-5',
      effort: 'max'
    })
  })

  it('clampEffortToModel desce para o teto do modelo, nunca sobe', () => {
    expect(clampEffortToModel('claude-haiku-4-5', 'max')).toBe('high')
    expect(clampEffortToModel('claude-haiku-4-5', 'xhigh')).toBe('high')
    expect(clampEffortToModel('claude-haiku-4-5', 'low')).toBe('low')
    expect(clampEffortToModel('claude-opus-5', 'max')).toBe('max')
  })

  it('modelo sem tabela de esforço não tem contra o que recortar', () => {
    expect(clampEffortToModel('gpt-oss:120b-cloud', 'max')).toBe('max')
    expect(clampEffortToModel(undefined, 'low')).toBe('low')
  })
})

describe('falha nunca trava o envio', () => {
  const fallback = {
    model: AUTO_MODEL_FALLBACK.model,
    effort: AUTO_MODEL_FALLBACK.effort,
    source: 'fallback' as const
  }

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
    // Sem mensagem não havia o que decidir. Marcar de `fallback` faria a UI
    // dizer que o serviço não respondeu, com ele no ar.
    expect(await chooseAutoExecution({ message: '   ' })).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: AUTO_MODEL_FALLBACK.effort,
      source: 'unprompted'
    })
    expect(askTypeSafe).not.toHaveBeenCalled()
  })

  it('uma exceção inesperada vira par padrão, não rejeição', async () => {
    askTypeSafe.mockRejectedValue(new Error('formato novo'))

    await expect(chooseAutoExecution({ message: 'oi' })).resolves.toEqual(fallback)
  })

  it('modelo desconhecido na resposta cai no padrão em vez de virar `--model`', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-inventado-9'),
      which_effort: scoreAnswer(1)
    })

    expect(await chooseAutoExecution({ message: 'oi' })).toMatchObject({
      model: AUTO_MODEL_FALLBACK.model
    })
  })

  it('resposta só de modelo usa o esforço padrão', async () => {
    askTypeSafe.mockResolvedValue({ which_model: choiceAnswer('claude-sonnet-5') })

    expect(await chooseAutoExecution({ message: 'oi' })).toEqual({
      model: 'claude-sonnet-5',
      effort: DEFAULT_EFFORT,
      source: 'typesafe'
    })
  })
})

describe('a nota que a UI mostra', () => {
  it('diz o modelo e o esforço do turno', () => {
    expect(autoExecutionNote({ model: 'claude-sonnet-5', effort: 'medium', source: 'typesafe' })).toBe(
      'Automático: Sonnet 5, esforço médio.'
    )
  })

  it('avisa quando o par é o padrão, para a escolha não parecer uma decisão', () => {
    expect(autoExecutionNote({ model: 'claude-opus-5', effort: 'high', source: 'fallback' })).toContain(
      'par padrão'
    )
  })

  it('não anuncia nada quando não havia turno para decidir', () => {
    // O defeito que isto tranca: dizer "o TypeSafe não respondeu a tempo ou
    // está desligado" com o serviço no ar, só porque ninguém enviou mensagem.
    expect(autoExecutionNote({ model: 'claude-opus-5', effort: 'high', source: 'unprompted' })).toBeNull()
  })
})

describe('lista de candidatos restrita (o memorista)', () => {
  const memorista = ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']

  it('só oferece ao serviço os modelos que a lista permite', () => {
    const payload = buildAutoExecutionPayload({ message: 'oi' }, memorista)

    expect(Object.keys((payload?.questions.which_model as { criteria: object }).criteria)).toEqual(memorista)
  })

  it('um modelo fora da lista na resposta é resposta inválida, não escolha', async () => {
    // Fable 5.1 é um modelo REAL — e mais caro que o topo da lista do
    // memorista. Aceitá-lo poria o observador acima do teto que o usuário
    // consegue escolher para ele à mão.
    answers('claude-fable-5-1', 1)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: memorista })).toMatchObject({
      model: AUTO_MODEL_FALLBACK.model
    })
  })

  it('escolha dentro da lista passa normalmente', async () => {
    answers('claude-haiku-4-5', 0)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: memorista })).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low'
    })
  })

  it('o par padrão de uma lista sem o modelo padrão fica DENTRO dela', async () => {
    askTypeSafe.mockResolvedValue(null)

    expect(await chooseAutoExecution({ message: 'oi' }, { models: ['claude-haiku-4-5'] })).toMatchObject({
      model: 'claude-haiku-4-5',
      // Recortado ao teto do modelo: o padrão `high` é o máximo do Haiku.
      effort: 'high',
      source: 'fallback'
    })
  })
})

describe('abrir a sessão em Automático', () => {
  const live = { model: 'claude-haiku-4-5', effort: 'low' as const }
  /** O mesmo par como a conversa o guarda: escolhido pelo TypeSafe. */
  const decidedLive = { ...live, decided: true }

  it('sem turno não pergunta nada, não anuncia nada e mantém o par que está no ar', async () => {
    // Botão Conectar, reconexão depois de trocar a configuração, recuperação.
    const decision = await resolveAutoStart({ live: decidedLive, hasSession: true })

    expect(askTypeSafe).not.toHaveBeenCalled()
    expect(decision.note).toBeNull()
    expect(decision.execution).toEqual({ ...live, source: 'unprompted' })
  })

  it('sem turno e sem sessão viva cai no par padrão, ainda em silêncio', async () => {
    const decision = await resolveAutoStart({ hasSession: false })

    expect(decision.note).toBeNull()
    expect(decision.execution).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: AUTO_MODEL_FALLBACK.effort,
      source: 'unprompted'
    })
  })

  it('sem turno NUNCA reaproveita a sessão: quem religa está pedindo uma nova', async () => {
    // A config mudou (ou a sessão se perdeu). Devolver `reuse` aqui engoliria
    // justamente a mudança que motivou o religar.
    expect((await resolveAutoStart({ live: decidedLive, hasSession: true })).reuse).toBe(false)
  })

  it('com turno pergunta, anuncia e reaproveita a sessão quando o par repete', async () => {
    answers('claude-haiku-4-5', 0)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'traduz isto' },
      live: decidedLive,
      hasSession: true
    })

    expect(askTypeSafe).toHaveBeenCalledTimes(1)
    expect(decision.execution).toEqual({ ...live, source: 'typesafe' })
    expect(decision.reuse).toBe(true)
    expect(decision.note).toBe('Automático: Haiku 4.5, esforço baixo.')
  })

  it('com turno e par diferente, a sessão viva não serve', async () => {
    answers('claude-opus-5', 4)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'projeta isto' },
      live: decidedLive,
      hasSession: true
    })

    expect(decision.reuse).toBe(false)
    expect(decision.execution).toMatchObject({ model: 'claude-opus-5', effort: 'max' })
  })

  it('par repetido sem sessão viva não é reaproveitamento', async () => {
    answers('claude-haiku-4-5', 0)

    expect(
      (await resolveAutoStart({ autoPrompt: { message: 'oi' }, live: decidedLive, hasSession: false })).reuse
    ).toBe(false)
  })

  it('com turno, a queda do serviço AÍ sim é anunciada', async () => {
    askTypeSafe.mockResolvedValue(null)

    const decision = await resolveAutoStart({ autoPrompt: { message: 'oi' }, hasSession: false })

    expect(decision.note).toContain('par padrão')
    expect(decision.execution.source).toBe('fallback')
  })
})

/**
 * Histerese. O cache de prompt da Anthropic é POR MODELO: voltar ao Opus depois
 * de um turno no Haiku paga o prefixo inteiro sem cache (1x de leitura + 1,25x
 * de escrita, contra 0,1x de um acerto). Numa conversa longa, alternar a cada
 * turno pode custar mais do que a economia do turno barato — o recurso se
 * pagaria ao contrário. Daí o par vivo entrar na decisão em vez de ficar só na
 * comparação de reaproveitamento.
 */
describe('histerese: o par que já está no ar entra na decisão', () => {
  const live = { model: 'claude-opus-5', effort: 'high' as const }
  /** O mesmo par como a conversa o guarda: escolhido pelo TypeSafe. */
  const decidedLive = { ...live, decided: true }

  it('o modelo no ar vai no `state`, e a instrução manda mantê-lo sem motivo claro', async () => {
    await chooseAutoExecution({ message: 'e agora?' }, { live })

    const [request] = askTypeSafe.mock.calls[0]
    expect(request.state.modelo_atual).toBe('claude-opus-5')
    expect(AUTO_MODEL_INSTRUCTION).toContain('state.modelo_atual')
    expect(AUTO_MODEL_INSTRUCTION).toContain('MANTENHA')
  })

  it('conversa nova manda o rótulo de "nenhum", nunca um campo vazio', async () => {
    await chooseAutoExecution({ message: 'oi' })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
  })

  it('um par no ar fora da lista de candidatos não é anunciado — a resposta seria inválida', async () => {
    // O memorista restringe a lista dele; anunciar um modelo que a pergunta não
    // oferece convidaria a uma escolha impossível.
    await chooseAutoExecution({ message: 'oi' }, { live, models: ['claude-haiku-4-5', 'claude-sonnet-5'] })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
  })

  it('escolha CONFIANTE troca o modelo normalmente — a histerese não congela a decisão', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.9),
      which_effort: scoreAnswer(0, 0.9)
    })

    expect(await chooseAutoExecution({ message: 'traduz isto' }, { live })).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      source: 'typesafe'
    })
  })

  it('escolha FRACA mantém o par vivo: 0,15 não troca o modelo de uma conversa', async () => {
    // `typeSafeMinConfidence()` existe desde sempre e a escolha de execução o
    // ignorava — 0,15 valia tanto quanto 0,95.
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.15),
      which_effort: scoreAnswer(0, 0.15)
    })

    expect(await chooseAutoExecution({ message: 'e aí?' }, { live })).toEqual({ ...live, source: 'typesafe' })
  })

  it('o piso é o do usuário: subindo `minConfidence`, uma escolha antes aceita passa a manter o par', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.7),
      which_effort: scoreAnswer(0, 0.7)
    })
    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toMatchObject({ model: 'claude-haiku-4-5' })

    minConfidence.value = 0.8
    expect(await chooseAutoExecution({ message: 'oi' }, { live })).toMatchObject({ model: 'claude-opus-5' })
  })

  it('sem par no ar, confiança baixa continua valendo: não há para onde recuar', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.2),
      which_effort: scoreAnswer(0, 0.2)
    })

    expect(await chooseAutoExecution({ message: 'oi' })).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low'
    })
  })

  it('resposta sem confiança declarada é aceita — ausência de número não é desconfiança', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: { type: 'choice', choice: 'claude-haiku-4-5', probabilities: {} },
      which_effort: scoreAnswer(0, 0.9)
    })

    expect(await chooseAutoExecution({ message: 'traduz' }, { live })).toMatchObject({ model: 'claude-haiku-4-5' })
  })

  it('o par recuado continua sendo recortado para o que o modelo suporta', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-opus-5', 0.1),
      which_effort: scoreAnswer(4, 0.1)
    })

    // Par vivo inválido (Haiku para em `high`): o recuo não pode reintroduzi-lo cru.
    expect(
      await chooseAutoExecution({ message: 'oi' }, { live: { model: 'claude-haiku-4-5', effort: 'max' } })
    ).toEqual({ model: 'claude-haiku-4-5', effort: 'high', source: 'typesafe' })
  })

  it('`resolveAutoStart` repassa o par da conversa — não é opção só de quem chama direto', async () => {
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.1),
      which_effort: scoreAnswer(0, 0.1)
    })

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'e agora?' },
      live: decidedLive,
      hasSession: true
    })

    expect(askTypeSafe.mock.calls[0][0].state.modelo_atual).toBe('claude-opus-5')
    // Manteve o par: a sessão viva serve, e nada é recriado.
    expect(decision.execution).toEqual({ ...live, source: 'typesafe' })
    expect(decision.reuse).toBe(true)
  })

  it('a queda do serviço continua caindo no par padrão, não no par vivo', async () => {
    // Mexer nisto é mudar o comportamento de fallback — decisão do usuário.
    askTypeSafe.mockResolvedValue(null)

    const decision = await resolveAutoStart({ autoPrompt: { message: 'oi' }, live: decidedLive, hasSession: true })

    expect(decision.execution).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: clampEffortToModel(AUTO_MODEL_FALLBACK.model, AUTO_MODEL_FALLBACK.effort),
      source: 'fallback'
    })
  })
})

describe('o par que sobrevive a um religar', () => {
  it('um par inválido guardado não passa adiante sem recorte', () => {
    // `autoSessions` guarda o que foi escolhido; se algum dia entrar ali um par
    // que o modelo não suporta, ele não pode voltar ao provedor como está.
    expect(autoExecutionUnprompted({ model: 'claude-haiku-4-5', effort: 'max' })).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
      source: 'unprompted'
    })
  })
})

/**
 * O fallback é para ser TRANSITÓRIO.
 *
 * A histerese manda manter o par vivo e o recuo por confiança baixa volta para
 * ele — os dois defendem o que estiver guardado como vivo. Guardar ali o par do
 * `fallback` (que é `AUTO_MODEL_FALLBACK`, o modelo mais caro) fazia uma queda
 * momentânea do serviço virar uma escolha permanente que ninguém tomou: o turno
 * seguinte defendia o Opus mesmo com o TypeSafe de volta.
 */
describe('o par do fallback não se defende no turno seguinte', () => {
  it('o par do fallback roda a sessão, mas não é guardado como decisão', async () => {
    askTypeSafe.mockResolvedValue(null)

    const turno = await resolveAutoStart({ autoPrompt: { message: 'oi' }, hasSession: false })

    // A mensagem sai no par padrão: isso não muda.
    expect(turno.execution.source).toBe('fallback')
    expect(turno.live).toEqual({
      model: AUTO_MODEL_FALLBACK.model,
      effort: clampEffortToModel(AUTO_MODEL_FALLBACK.model, AUTO_MODEL_FALLBACK.effort),
      decided: false
    })
  })

  it('serviço fora no 1º turno não prende o 2º no modelo mais caro', async () => {
    // 1º turno: TypeSafe fora do ar. A mensagem sai no par padrão (Opus).
    askTypeSafe.mockResolvedValue(null)
    const primeiro = await resolveAutoStart({ autoPrompt: { message: 'e agora?' }, hasSession: false })
    expect(primeiro.execution).toMatchObject({ model: 'claude-opus-5', source: 'fallback' })

    // 2º turno: serviço de volta, mensagem trivial, e a escolha vem ABAIXO do
    // piso de confiança — exatamente o caso em que o recuo defenderia o par
    // vivo. Como o par vivo veio do fallback, não há decisão a defender.
    askTypeSafe.mockResolvedValue({
      which_model: choiceAnswer('claude-haiku-4-5', 0.3),
      which_effort: scoreAnswer(0, 0.3)
    })
    const segundo = await resolveAutoStart({
      autoPrompt: { message: 'traduz isto' },
      live: primeiro.live,
      hasSession: true
    })

    expect(segundo.execution).toEqual({ model: 'claude-haiku-4-5', effort: 'low', source: 'typesafe' })
    // A pergunta também não anuncia o Opus como `modelo_atual`: a instrução ali
    // manda MANTER o par, e um par inventado não é para ser mantido.
    expect(askTypeSafe.mock.calls[1][0].state.modelo_atual).toBe(AUTO_NO_LIVE_MODEL)
    // E a partir daqui há o que defender: a escolha do 2º turno é uma decisão.
    expect(segundo.live).toEqual({ model: 'claude-haiku-4-5', effort: 'low', decided: true })
  })

  it('`unprompted` continua preservando o par vivo, e preserva também a origem dele', async () => {
    // Religar não é um turno: não decide nem desfaz decisão. Confundir isto com
    // `fallback` reintroduziria o defeito que o M4 fechou.
    const depoisDeDecisao = await resolveAutoStart({
      live: { model: 'claude-haiku-4-5', effort: 'low', decided: true },
      hasSession: true
    })
    expect(depoisDeDecisao.execution).toEqual({ model: 'claude-haiku-4-5', effort: 'low', source: 'unprompted' })
    expect(depoisDeDecisao.live).toEqual({ model: 'claude-haiku-4-5', effort: 'low', decided: true })

    // E um religar não lava um fallback em decisão.
    const depoisDeFallback = await resolveAutoStart({
      live: { model: 'claude-opus-5', effort: 'high', decided: false },
      hasSession: true
    })
    expect(depoisDeFallback.execution).toEqual({ model: 'claude-opus-5', effort: 'high', source: 'unprompted' })
    expect(depoisDeFallback.live.decided).toBe(false)
  })

  it('o reaproveitamento da sessão continua olhando o par REAL, decidido ou não', async () => {
    // A sessão existe e está no par do fallback; se a decisão desta vez repetir
    // esse par, recriar a sessão seria pagar um boot por nada.
    answers('claude-opus-5', 2)

    const decision = await resolveAutoStart({
      autoPrompt: { message: 'e aí?' },
      live: { model: 'claude-opus-5', effort: 'high', decided: false },
      hasSession: true
    })

    expect(decision.reuse).toBe(true)
    expect(decision.live).toEqual({ model: 'claude-opus-5', effort: 'high', decided: true })
  })
})
