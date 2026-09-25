// @vitest-environment node
// Código do processo principal: a cadeia de imports chega a `node:sqlite` via
// config → store, que o ambiente jsdom padrão não consegue externalizar.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'

const state = {
  config: DEFAULT_CONFIG as AppConfig,
  secret: null as string | null
}

vi.mock('../config', () => ({ loadConfig: () => state.config }))
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
  buildMemoryGateState,
  memoryGateActive,
  shouldSaveMemory,
  MEMORY_GATE_MAX_ANSWER_CHARS,
  MEMORY_GATE_MAX_DOCS_INDEX_CHARS,
  MEMORY_GATE_MAX_HEADER_CHARS,
  MEMORY_GATE_MAX_HEADERS,
  MEMORY_GATE_MAX_STATE_CHARS,
  MEMORY_GATE_MAX_USED,
  MEMORY_GATE_MAX_USED_CHARS,
  MEMORY_GATE_MAX_USER_CHARS
} = await import('./memoryGate')
const { typeSafePause } = await import('./pause')

function config(typesafe: Partial<AppConfig['typesafe']>): void {
  state.config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, ...typesafe } }
}

/** Uma resposta `noul`: um número só, P(sim). Não há campo de confiança. */
function answer(noul: number): unknown {
  return { answers: { salvar: { type: 'noul', noul } }, usage: { input_tokens: 10, output_tokens: 1 } }
}

/** O `state` efetivamente enviado ao serviço. */
function sentState(): Record<string, unknown> {
  return systemOne.mock.calls[0]![0].state
}

beforeEach(() => {
  // A pausa é do processo: uma falha de um teste não pode calar o seguinte.
  typeSafePause.reset()
  systemOne.mockReset()
  state.secret = null
  config({ enabled: true, apiKey: 'sk-teste' })
})

const turn = {
  userText: 'aqui a prefeitura retém 5% de ISS acima de 5 mil',
  answerText: 'Entendi. Vou considerar a retenção de 5%.',
  usedMemories: ['fiscal/nota.md'],
  memoryHeaders: ['fiscal/nota.md — Nota de serviço: ao emitir nota'],
  docsIndex: '[PROJECT_DOCS_INDEX]\ndocs/\n  ARQUITETURA.md\n    # Arquitetura\n[/PROJECT_DOCS_INDEX]'
}

describe('Gate de memória — o veredito é `noul >= limiar`, não confiança', () => {
  it('P(sim) acima do piso aprova', async () => {
    systemOne.mockResolvedValueOnce(answer(0.92))
    await expect(shouldSaveMemory(turn)).resolves.toBe(true)
  })

  it('P(sim) baixíssimo é um NÃO fortíssimo, nunca "sem decisão"', async () => {
    // `noul = 0,05` significa "quase certamente não". Tratá-lo como resposta
    // incerta (devolvendo `null`) faria o memorista rodar justamente no turno
    // em que o serviço mais tinha certeza de que não valia.
    systemOne.mockResolvedValueOnce(answer(0.05))
    await expect(shouldSaveMemory(turn)).resolves.toBe(false)
  })

  it('acima do acaso mas abaixo do piso ainda é não', async () => {
    config({ enabled: true, apiKey: 'sk-teste', minConfidence: 0.6 })
    systemOne.mockResolvedValueOnce(answer(0.55))
    await expect(shouldSaveMemory(turn)).resolves.toBe(false)
  })

  it('o piso vem da configuração do usuário', async () => {
    config({ enabled: true, apiKey: 'sk-teste', minConfidence: 0.5 })
    systemOne.mockResolvedValueOnce(answer(0.55))
    await expect(shouldSaveMemory(turn)).resolves.toBe(true)
  })

  it('resposta sem número utilizável não decide nada', async () => {
    systemOne.mockResolvedValueOnce({ answers: { salvar: { type: 'noul', noul: Number.NaN } }, usage: {} })
    await expect(shouldSaveMemory(turn)).resolves.toBeNull()
  })
})

