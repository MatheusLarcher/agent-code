import { describe, expect, it } from 'vitest'
import { DEEPSEEK_BASE_URL, fastModeTransport, modelSupportsFastMode } from '../shared/ipc'
import { deepseekCostUsd, deepseekSessionEnv, fetchDeepSeekBalance, parseDeepSeekBalance, pdfReadDenied } from './deepseek'

describe('custo estimado e saldo', () => {
  it('cache hit $0,006, sem cache $0,30, saída $1,20 por 1M; criação de cache conta como sem cache', () => {
    expect(deepseekCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.3, 10)
    expect(deepseekCostUsd({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1.2, 10)
    expect(deepseekCostUsd({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(0.006, 10)
    expect(deepseekCostUsd({ input: 200_000, output: 50_000, cacheRead: 800_000, cacheWrite: 100_000 })).toBeCloseTo(0.1548, 10)
    expect(deepseekCostUsd(undefined)).toBeNull()
  })

  it('valida a resposta do /user/balance', () => {
    expect(parseDeepSeekBalance({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '50.00' }, { currency: 'USD', total_balance: '12.34' }]
    })).toEqual({ available: true, totalUsd: 12.34 })
    expect(parseDeepSeekBalance({ is_available: false, balance_infos: [] })).toEqual({ available: false, totalUsd: null })
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull()
    expect(parseDeepSeekBalance(null)).toBeNull()
  })

  it('busca com Bearer; sem chave ou com erro devolve null', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.5' }] }))
    }) as unknown as typeof fetch
    expect(await fetchDeepSeekBalance(' chave-falsa ', ok)).toEqual({ available: true, totalUsd: 3.5 })
    expect(calls[0][0]).toBe('https://api.deepseek.com/user/balance')
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer chave-falsa')
    expect(await fetchDeepSeekBalance('', ok)).toBeNull()
    expect(calls).toHaveLength(1)
    const denied = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await fetchDeepSeekBalance('chave-falsa', denied)).toBeNull()
    const down = (async () => { throw new Error('rede') }) as unknown as typeof fetch
    expect(await fetchDeepSeekBalance('chave-falsa', down)).toBeNull()
  })
})

describe('lacunas da API DeepSeek', () => {
  it('Read de .pdf negado só na sessão DeepSeek', () => {
    expect(pdfReadDenied('deepseek-flash', 'Read', { file_path: 'C:\\docs\\Nota.PDF' })).toBe(true)
    expect(pdfReadDenied('deepseek-flash', 'Read', { file_path: '/a/b.png' })).toBe(false)
    expect(pdfReadDenied('deepseek-flash', 'Grep', { file_path: '/a/b.pdf' })).toBe(false)
    expect(pdfReadDenied('claude-opus-5-5', 'Read', { file_path: '/a/b.pdf' })).toBe(false)
    expect(pdfReadDenied('deepseek-flash', 'Read', null)).toBe(false)
  })

  it('modo rápido desligado', () => {
    expect(modelSupportsFastMode('deepseek-flash')).toBe(false)
    expect(fastModeTransport('deepseek-flash')).toBeNull()
  })
})

describe('deepseekSessionEnv', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-falsa', CLAUDE_CONFIG_DIR: '/home/.claude' }
  const env = deepseekSessionEnv(base, 'deepseek-flash', 'chave-falsa', '/cache/cli-config-sem-login')

  it('aponta o CLI para a DeepSeek com o token da chave', () => {
    expect(env.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_BASE_URL)
    expect(DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('chave-falsa')
    expect(env.PATH).toBe('/bin')
  })

  it('nunca herda a credencial nem a pasta de login da Anthropic', () => {
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cache/cli-config-sem-login')
  })

  it('os apelidos e os subagentes vão para o modelo DeepSeek, menos o FABLE', () => {
    for (const k of ['SONNET', 'OPUS', 'HAIKU']) {
      expect(env[`ANTHROPIC_DEFAULT_${k}_MODEL`]).toBe('deepseek-flash')
    }
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-flash')
    // Com o FABLE = modelo, o CLI apresenta o modelo como "Claude Fable 5" (captura de 26/10/2026).
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_FABLE_MODEL')
  })
})
