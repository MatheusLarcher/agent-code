import { describe, expect, it, vi } from 'vitest'
import { testKimiConnection, windowFromContextLength } from './kimiConnection'

const KEY = 'sk-kimi-teste'

type Route = (url: string, init: RequestInit) => { status: number; body: unknown }

function fakeFetch(route: Route): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = route(String(input), init ?? {})
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const MODELS_PLUS = { data: [{ id: 'k3.1-pro', context_length: 262_144 }, { id: 'k3.1-pro-highspeed', context_length: 1_048_576 }, { id: 'k3' }] }

describe('windowFromContextLength', () => {
  it('1M ou mais = 1048576; o resto (ou ausente) = 262144', () => {
    expect(windowFromContextLength(1_048_576)).toBe(1_048_576)
    expect(windowFromContextLength(262_144)).toBe(262_144)
    expect(windowFromContextLength(undefined)).toBe(262_144)
  })
})

describe('testKimiConnection', () => {
  it('plano Plus: região intl, janela 256K, só K3.1 Pro (Highspeed dá 403)', async () => {
    const f = fakeFetch((url, init) => {
      if (url.endsWith('/v1/models')) return { status: 200, body: MODELS_PLUS }
      const model = JSON.parse(String(init.body)).model
      return model === 'k3.1-pro' ? { status: 200, body: {} } : { status: 403, body: { error: { type: 'permission_error' } } }
    })
    const r = await testKimiConnection(KEY, { fetchImpl: f })
    expect(r).toMatchObject({ ok: true, region: 'intl', contextWindow: 262_144, models: ['k3.1-pro'] })
    expect(r.message).toContain('K3.1 Pro')
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('manda a chave só no Authorization, com o User-Agent do app e sem cabeçalhos de outro cliente', async () => {
    const f = fakeFetch(() => ({ status: 200, body: MODELS_PLUS }))
    await testKimiConnection(KEY, { fetchImpl: f, appVersion: '9.9.9' })
    const headers = (vi.mocked(f).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    expect(headers['user-agent']).toBe('AgentCode/9.9.9')
    expect(Object.keys(headers).some((h) => h.toLowerCase().startsWith('x-msh'))).toBe(false)
  })

  it('429 transitório: K3.1 Pro conta como liberado, Highspeed não (só o 403 é sinal de plano)', async () => {
    const f = fakeFetch((url) => (url.endsWith('/v1/models') ? { status: 200, body: MODELS_PLUS } : { status: 429, body: {} }))
    const r = await testKimiConnection(KEY, { fetchImpl: f })
    expect(r).toMatchObject({ ok: true, models: ['k3.1-pro'] })
  })

  it('chave recusada na intl tenta a cn', async () => {
    const f = fakeFetch((url) => (url.startsWith('https://api.kimi.ai') ? { status: 401, body: {} } : { status: 200, body: MODELS_PLUS }))
    const r = await testKimiConnection(KEY, { fetchImpl: f })
    expect(r.region).toBe('cn')
  })

  it('401 nas duas regiões = chave inválida', async () => {
    const r = await testKimiConnection(KEY, { fetchImpl: fakeFetch(() => ({ status: 401, body: {} })) })
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/inválida ou expirada/)
  })

  it('plano sem K3.1 Pro: chave ok, mas nenhum modelo liberado', async () => {
    const f = fakeFetch((url) => (url.endsWith('/v1/models') ? { status: 200, body: MODELS_PLUS } : { status: 403, body: {} }))
    const r = await testKimiConnection(KEY, { fetchImpl: f })
    expect(r).toMatchObject({ ok: false, region: 'intl' })
    expect(r.message).toMatch(/não libera o K3.1 Pro/)
  })

  it('sem chave não chama a rede; falha de rede vira mensagem', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }))
    expect((await testKimiConnection('  ', { fetchImpl: f })).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect((await testKimiConnection(KEY, { fetchImpl: broken })).message).toMatch(/sem conexão/)
  })
})
