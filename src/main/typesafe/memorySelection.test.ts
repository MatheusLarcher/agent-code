// @vitest-environment node
// Código do processo principal: a cadeia de imports chega a `node:sqlite` via
// config → store, que o ambiente jsdom padrão não consegue externalizar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  choice: (instructions: unknown, criteria: unknown) => ({ type: 'choice', instructions, criteria })
}))

const {
  memorySelectionThreshold,
  selectMemoriesWithTypeSafe,
  typeSafeMemorySelectionActive,
  MEMORY_CHOICE_MAX_MEMORIES,
  MEMORY_CHOICE_MAX_OPTIONS,
  MEMORY_RANK_SCAN_MAX,
  MEMORY_SELECTION_MAX,
  MEMORY_SELECTION_MIN_LIFT,
  MEMORY_SELECTION_NONE
} = await import('./memorySelection')
const { typeSafePause } = await import('./pause')

function config(typesafe: Partial<AppConfig['typesafe']>): void {
  state.config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, ...typesafe } }
}

/** Uma resposta `choice` com as probabilidades informadas. */
function answer(probabilities: Record<string, number>): unknown {
  const [best] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  return {
    answers: { memoria: { type: 'choice', choice: best?.[0], confidence: best?.[1], probabilities } },
    usage: { input_tokens: 10, output_tokens: 2 }
  }
}

/** Payload da pergunta efetivamente enviada ao serviço. */
function sentQuestion(): { type: string; instructions: unknown; criteria: Record<string, string> } {
  return systemOne.mock.calls[0]![0].questions.memoria
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-sel-'))
  await writeFile(join(dir, 'MEMORY.md'), '# Memórias\n\n- [Raiz](raiz.md) — na raiz\n', 'utf8')
  await writeFile(join(dir, 'raiz.md'), '---\ndescription: fato solto na raiz\n---\n# Raiz\nUm fato.\n', 'utf8')
  await mkdir(join(dir, '2D'))
  await writeFile(
    join(dir, '2D', 'erp.md'),
    `---\ndescription: ERP da 2D usa o banco FALCAO\n---\n# ERP da 2D\n${'detalhe do ERP. '.repeat(400)}FIM_DO_ARQUIVO\n`,
    'utf8'
  )
  await writeFile(join(dir, '2D', 'nota.md'), '---\ndescription: nota fiscal\n---\n# Nota fiscal\nOutra coisa.\n', 'utf8')
  return dir
}

