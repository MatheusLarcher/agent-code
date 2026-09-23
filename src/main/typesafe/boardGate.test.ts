// @vitest-environment node
// Código do processo principal: a cadeia de imports chega a `node:sqlite` via
// config → store, que o ambiente jsdom padrão não consegue externalizar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'

const state = {
  config: DEFAULT_CONFIG as AppConfig,
  secret: null as string | null,
  configThrows: false
}

vi.mock('../config', () => ({
  loadConfig: () => {
    if (state.configThrows) throw new Error('config ilegível')
    return state.config
  }
}))
vi.mock('../memory/memoryRuntime', () => ({ readSecret: async () => state.secret }))
vi.mock('./usage', () => ({ recordTypeSafeUsage: vi.fn(async () => undefined) }))

const systemOne = vi.fn()
vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: class {
    constructor(readonly config: { apiKey?: string }) {
      if (!config.apiKey) throw new Error('missing api key')
    }
    systemOne = systemOne
  },
  // O mesmo construtor puro do SDK: monta o objeto da pergunta, não fala com a rede.
  noul: (instructions: unknown, criteria: unknown) => ({ type: 'noul', instructions, criteria })
}))

const {
  boardGateActive,
  buildBoardGateState,
  shouldRunPo,
  BOARD_GATE_CLOSE_QUESTION,
  BOARD_GATE_MAX_CALL_CHARS,
  BOARD_GATE_MAX_CALLS,
  BOARD_GATE_MAX_CARD_CHARS,
  BOARD_GATE_MAX_CARDS,
  BOARD_GATE_MAX_STATE_CHARS,
  BOARD_GATE_MAX_TASK_CHARS,
  BOARD_GATE_MAX_TASKS,
  BOARD_GATE_MAX_USER_CHARS,
  BOARD_GATE_OPEN_QUESTION
} = await import('./boardGate')
type BoardGateInput = import('./boardGate').BoardGateInput

function config(typesafe: Partial<AppConfig['typesafe']>): void {
  state.config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, ...typesafe } }
}

/** Uma resposta `noul`: um número só, P(sim). */
function answer(noul: number): unknown {
  return { answers: { rodar: { type: 'noul', noul } }, usage: { input_tokens: 10, output_tokens: 1 } }
}

/** O pedido efetivamente enviado ao serviço. */
function sent(): { state: Record<string, unknown>; questions: { rodar: { instructions: string; criteria: unknown } } } {
  return systemOne.mock.calls[0]![0]
}

