// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startKimiRouterServer, type KimiRouterCredential, type KimiRouterHandle } from './kimiRouter'
import { anthropicHeaders, claudeUnavailable, hoistInlineTools, kimiHeaders, routeFor } from './kimiRouterRules'

const SECRET = 'segredo-teste'
const KIMI_KEY = 'sk-kimi-falsa'
const CLAUDE_TOKEN = 'sk-ant-oat01-falso'
const SYSTEM = "x — it's clickable.\n\nWrite code that reads like the surrounding code: y"

interface Call { url: string; headers: Record<string, string>; body: string }

let handle: KimiRouterHandle | null = null
afterEach(async () => {
  await handle?.close()
  handle = null
})

function upstreams(anthropic: (c: Call) => Response, kimi: (c: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body
    const body = raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw ? String(raw) : ''
    const call: Call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body }
    calls.push(call)
    return call.url.startsWith('http://anthropic.falso') ? anthropic(call) : kimi(call)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const ok = (text = 'ok'): Response => new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const cred = (over: Partial<KimiRouterCredential> = {}): KimiRouterCredential => ({ apiKey: KIMI_KEY, region: 'intl', contextWindow: 262_144, orgInstructions: '', ...over })

async function start(fetchImpl: typeof fetch, credential: () => KimiRouterCredential | null = () => cred(), extra: { logDir?: string; onAuxReserve?: (id: string) => void } = {}) {
  handle = await startKimiRouterServer({
    credential,
    secret: SECRET,
    fetchImpl,
    anthropicBase: 'http://anthropic.falso',
    kimiBase: () => 'http://kimi.falso/coding',
    ...extra
  })
  return `http://127.0.0.1:${handle.port}/${SECRET}`
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CLAUDE_TOKEN}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.304', 'x-claude-code-session-id': 'sess-1', ...headers },
    body: JSON.stringify(body)
  })
}

describe('regras puras', () => {
  it('destino pelo modelo', () => {
    expect(routeFor('k3.1-pro')).toBe('kimi')
    expect(routeFor('k3.1-pro[1m]')).toBe('kimi')
    expect(routeFor('k3-256k')).toBe('kimi')
    expect(routeFor('claude-haiku-5-5')).toBe('anthropic')
    expect(routeFor(undefined)).toBe('anthropic')
    expect(routeFor('gpt-6.1')).toBe('reject')
  })

  it('cabeçalhos do Kimi: sem credencial nem beta de OAuth da Anthropic, com a chave e o UA do CLI', () => {
    const h = kimiHeaders({ authorization: `Bearer ${CLAUDE_TOKEN}`, 'anthropic-beta': 'a,oauth-2025-04-20,b', 'user-agent': 'claude-cli/2.1.304', host: 'x' }, KIMI_KEY)
    expect(h).toEqual({ authorization: `Bearer ${KIMI_KEY}`, 'anthropic-beta': 'a,b', 'user-agent': 'claude-cli/2.1.304' })
    expect(Object.keys(h).some((k) => k.toLowerCase().startsWith('x-msh'))).toBe(false)
    expect(anthropicHeaders({ authorization: 'Bearer t', host: 'x', 'content-length': '3' })).toEqual({ authorization: 'Bearer t' })
  })

  it('ferramentas inline (tool_addition) vão para tools, na ordem; mensagem vazia sai', () => {
    const def = (name: string) => ({ name, description: `d-${name}`, input_schema: { type: 'object' } })
    const body: Record<string, unknown> = {
      tools: [def('Read')],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'oi' }] },
        { role: 'system', content: [{ type: 'text', text: '# Environment' }, { type: 'tool_addition', tool: { type: 'tool_definition', definition: def('mcp__a') } }] },
        { role: 'system', content: [{ type: 'tool_addition', tool: { definition: def('mcp__b') } }, { type: 'tool_addition', tool: { definition: def('Read') } }] }
      ]
    }
    expect(hoistInlineTools(body)).toBe(2)
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['Read', 'mcp__a', 'mcp__b'])
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'system', content: [{ type: 'text', text: '# Environment' }] }
    ])
    const plain = { tools: [], messages: [{ role: 'user', content: 'x' }] }
    expect(hoistInlineTools(plain)).toBe(0)
    expect(plain).toEqual({ tools: [], messages: [{ role: 'user', content: 'x' }] })
  })

  it('Claude indisponível: só sem credencial ou com a frase de cota (401 comum não)', () => {
    expect(claudeUnavailable(401, 'invalid token', true)).toBe(false)
    expect(claudeUnavailable(429, 'rate_limit_error: too many requests', true)).toBe(false)
    expect(claudeUnavailable(429, "You've hit your weekly limit", true)).toBe(true)
    expect(claudeUnavailable(200, '', false)).toBe(true)
  })
})