beforeEach(() => {
  // A pausa é do processo: uma falha de um teste não pode calar o seguinte.
  typeSafePause.reset()
  state.secret = null
  config({ enabled: true, apiKey: 'key-da-config' })
  systemOne.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('seleção de memória pelo TypeSafe', () => {
  it('manda UMA pergunta com o cabeçalho de cada candidata — e nenhum corpo', async () => {
    const dir = await fixture()
    systemOne.mockResolvedValue(answer({ '2D/erp.md': 0.9, '2D/nota.md': 0.05, 'raiz.md': 0.05 }))

    await selectMemoriesWithTypeSafe(dir, 'como está o ERP?')

    expect(systemOne).toHaveBeenCalledTimes(1)
    const question = sentQuestion()
    expect(question.type).toBe('choice')
    expect(Object.keys(question.criteria).sort()).toEqual([
      MEMORY_SELECTION_NONE,
      '2D/erp.md',
      '2D/nota.md',
      'raiz.md'
    ].sort())
    expect(question.criteria['2D/erp.md']).toBe('ERP da 2D — ERP da 2D usa o banco FALCAO')
    // O corpo da memória nunca viaja no cabeçalho.
    expect(JSON.stringify(question.criteria)).not.toContain('detalhe do ERP')
  })

  it('injeta a memória INTEIRA relida do disco no momento do request, sem corte em 1600 chars', async () => {
    const dir = await fixture()
    // O arquivo muda DEPOIS da varredura de candidatas e antes da resposta: o
    // que entra no prompt tem de ser o conteúdo atual, não o que foi lido antes.
    systemOne.mockImplementation(async () => {
      await writeFile(
        join(dir, '2D', 'erp.md'),
        `---\ndescription: ERP da 2D usa o banco FALCAO\n---\n# ERP da 2D\n${'detalhe do ERP. '.repeat(400)}CONTEUDO_ATUALIZADO\n`,
        'utf8'
      )
      return answer({ '2D/erp.md': 0.9, '2D/nota.md': 0.05, 'raiz.md': 0.05 })
    })

    const selection = await selectMemoriesWithTypeSafe(dir, 'como está o ERP?')

    expect(selection!.block).toContain('--- Memória relevante: 2D/erp.md ---')
    expect(selection!.block).toContain('CONTEUDO_ATUALIZADO')
    expect(selection!.block).not.toContain('FIM_DO_ARQUIVO')
    expect(selection!.block.length).toBeGreaterThan(1_600)
  })

  it('devolve os relPath escolhidos junto do bloco — é o que o gate do memorista consome', async () => {
    const dir = await fixture()
    systemOne.mockResolvedValue(answer({ '2D/erp.md': 0.6, 'raiz.md': 0.35, '2D/nota.md': 0.05 }))

    const selection = await selectMemoriesWithTypeSafe(dir, 'como está o ERP?')

    // Mesma escolha nos dois campos, na mesma ordem: bloco e caminhos não podem divergir.
    expect(selection!.relPaths).toEqual(['2D/erp.md'])
    expect(selection!.block).toContain('--- Memória relevante: 2D/erp.md ---')
  })

  it('memória que sumiu do disco entre a escolha e a releitura não entra em nenhum dos dois', async () => {
    const dir = await fixture()
    systemOne.mockImplementation(async () => {
      await rm(join(dir, '2D', 'nota.md'))
      return answer({ '2D/erp.md': 0.5, '2D/nota.md': 0.45, 'raiz.md': 0.05 })
    })

    const selection = await selectMemoriesWithTypeSafe(dir, 'erp e nota')

    // O gate tem de ver o que o agente RECEBEU, não o que o serviço apontou.
    expect(selection!.relPaths).toEqual(['2D/erp.md'])
    expect(selection!.block).not.toContain('2D/nota.md')
  })

  it('escolhe no máximo 3, em ordem decrescente de probabilidade e sem repetir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-sel-'))
    for (let i = 0; i < 80; i++) {
      await writeFile(join(dir, `m${i}.md`), `---\ndescription: memória ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
    }
    // Limiar = 8/80 = 0,1. Quatro candidatas passam; só as três melhores entram.
    const probabilities: Record<string, number> = {}
    for (let i = 0; i < 80; i++) probabilities[`m${i}.md`] = 0.001
    Object.assign(probabilities, { 'm3.md': 0.45, 'm7.md': 0.2, 'm1.md': 0.15, 'm9.md': 0.12 })
    systemOne.mockResolvedValue(answer(probabilities))

    const selection = await selectMemoriesWithTypeSafe(dir, 'alguma coisa')

    const chosen = [...selection!.block.matchAll(/--- Memória relevante: (.+?) ---/g)].map((m) => m[1])
    expect(chosen).toEqual(['m3.md', 'm7.md', 'm1.md'])
    expect(selection!.relPaths).toEqual(chosen)
    expect(chosen.length).toBeLessThanOrEqual(MEMORY_SELECTION_MAX)
    expect(new Set(chosen).size).toBe(chosen.length)
  })

  it('distribuição espalhada devolve ZERO memória — e zero não é falha', async () => {
    const dir = await fixture()
    systemOne.mockResolvedValue(answer({ '2D/erp.md': 0.34, '2D/nota.md': 0.33, 'raiz.md': 0.33 }))

    // Com 3 candidatas o limiar é a maioria simples: 0,34 não é escolha, é empate.
    // Decisão de ZERO memórias é um objeto vazio — não `null`, que significaria
    // "não houve decisão" e devolveria o turno ao caminho lexical.
    expect(await selectMemoriesWithTypeSafe(dir, 'oi')).toEqual({ block: '', relPaths: [] })
  })

  it('o corte é lift sobre o acaso, não piso absoluto de confiança', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-sel-'))
    for (let i = 0; i < 227; i++) {
      await writeFile(join(dir, `m${i}.md`), `---\ndescription: memória ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
    }
    const probabilities: Record<string, number> = {}
    for (let i = 0; i < 227; i++) probabilities[`m${i}.md`] = (1 - 0.2) / 226
    probabilities['m42.md'] = 0.2
    systemOne.mockResolvedValue(answer(probabilities))

    // 0,2 reprovaria em qualquer piso de 0,6 (typeSafeMinConfidence), mas é 45x
    // o acaso de 1/227: é exatamente a escolha que o usuário quer no prompt.
    expect(memorySelectionThreshold(227)).toBeCloseTo(MEMORY_SELECTION_MIN_LIFT / 227, 6)
    expect(memorySelectionThreshold(227)).toBeLessThan(0.2)
    expect((await selectMemoriesWithTypeSafe(dir, 'sobre a 42'))!.block).toContain('--- Memória relevante: m42.md ---')
  })

  it('o limiar nunca passa da maioria simples, senão pasta pequena jamais escolheria', () => {
    expect(memorySelectionThreshold(1)).toBe(0.5)
    expect(memorySelectionThreshold(4)).toBe(0.5)
    expect(memorySelectionThreshold(16)).toBe(0.5)
    expect(memorySelectionThreshold(64)).toBeCloseTo(0.125, 6)
  })

  it('acima do teto de 255 opções, pré-filtra pelo score lexical que já existe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-sel-'))
    for (let i = 0; i < 300; i++) {
      await writeFile(join(dir, `m${String(i).padStart(3, '0')}.md`), `---\ndescription: assunto ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
    }
    // Só esta casa com a mensagem — e o nome a joga para o fim da ordem alfabética,
    // então só o ranqueamento lexical pode salvá-la do corte.
    await writeFile(join(dir, 'zz-falcao.md'), '---\ndescription: o banco FALCAO do ERP\n---\n# FALCAO\nO banco exclusivo.\n', 'utf8')
    systemOne.mockResolvedValue(answer({ 'zz-falcao.md': 0.9 }))

    const selection = await selectMemoriesWithTypeSafe(dir, 'me lembra do FALCAO')

    const criteria = sentQuestion().criteria
    // O teto de OPÇÕES conta o rótulo sentinela: 254 memórias + `__nenhuma__`.
    expect(Object.keys(criteria)).toHaveLength(MEMORY_CHOICE_MAX_OPTIONS)
    expect(Object.keys(criteria).filter((label) => label !== MEMORY_SELECTION_NONE)).toHaveLength(
      MEMORY_CHOICE_MAX_MEMORIES
    )
    expect(criteria).toHaveProperty('zz-falcao.md')
    expect(selection!.block).toContain('--- Memória relevante: zz-falcao.md ---')
  })

  it('redige referência de cofre e atribuição de credencial no texto injetado', async () => {
    const dir = await fixture()
    await writeFile(join(dir, 'raiz.md'), '# Credencial ERP\napi_key: valor-real-nunca-vaza\n{{secret:erp-token}}\n', 'utf8')
    systemOne.mockResolvedValue(answer({ 'raiz.md': 0.9, '2D/erp.md': 0.05, '2D/nota.md': 0.05 }))

    const block = (await selectMemoriesWithTypeSafe(dir, 'credencial do ERP'))!.block

    expect(block).toContain('api_key: [redacted]')
    expect(block).toContain('[secret reference withheld]')
    expect(block).not.toContain('valor-real-nunca-vaza')
    expect(block).not.toContain('{{secret:erp-token}}')
  })

  it('ignora rótulo que o serviço devolva fora da lista de candidatas', async () => {
    const dir = await fixture()
    systemOne.mockResolvedValue(answer({ '../../../etc/passwd': 0.99, '2D/erp.md': 0.005, '2D/nota.md': 0.005 }))

    expect(await selectMemoriesWithTypeSafe(dir, 'qualquer coisa')).toEqual({ block: '', relPaths: [] })
  })

  it.each([
    ['desligado', () => config({ enabled: false, apiKey: 'key-da-config' })],
    ['sem chave', () => config({ enabled: true, apiKey: '   ' })]
  ])('%s: devolve null sem chamar o serviço, e o chamador volta ao caminho de sempre', async (_caso, arrange) => {
    const dir = await fixture()
    arrange()

    expect(await selectMemoriesWithTypeSafe(dir, 'como está o ERP?')).toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it.each([
    ['timeout', Object.assign(new Error('timed out'), { name: 'APITimeoutError' })],
    ['erro HTTP', Object.assign(new Error('401 Unauthorized'), { name: 'AuthenticationError' })]
  ])('%s devolve null — nunca lança e nunca inventa escolha', async (_caso, error) => {
    const dir = await fixture()
    systemOne.mockRejectedValue(error)

    await expect(selectMemoriesWithTypeSafe(dir, 'como está o ERP?')).resolves.toBeNull()
  })

  it('pasta de memórias vazia é decisão sem memória, não falha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-sel-'))
    systemOne.mockResolvedValue(answer({}))

    expect(await selectMemoriesWithTypeSafe(dir, 'oi')).toEqual({ block: '', relPaths: [] })
    expect(systemOne).not.toHaveBeenCalled()
  })

  /**
   * O rótulo sentinela. `choice` é escolha FORÇADA — a distribuição soma 1 entre
   * os rótulos oferecidos —, então sem ele a pasta pequena não tinha como
   * devolver zero memórias: com N=1 o topo é 1,0 e com N=2 é ≥ 0,5, os dois
   * acima do limiar. "Zero memórias quando nada é relevante" era acidente
   * estatístico do N grande.
   */
  describe('rótulo __nenhuma__: onde a distribuição deposita a massa quando nada serve', () => {
    /** Uma pasta com exatamente `count` memórias, todas sobre assuntos distintos. */
    async function pasta(count: number): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'mem-sel-n-'))
      for (let i = 0; i < count; i++) {
        await writeFile(join(dir, `m${i}.md`), `---\ndescription: memória ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
      }
      return dir
    }

    it('é oferecido junto das candidatas, sempre — inclusive com UMA memória na pasta', async () => {
      const dir = await pasta(1)
      systemOne.mockResolvedValue(answer({ 'm0.md': 0.4, [MEMORY_SELECTION_NONE]: 0.6 }))

      await selectMemoriesWithTypeSafe(dir, 'oi')

      const criteria = sentQuestion().criteria
      expect(Object.keys(criteria).sort()).toEqual([MEMORY_SELECTION_NONE, 'm0.md'])
      // A instrução precisa dizer que o rótulo existe, senão ele fica sem sentido.
      expect(String(sentQuestion().instructions)).toContain(MEMORY_SELECTION_NONE)
    })

    it.each([1, 2, 227])(
      'N=%i: quando __nenhuma__ vence, o resultado é ZERO memórias (e não `null`)',
      async (n) => {
        const dir = await pasta(n)
        const probabilities: Record<string, number> = { [MEMORY_SELECTION_NONE]: 0.6 }
        for (let i = 0; i < n; i++) probabilities[`m${i}.md`] = 0.4 / n
        systemOne.mockResolvedValue(answer(probabilities))

        // `null` mandaria o turno de volta ao caminho lexical; o esperado é a
        // decisão explícita de não injetar memória nenhuma.
        expect(await selectMemoriesWithTypeSafe(dir, 'oi')).toEqual({ block: '', relPaths: [] })
      }
    )

    it('N=1: sem o sentinela o topo seria 1,0 por construção — com ele, "oi" não injeta nada', async () => {
      const dir = await pasta(1)
      // A massa que a escolha forçada empurraria para `m0.md` tem onde ficar.
      systemOne.mockResolvedValue(answer({ 'm0.md': 0.08, [MEMORY_SELECTION_NONE]: 0.92 }))

      expect((await selectMemoriesWithTypeSafe(dir, 'oi'))!.relPaths).toEqual([])
    })

    it('N=2: a memória que o modelo de fato quer continua entrando', async () => {
      const dir = await pasta(2)
      systemOne.mockResolvedValue(answer({ 'm1.md': 0.85, 'm0.md': 0.1, [MEMORY_SELECTION_NONE]: 0.05 }))

      const selection = await selectMemoriesWithTypeSafe(dir, 'sobre a 1')

      expect(selection!.relPaths).toEqual(['m1.md'])
      expect(selection!.block).toContain('--- Memória relevante: m1.md ---')
    })

    it('N=227: o sentinela é o PISO da rodada — nada abaixo dele entra, mesmo passando no lift', async () => {
      const dir = await pasta(227)
      const probabilities: Record<string, number> = {}
      for (let i = 0; i < 227; i++) probabilities[`m${i}.md`] = 0.0005
      // 0,1 é 22x o acaso de 1/227 e passa folgado no limiar de lift...
      probabilities['m42.md'] = 0.1
      // ...mas o modelo pôs mais massa em "nada serve" do que na melhor candidata.
      probabilities[MEMORY_SELECTION_NONE] = 0.25
      systemOne.mockResolvedValue(answer(probabilities))

      expect(memorySelectionThreshold(227)).toBeLessThan(0.1)
      expect(await selectMemoriesWithTypeSafe(dir, 'oi')).toEqual({ block: '', relPaths: [] })
    })

    it('N=227: perdendo do topo, o sentinela não atrapalha quem ele não vence', async () => {
      const dir = await pasta(227)
      const probabilities: Record<string, number> = {}
      for (let i = 0; i < 227; i++) probabilities[`m${i}.md`] = 0.0005
      probabilities['m42.md'] = 0.3
      probabilities['m7.md'] = 0.2
      probabilities[MEMORY_SELECTION_NONE] = 0.25
      systemOne.mockResolvedValue(answer(probabilities))

      // Só a que supera o sentinela: 0,2 < 0,25 fica de fora, apesar do lift alto.
      expect((await selectMemoriesWithTypeSafe(dir, 'sobre a 42'))!.relPaths).toEqual(['m42.md'])
    })

    it('rótulo ausente na resposta é massa ZERO em "nada serve", não um piso inventado', async () => {
      const dir = await pasta(2)
      // Um serviço que não devolva o rótulo não pode bloquear toda escolha.
      systemOne.mockResolvedValue(answer({ 'm0.md': 0.9, 'm1.md': 0.1 }))

      expect((await selectMemoriesWithTypeSafe(dir, 'sobre a 0'))!.relPaths).toEqual(['m0.md'])
    })

    it('o sentinela nunca vira uma memória: não é caminho de arquivo e não vaza para o bloco', async () => {
      const dir = await pasta(2)
      systemOne.mockResolvedValue(answer({ [MEMORY_SELECTION_NONE]: 0.9, 'm0.md': 0.05, 'm1.md': 0.05 }))

      const selection = await selectMemoriesWithTypeSafe(dir, 'oi')

      expect(selection!.relPaths).not.toContain(MEMORY_SELECTION_NONE)
      expect(selection!.block).not.toContain(MEMORY_SELECTION_NONE)
    })
  })

  it('o pré-filtro lexical tem teto de LEITURA: acima dele a cauda não é aberta do disco', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mem-sel-teto-'))
    const extras = 40
    for (let i = 0; i < MEMORY_RANK_SCAN_MAX + extras; i++) {
      await writeFile(join(dir, `m${String(i).padStart(4, '0')}.md`), `---\ndescription: assunto ${i}\n---\n# M${i}\ncorpo ${i}\n`, 'utf8')
    }
    systemOne.mockResolvedValue(answer({ [MEMORY_SELECTION_NONE]: 0.9 }))

    await selectMemoriesWithTypeSafe(dir, 'alguma coisa')

    // A pergunta continua cheia (o teto de leitura é maior que o de opções)...
    const criteria = sentQuestion().criteria
    expect(Object.keys(criteria)).toHaveLength(MEMORY_CHOICE_MAX_OPTIONS)
    // ...e nenhuma candidata veio da cauda que o teto cortou: sem isso, o
    // ranqueador leria N arquivos SÍNCRONOS no processo main a cada mensagem.
    for (let i = MEMORY_RANK_SCAN_MAX; i < MEMORY_RANK_SCAN_MAX + extras; i++) {
      expect(criteria).not.toHaveProperty(`m${String(i).padStart(4, '0')}.md`)
    }
  })

  it('só governa a injeção de memória quando está ligado E tem chave', async () => {
    expect(await typeSafeMemorySelectionActive()).toBe(true)

    config({ enabled: true, apiKey: '' })
    expect(await typeSafeMemorySelectionActive()).toBe(false)

    state.secret = 'key-do-cofre'
    expect(await typeSafeMemorySelectionActive()).toBe(true)

    config({ enabled: false, apiKey: 'key-da-config' })
    expect(await typeSafeMemorySelectionActive()).toBe(false)
  })
})