beforeEach(() => {
  systemOne.mockReset()
  state.secret = null
  state.configThrows = false
  config({ enabled: true, apiKey: 'sk-teste', minConfidence: 0.6 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const open: BoardGateInput = {
  phase: 'open',
  userText: 'corrige a exportação de XML',
  cards: [{ title: 'Corrigir a exportação de XML', status: 'pending' }],
  calls: [],
  ledgerTasks: []
}

const close: BoardGateInput = {
  phase: 'close',
  userText: 'corrige a exportação de XML',
  cards: [{ title: 'Corrigir a exportação de XML', status: 'in_progress' }],
  calls: [{ tool: 'Edit', detail: 'src/xml.ts' }, { tool: 'Bash', detail: 'npx vitest run' }],
  ledgerTasks: [{ title: 'Exportação de XML', status: 'done' }]
}

describe('Gate do quadro — o veredito é `noul >= limiar`, não confiança', () => {
  it.each([open, close])('P(sim) acima do piso aprova na fase $phase', async (input) => {
    systemOne.mockResolvedValueOnce(answer(0.9))
    await expect(shouldRunPo(input)).resolves.toBe(true)
  })

  it.each([open, close])('P(sim) baixíssimo é um NÃO fortíssimo na fase $phase, nunca "sem decisão"', async (input) => {
    systemOne.mockResolvedValueOnce(answer(0.04))
    await expect(shouldRunPo(input)).resolves.toBe(false)
  })

  it('o piso vem da configuração do usuário', async () => {
    systemOne.mockResolvedValueOnce(answer(0.55))
    await expect(shouldRunPo(open)).resolves.toBe(false)
    config({ enabled: true, apiKey: 'sk-teste', minConfidence: 0.5 })
    systemOne.mockResolvedValueOnce(answer(0.55))
    await expect(shouldRunPo(open)).resolves.toBe(true)
  })

  it('resposta sem número utilizável não decide nada', async () => {
    systemOne.mockResolvedValueOnce({ answers: { rodar: { type: 'noul', noul: Number.NaN } }, usage: {} })
    await expect(shouldRunPo(close)).resolves.toBeNull()
  })
})

describe('Gate do quadro — cada fase faz a SUA pergunta', () => {
  it('a abertura pergunta se o pedido é trabalho que deve aparecer no quadro', async () => {
    systemOne.mockResolvedValueOnce(answer(0.9))
    await shouldRunPo(open)
    expect(sent().questions.rodar.instructions).toBe(BOARD_GATE_OPEN_QUESTION)
    expect(BOARD_GATE_OPEN_QUESTION).toMatch(/pergunta.*opini.*agradecimento.*status.*conversa/s)
  })

  it('o fechamento pergunta se o turno mudou o estado de algum trabalho', async () => {
    systemOne.mockResolvedValueOnce(answer(0.9))
    await shouldRunPo(close)
    expect(sent().questions.rodar.instructions).toBe(BOARD_GATE_CLOSE_QUESTION)
    expect(BOARD_GATE_CLOSE_QUESTION).toContain('status errado')
    expect(BOARD_GATE_CLOSE_QUESTION).toMatch(/não só quando o turno foi conversa/)
  })

  it('os critérios também mudam de uma fase para a outra', async () => {
    systemOne.mockResolvedValue(answer(0.9))
    await shouldRunPo(open)
    await shouldRunPo(close)
    const [first, second] = systemOne.mock.calls.map((call) => call[0].questions.rodar.criteria)
    expect(first).not.toEqual(second)
  })
})

describe('Gate do quadro — indisponível NUNCA vira "não"', () => {
  it('recurso desligado devolve null sem chamar o serviço', async () => {
    config({ enabled: false, apiKey: 'sk-teste' })
    await expect(shouldRunPo(open)).resolves.toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('sem chave devolve null sem chamar o serviço', async () => {
    config({ enabled: true, apiKey: '' })
    await expect(shouldRunPo(close)).resolves.toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('timeout/erro do serviço devolve null, e o log leva só a mensagem — nunca o state', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    systemOne.mockRejectedValueOnce(new Error('timeout'))
    await expect(shouldRunPo({ ...close, userText: 'SEGREDO-DO-PEDIDO' })).resolves.toBeNull()
    const logged = errors.mock.calls.flat().map(String).join('\n')
    expect(logged).toContain('timeout')
    expect(logged).not.toContain('SEGREDO-DO-PEDIDO')
    expect(logged).not.toContain('src/xml.ts')
  })

  it('entrada malformada não lança: vira null, com log só da mensagem', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = { ...close, cards: [null] } as unknown as BoardGateInput
    await expect(shouldRunPo(broken)).resolves.toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
    expect(errors.mock.calls.flat().map(String).join('\n')).toContain('[typesafe] gate do quadro descartado')
  })

  it('o gate só está ativo com recurso ligado E chave — e nunca lança', async () => {
    await expect(boardGateActive()).resolves.toBe(true)
    config({ enabled: true, apiKey: '' })
    await expect(boardGateActive()).resolves.toBe(false)
    state.secret = 'sk-do-cofre'
    await expect(boardGateActive()).resolves.toBe(true)
    config({ enabled: false, apiKey: 'sk-teste' })
    await expect(boardGateActive()).resolves.toBe(false)
    state.configThrows = true
    await expect(boardGateActive()).resolves.toBe(false)
  })
})

describe('Gate do quadro — o que o serviço vê', () => {
  it('recebe o pedido, o quadro com status legível, as ações e as tarefas do registro', async () => {
    systemOne.mockResolvedValueOnce(answer(0.9))
    await shouldRunPo(close)
    expect(sent().state).toEqual({
      pedido_do_usuario: 'corrige a exportação de XML',
      quadro: ['[em andamento] Corrigir a exportação de XML'],
      quadro_omitidos: 0,
      acoes_do_turno: ['Edit: src/xml.ts', 'Bash: npx vitest run'],
      acoes_omitidas: 0,
      tarefas_do_registro: ['[done] Exportação de XML'],
      tarefas_omitidas: 0
    })
  })

  it('pedido vazio vira um marcador, não um campo em branco', () => {
    expect(buildBoardGateState({ ...open, userText: '   ' }).pedido_do_usuario).toBe('(sem texto)')
  })

  it('guarda as ÚLTIMAS ações — a evidência do que terminou está no fim do turno', () => {
    const calls = Array.from({ length: BOARD_GATE_MAX_CALLS + 7 }, (_, i) => ({ tool: 'Read', detail: `arquivo-${i}.ts` }))
    const built = buildBoardGateState({ ...close, calls })
    expect(built.acoes_do_turno).toHaveLength(BOARD_GATE_MAX_CALLS)
    expect(built.acoes_do_turno[0]).toBe('Read: arquivo-7.ts')
    expect(built.acoes_do_turno.at(-1)).toBe(`Read: arquivo-${BOARD_GATE_MAX_CALLS + 6}.ts`)
    expect(built.acoes_omitidas).toBe(7)
  })

  /**
   * O PIOR caso de verdade: cada campo NO teto dele, com entradas no comprimento
   * máximo — é onde a conta do gate de memória furou uma vez.
   */
  it('cada campo no seu teto: o `state` respeita o orçamento documentado e cabe nos 32k tokens do Jev', () => {
    const built = buildBoardGateState({
      phase: 'close',
      userText: 'u'.repeat(BOARD_GATE_MAX_USER_CHARS * 3),
      cards: Array.from({ length: BOARD_GATE_MAX_CARDS * 2 }, (_, i) => ({
        title: `c${i}`.padEnd(BOARD_GATE_MAX_CARD_CHARS * 2, 'C'),
        status: 'in_progress'
      })),
      calls: Array.from({ length: BOARD_GATE_MAX_CALLS * 2 }, (_, i) => ({
        tool: 'Bash',
        detail: `k${i}`.padEnd(BOARD_GATE_MAX_CALL_CHARS * 2, 'K')
      })),
      ledgerTasks: Array.from({ length: BOARD_GATE_MAX_TASKS * 2 }, (_, i) => ({
        title: `t${i}`.padEnd(BOARD_GATE_MAX_TASK_CHARS * 2, 'T'),
        status: 'running'
      }))
    })

    expect(built.pedido_do_usuario).toHaveLength(BOARD_GATE_MAX_USER_CHARS)
    expect(built.quadro).toHaveLength(BOARD_GATE_MAX_CARDS)
    expect(built.quadro_omitidos).toBe(BOARD_GATE_MAX_CARDS)
    expect(built.acoes_do_turno).toHaveLength(BOARD_GATE_MAX_CALLS)
    expect(built.tarefas_do_registro).toHaveLength(BOARD_GATE_MAX_TASKS)
    for (const card of built.quadro) expect(card).toHaveLength(BOARD_GATE_MAX_CARD_CHARS)
    for (const call of built.acoes_do_turno) expect(call).toHaveLength(BOARD_GATE_MAX_CALL_CHARS)
    for (const task of built.tarefas_do_registro) expect(task).toHaveLength(BOARD_GATE_MAX_TASK_CHARS)

    const chars =
      built.pedido_do_usuario.length +
      built.quadro.join('').length +
      built.acoes_do_turno.join('').length +
      built.tarefas_do_registro.join('').length
    expect(chars).toBe(BOARD_GATE_MAX_STATE_CHARS)
    expect(BOARD_GATE_MAX_STATE_CHARS).toBe(23_200)
    // Mesmo a 1 caractere por token (bem pior que o português real), o JSON
    // inteiro — envelope incluído — fica abaixo dos 32k tokens do Jev.
    expect(JSON.stringify(built).length).toBeLessThan(32_000)
  })
})
