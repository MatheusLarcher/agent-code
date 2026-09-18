// @vitest-environment node
// Código do processo principal: a cadeia de imports chega a `node:sqlite` via
// config → store, que o ambiente jsdom padrão não consegue externalizar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'

const state = {
  config: DEFAULT_CONFIG as AppConfig,
  secret: null as string | null,
  secretThrows: false
}

vi.mock('../config', () => ({ loadConfig: () => state.config }))
vi.mock('../memory/memoryRuntime', () => ({
  readSecret: async () => {
    if (state.secretThrows) throw new Error('cofre indisponível')
    return state.secret
  }
}))
const recordTypeSafeUsage = vi.fn(async () => undefined)
vi.mock('./usage', () => ({ recordTypeSafeUsage }))

const systemOne = vi.fn()
vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: class {
    constructor(readonly config: { apiKey?: string }) {
      if (!config.apiKey) throw new Error('missing api key')
    }
    systemOne = systemOne
  }
}))

const { askTypeSafe, typeSafeApiKey, typeSafeEnabled, typeSafeMinConfidence, TYPESAFE_TIMEOUT_MS } =
  await import('./client')

function config(typesafe: Partial<AppConfig['typesafe']>): void {
  state.config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, ...typesafe } }
}

const QUESTIONS = { q: { type: 'noul' as const, instructions: 'é sobre cobrança?' } }
const ANSWER = { answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } }

beforeEach(() => {
  state.secret = null
  state.secretThrows = false
  config({ enabled: true, apiKey: 'key-da-config' })
  systemOne.mockReset()
  systemOne.mockResolvedValue(ANSWER)
  recordTypeSafeUsage.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cliente TypeSafe', () => {
  it('responde e contabiliza o uso quando está ligado e com chave', async () => {
    const answers = await askTypeSafe({ state: 'oi', questions: QUESTIONS })

    expect(answers).toEqual(ANSWER.answers)
    expect(recordTypeSafeUsage).toHaveBeenCalledWith(ANSWER.usage)
  })

  it('usa 8s e NENHUMA retentativa — a chamada fica na frente do envio do usuário', async () => {
    await askTypeSafe({ state: 'oi', questions: QUESTIONS })

    expect(systemOne).toHaveBeenCalledWith(
      { state: 'oi', questions: QUESTIONS },
      expect.objectContaining({ timeout: TYPESAFE_TIMEOUT_MS, retry: { maxRetries: 0 } })
    )
    expect(TYPESAFE_TIMEOUT_MS).toBe(8000)
  })

  it('não chama o serviço com o recurso desligado', async () => {
    config({ enabled: false, apiKey: 'key-da-config' })

    expect(await askTypeSafe({ state: 'oi', questions: QUESTIONS })).toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
    expect(typeSafeEnabled()).toBe(false)
  })

  it('devolve vazio sem chave nenhuma, sem tentar construir o cliente', async () => {
    config({ enabled: true, apiKey: '   ' })

    expect(await askTypeSafe({ state: 'oi', questions: QUESTIONS })).toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('cai no cofre de segredos quando a chave da config está vazia', async () => {
    config({ enabled: true, apiKey: '' })
    state.secret = '  key-do-cofre  '

    expect(await typeSafeApiKey()).toBe('key-do-cofre')
    expect(await askTypeSafe({ state: 'oi', questions: QUESTIONS })).toEqual(ANSWER.answers)
  })

  it('prefere a chave da config à do cofre', async () => {
    state.secret = 'key-do-cofre'

    expect(await typeSafeApiKey()).toBe('key-da-config')
  })

  it('trata falha do cofre como ausência de chave', async () => {
    config({ enabled: true, apiKey: '' })
    state.secretThrows = true

    expect(await typeSafeApiKey()).toBeNull()
    expect(await askTypeSafe({ state: 'oi', questions: QUESTIONS })).toBeNull()
  })

  it.each([
    ['timeout', Object.assign(new Error('timed out'), { name: 'APITimeoutError' })],
    ['erro HTTP', Object.assign(new Error('401 Unauthorized'), { name: 'AuthenticationError', status: 401 })],
    ['queda de rede', Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' })]
  ])('nunca lança em %s — devolve vazio e o chamador segue', async (_caso, error) => {
    systemOne.mockRejectedValue(error)

    await expect(askTypeSafe({ state: 'oi', questions: QUESTIONS })).resolves.toBeNull()
  })

  it('não vaza a chave nem o state no log de erro', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    systemOne.mockRejectedValue(new Error('falhou'))

    await askTypeSafe({ state: 'conteúdo sigiloso da conversa', questions: QUESTIONS })

    const texto = logged.mock.calls.flat().join(' ')
    expect(texto).not.toContain('key-da-config')
    expect(texto).not.toContain('conteúdo sigiloso')
  })

  it('não gasta uma chamada com pergunta nenhuma', async () => {
    expect(await askTypeSafe({ state: 'oi', questions: {} })).toBeNull()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('expõe o limiar de confiança configurado', () => {
    config({ enabled: true, minConfidence: 0.8 })

    expect(typeSafeMinConfidence()).toBe(0.8)
  })
})