describe('roteador do Kimi', () => {
  it('sem o segredo no caminho: 404 e nenhum upstream chamado', async () => {
    const { calls, fetchImpl } = upstreams(() => ok(), () => ok())
    await start(fetchImpl)
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('modelo Kimi vai ao Kimi com a chave, sem credencial da Anthropic, corpo intacto', async () => {
    const { calls, fetchImpl } = upstreams(() => ok(), () => ok('kimi'))
    const base = await start(fetchImpl)
    const body = { model: 'k3.1-pro', max_tokens: 10, system: [{ type: 'text', text: SYSTEM }], messages: [{ role: 'user', content: 'oi' }] }
    const res = await post(base, body)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('kimi')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://kimi.falso/coding/v1/messages?beta=true')
    expect(calls[0].headers.authorization).toBe(`Bearer ${KIMI_KEY}`)
    expect(JSON.stringify(calls[0].headers)).not.toContain(CLAUDE_TOKEN)
    expect(calls[0].headers['anthropic-beta']).toBe('claude-code-20250219')
    expect(JSON.parse(calls[0].body)).toEqual(body)
  })

  it('modelo Claude e HEAD /api/hello vão à Anthropic intactos (credencial do CLI, sem a chave do Kimi)', async () => {
    const { calls, fetchImpl } = upstreams(() => ok('claude'), () => ok())
    const base = await start(fetchImpl)
    const body = { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'título' }] }
    expect(await (await post(base, body)).text()).toContain('claude')
    await fetch(`${base}/api/hello`, { method: 'HEAD', headers: { authorization: `Bearer ${CLAUDE_TOKEN}` } })
    expect(calls.map((c) => c.url)).toEqual(['http://anthropic.falso/v1/messages?beta=true', 'http://anthropic.falso/api/hello'])
    expect(calls[0].headers.authorization).toBe(`Bearer ${CLAUDE_TOKEN}`)
    expect(calls[0].headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
    expect(JSON.stringify(calls)).not.toContain(KIMI_KEY)
    expect(JSON.parse(calls[0].body)).toEqual(body)
  })

  it('modelo desconhecido: 400 local', async () => {
    const { calls, fetchImpl } = upstreams(() => ok(), () => ok())
    const base = await start(fetchImpl)
    expect((await post(base, { model: 'gpt-6.1', messages: [] })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('instruções da organização entram só no pedido ao Kimi, na âncora', async () => {
    const { calls, fetchImpl } = upstreams(() => ok(), () => ok())
    const base = await start(fetchImpl, () => cred({ orgInstructions: 'Regra da empresa' }))
    await post(base, { model: 'k3.1-pro', system: [{ type: 'text', text: SYSTEM }], messages: [] })
    await post(base, { model: 'claude-haiku-5-5', system: [{ type: 'text', text: SYSTEM }], messages: [] })
    expect(calls[0].body).toContain("it's clickable.CRITICAL: The following are organization-level")
    expect(calls[0].body).toContain('<organizationInstructions>Regra da empresa</organizationInstructions>Write code')
    expect(calls[1].body).not.toContain('organizationInstructions')
  })

  it('Claude com a cota esgotada: o auxiliar repete uma vez no Kimi (k3-256k), avisa e lembra por 5 min', async () => {
    const quota = (): Response => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your weekly limit" } }), { status: 429 })
    const { calls, fetchImpl } = upstreams(quota, () => ok('reserva'))
    const onAuxReserve = vi.fn()
    const base = await start(fetchImpl, () => cred(), { onAuxReserve })
    const res = await post(base, { model: 'claude-haiku-5-5', messages: [] })
    expect(await res.text()).toContain('reserva')
    expect(calls.map((c) => c.url.split('/')[2])).toEqual(['anthropic.falso', 'kimi.falso'])
    expect(JSON.parse(calls[1].body).model).toBe('k3-256k')
    expect(JSON.stringify(calls[1].headers)).not.toContain(CLAUDE_TOKEN)
    expect(onAuxReserve).toHaveBeenCalledWith('sess-1')
    await post(base, { model: 'claude-haiku-5-5', messages: [] })
    expect(calls[2].url.split('/')[2]).toBe('kimi.falso')
  })

  it('401 da Anthropic NÃO liga a reserva (o CLI renova o login)', async () => {
    const { calls, fetchImpl } = upstreams(() => new Response('{"type":"error","error":{"type":"authentication_error","message":"expired"}}', { status: 401 }), () => ok())
    const base = await start(fetchImpl)
    expect((await post(base, { model: 'claude-haiku-5-5', messages: [] })).status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('erros do Kimi traduzidos; Kimi desligado dá 401 claro', async () => {
    const { fetchImpl } = upstreams(() => ok(), () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Your request exceeded model token limit: 262144' } }), { status: 400 }))
    const base = await start(fetchImpl)
    expect(await (await post(base, { model: 'k3.1-pro', messages: [] })).text()).toMatch(/prompt is too long: \d+ tokens > 262144 maximum/)
    await handle!.close()
    handle = null
    const off = await start(fetchImpl, () => null)
    const res = await post(off, { model: 'k3.1-pro', messages: [] })
    expect(res.status).toBe(401)
    expect(await res.text()).toMatch(/Configurações → Kimi/)
  })

  it('registro: um arquivo por pedido, credenciais redigidas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-router-log-'))
    try {
      const { fetchImpl } = upstreams(() => ok(), () => ok())
      const base = await start(fetchImpl, () => cred(), { logDir: dir })
      await post(base, { model: 'k3.1-pro', messages: [] })
      await post(base, { model: 'claude-haiku-5-5', messages: [] })
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      expect(files.sort()).toEqual(['0001-kimi.json', '0002-anthropic.json'])
      const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('')
      expect(all).not.toContain(KIMI_KEY)
      expect(all).not.toContain(CLAUDE_TOKEN)
      expect(all).toContain('<redigido')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