describe('Gate de memória — indisponível NUNCA vira "não"', () => {
  it('recurso desligado devolve null', async () => {
    config({ enabled: false, apiKey: 'sk-teste' })
    await expect(shouldSaveMemory(turn)).resolves.toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('sem chave devolve null', async () => {
    config({ enabled: true, apiKey: '' })
    await expect(shouldSaveMemory(turn)).resolves.toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('timeout/erro do serviço devolve null', async () => {
    systemOne.mockRejectedValueOnce(new Error('timeout'))
    await expect(shouldSaveMemory(turn)).resolves.toBeNull()
  })

  it('o gate só está ativo com recurso ligado E chave', async () => {
    await expect(memoryGateActive()).resolves.toBe(true)
    config({ enabled: true, apiKey: '' })
    await expect(memoryGateActive()).resolves.toBe(false)
    config({ enabled: false, apiKey: 'sk-teste' })
    await expect(memoryGateActive()).resolves.toBe(false)
  })
})

describe('Gate de memória — o que o serviço vê', () => {
  it('recebe pergunta, resposta, memórias usadas, cabeçalhos e o ÍNDICE do docs', async () => {
    systemOne.mockResolvedValueOnce(answer(0.8))
    await shouldSaveMemory(turn)

    const sent = sentState()
    expect(sent.pergunta_do_usuario).toContain('retém 5% de ISS')
    expect(sent.resposta_do_agente).toContain('retenção de 5%')
    expect(sent.memorias_usadas_neste_turno).toEqual(['fiscal/nota.md'])
    expect(sent.memorias_ja_salvas).toEqual(['fiscal/nota.md — Nota de serviço: ao emitir nota'])
    expect(String(sent.indice_do_docs)).toContain('[PROJECT_DOCS_INDEX]')
  })

  it('o gate da mensagem do usuário roda sem resposta do agente', async () => {
    systemOne.mockResolvedValueOnce(answer(0.8))
    await shouldSaveMemory({ ...turn, answerText: undefined })
    expect(sentState().resposta_do_agente).toBe('')
  })

  it('o state é cortado: o limite do Jev é 32k tokens, e o docs inteiro passa de 85k', () => {
    const built = buildMemoryGateState({
      userText: 'x'.repeat(50_000),
      answerText: 'y'.repeat(50_000),
      memoryHeaders: Array.from({ length: MEMORY_GATE_MAX_HEADERS + 30 }, (_, i) => `mem-${i}.md — título: gancho`),
      docsIndex: 'z'.repeat(MEMORY_GATE_MAX_DOCS_INDEX_CHARS * 2),
      usedMemories: Array.from({ length: 40 }, (_, i) => `usada-${i}.md`)
    })

    expect(built.resposta_do_agente.length).toBeLessThanOrEqual(MEMORY_GATE_MAX_ANSWER_CHARS)
    expect(built.memorias_ja_salvas).toHaveLength(MEMORY_GATE_MAX_HEADERS)
    expect(built.memorias_ja_salvas_omitidas).toBe(30)
    expect(built.indice_do_docs).toHaveLength(MEMORY_GATE_MAX_DOCS_INDEX_CHARS)
    expect(built.memorias_usadas_neste_turno.length).toBeLessThanOrEqual(10)
  })

  /**
   * O PIOR caso de verdade. O teste acima usava cabeçalhos de ~26 caracteres,
   * não os 200 do limite, e por isso confirmava um orçamento ("bem menos de 60k
   * caracteres") que a conta real não sustenta: 4k + 6k + 10×200 + 120×200 + 30k
   * = 66k. Aqui cada campo vai NO teto dele.
   */
  it('cada campo no seu teto: o `state` respeita o orçamento que o módulo documenta', () => {
    const built = buildMemoryGateState({
      userText: 'u'.repeat(MEMORY_GATE_MAX_USER_CHARS * 2),
      answerText: 'a'.repeat(MEMORY_GATE_MAX_ANSWER_CHARS * 2),
      // Cabeçalhos no comprimento MÁXIMO, que é onde a conta antiga furava.
      memoryHeaders: Array.from(
        { length: MEMORY_GATE_MAX_HEADERS * 2 },
        (_, i) => `h${i}`.padEnd(MEMORY_GATE_MAX_HEADER_CHARS * 2, 'H')
      ),
      // Caminhos absurdos: sem o corte, este campo não teria teto nenhum e o
      // "orçamento" seria uma estimativa, não um limite.
      usedMemories: Array.from({ length: MEMORY_GATE_MAX_USED * 3 }, (_, i) => `u${i}`.padEnd(5_000, 'P')),
      docsIndex: 'd'.repeat(MEMORY_GATE_MAX_DOCS_INDEX_CHARS * 2)
    })

    for (const header of built.memorias_ja_salvas) expect(header.length).toBe(MEMORY_GATE_MAX_HEADER_CHARS)
    for (const used of built.memorias_usadas_neste_turno) expect(used.length).toBe(MEMORY_GATE_MAX_USED_CHARS)

    const chars =
      built.pergunta_do_usuario.length +
      built.resposta_do_agente.length +
      built.memorias_usadas_neste_turno.join('').length +
      built.memorias_ja_salvas.join('').length +
      built.indice_do_docs.length
    expect(chars).toBe(MEMORY_GATE_MAX_STATE_CHARS)
    // 66k caracteres ficam em ~17k–22k tokens de português: cabe nos 32k do Jev,
    // com folga de ~1,5x. O envelope JSON (chaves, aspas, vírgulas) é pequeno.
    expect(JSON.stringify(built).length).toBeLessThan(MEMORY_GATE_MAX_STATE_CHARS + 1_000)
  })
})
