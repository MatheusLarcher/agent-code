import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_INBOUND_TOKEN } from './mcpConstants'
import { bearerMatches, hostAllowed, McpHttpServer, type McpToolsApi } from './mcpHttpServer'

/** Faixa própria dos testes: não disputa com um Agent Code aberto (47110+). */
const START = 47610

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json: () => any
}

function call(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        // Sem keep-alive: um socket reaproveitado de um servidor já fechado na
        // mesma porta (teste anterior) daria ECONNRESET.
        agent: false,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/mcp',
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers
        }
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }))
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const auth = { Authorization: `Bearer ${MCP_INBOUND_TOKEN}` }

function tools(): McpToolsApi & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    list: () => [{ name: 'eco', description: 'eco', inputSchema: { type: 'object' } }],
    call: async (name, args) => {
      calls.push({ name, args })
      return name === 'eco' ? { value: { ok: true, args: args as Record<string, unknown> } } : null
    }
  }
}

const servers: Array<McpHttpServer | Server> = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s instanceof McpHttpServer) await s.stop()
    else await new Promise<void>((r) => s.close(() => r()))
  }
})

async function start(over: Partial<ConstructorParameters<typeof McpHttpServer>[0]> = {}) {
  const t = tools()
  const server = new McpHttpServer({
    version: '9.9.9',
    readiness: () => ({ pronto: true, motivo: null }),
    tools: t,
    portStart: START,
    portCount: 10,
    ...over
  })
  servers.push(server)
  const port = await server.start()
  const host = { Host: `127.0.0.1:${port}` }
  return { server, port, t, host }
}

describe('checagens de segurança (puras)', () => {
  it('token: só o Bearer exato passa', () => {
    expect(bearerMatches(`Bearer ${MCP_INBOUND_TOKEN}`, MCP_INBOUND_TOKEN)).toBe(true)
    expect(bearerMatches(`bearer   ${MCP_INBOUND_TOKEN}`, MCP_INBOUND_TOKEN)).toBe(true)
    expect(bearerMatches(undefined, MCP_INBOUND_TOKEN)).toBe(false)
    expect(bearerMatches(MCP_INBOUND_TOKEN, MCP_INBOUND_TOKEN)).toBe(false)
    expect(bearerMatches(`Bearer ${MCP_INBOUND_TOKEN}x`, MCP_INBOUND_TOKEN)).toBe(false)
    expect(bearerMatches('Bearer x', MCP_INBOUND_TOKEN)).toBe(false)
  })
  it('Host: só 127.0.0.1 ou localhost na porta do servidor', () => {
    expect(hostAllowed('127.0.0.1:47110', 47110)).toBe(true)
    expect(hostAllowed('LOCALHOST:47110', 47110)).toBe(true)
    expect(hostAllowed('127.0.0.1:47111', 47110)).toBe(false)
    expect(hostAllowed('evil.example:47110', 47110)).toBe(false)
    expect(hostAllowed('127.0.0.1', 47110)).toBe(false)
    expect(hostAllowed(undefined, 47110)).toBe(false)
  })
})

describe('McpHttpServer', () => {
  it('GET /agent-code responde sem token, com versão e prontidão', async () => {
    let ready = { pronto: false as boolean, motivo: 'login' as 'login' | null }
    const { port } = await start({ readiness: () => ready })
    const r = await call(port, { method: 'GET', path: '/agent-code' })
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ app: 'agent-code', versao: '9.9.9', mcp: '/mcp', pronto: false, motivo: 'login' })
    ready = { pronto: true, motivo: null }
    expect((await call(port, { method: 'GET', path: '/agent-code' })).json()).toMatchObject({ pronto: true, motivo: null })
  })

  it('GET /agent-code: os extras entram sem tirar nem sobrescrever os campos base; extra que falha não derruba', async () => {
    let fail = false
    const info = () => {
      if (fail) throw new Error('boom')
      return { recursos: ['modelo', 'imagens'], modelos: ['claude-opus-5-5'], modelo_padrao: 'claude-opus-5-5', app: 'outro' }
    }
    const { port } = await start({ info })
    expect((await call(port, { method: 'GET', path: '/agent-code' })).json()).toEqual({
      app: 'agent-code',
      versao: '9.9.9',
      mcp: '/mcp',
      pronto: true,
      motivo: null,
      recursos: ['modelo', 'imagens'],
      modelos: ['claude-opus-5-5'],
      modelo_padrao: 'claude-opus-5-5'
    })
    fail = true
    expect((await call(port, { method: 'GET', path: '/agent-code' })).json()).toEqual({
      app: 'agent-code',
      versao: '9.9.9',
      mcp: '/mcp',
      pronto: true,
      motivo: null
    })
  })

  it('porta ocupada: usa a seguinte da faixa', async () => {
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>((r) => blocker.listen(START + 5, '127.0.0.1', () => r()))
    const { port } = await start({ portStart: START + 5, portCount: 3 })
    expect(port).toBe(START + 6)
    expect((await call(port, { method: 'GET', path: '/agent-code' })).status).toBe(200)
  })

  it('faixa inteira ocupada: start falha (o app segue sem o MCP)', async () => {
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>((r) => blocker.listen(START + 9, '127.0.0.1', () => r()))
    const s = new McpHttpServer({ version: '1', readiness: () => ({ pronto: true, motivo: null }), tools: tools(), portStart: START + 9, portCount: 1 })
    await expect(s.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('recusa sem executar: sem token/errado (401), com Origin (403), Host estranho (403)', async () => {
    const { port, t, host } = await start()
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eco', arguments: {} } }
    expect((await call(port, { headers: host, body })).status).toBe(401)
    expect((await call(port, { headers: { ...host, Authorization: 'Bearer errado' }, body })).status).toBe(401)
    expect((await call(port, { headers: { ...host, ...auth, Origin: 'https://site.example' }, body })).status).toBe(403)
    expect((await call(port, { headers: { ...host, ...auth, Origin: 'null' }, body })).status).toBe(403)
    expect((await call(port, { headers: { ...auth, Host: `evil.example:${port}` }, body })).status).toBe(403)
    expect(t.calls).toEqual([])
    // GET /mcp: sem SSE neste servidor.
    expect((await call(port, { method: 'GET', headers: { ...host, ...auth } })).status).toBe(405)
  })

  it('initialize → Mcp-Session-Id; notificação → 202; tools/list; tools/call', async () => {
    const { port, host, t } = await start()
    const h = { ...host, ...auth }
    const init = await call(port, {
      headers: h,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } } }
    })
    expect(init.status).toBe(200)
    expect(init.headers['mcp-session-id']).toEqual(expect.any(String))
    expect(init.json().result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'agent-code', version: '9.9.9' } })
    const sid = { 'Mcp-Session-Id': String(init.headers['mcp-session-id']) }
    expect((await call(port, { headers: { ...h, ...sid }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202)
    expect((await call(port, { headers: { ...h, ...sid }, body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).json().result).toEqual({})
    const list = await call(port, { headers: { ...h, ...sid }, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })
    expect(list.json().result.tools.map((x: { name: string }) => x.name)).toEqual(['eco'])
    const res = await call(port, {
      headers: { ...h, ...sid },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'eco', arguments: { a: 1 } } }
    })
    expect(res.json().result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, args: { a: 1 } }) }],
      structuredContent: { ok: true, args: { a: 1 } }
    })
    expect(t.calls).toEqual([{ name: 'eco', args: { a: 1 } }])
  })

  it('erros de protocolo: JSON quebrado, método e ferramenta desconhecidos', async () => {
    const { port, host } = await start()
    const h = { ...host, ...auth }
    const bad = await call(port, { headers: h, body: '{ nao json' })
    expect(bad.status).toBe(400)
    expect(bad.json().error.code).toBe(-32700)
    expect((await call(port, { headers: h, body: { jsonrpc: '2.0', id: 1, method: 'resources/list' } })).json().error.code).toBe(-32601)
    const unknown = await call(port, { headers: h, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nada' } } })
    expect(unknown.json().error).toMatchObject({ code: -32602 })
  })

  it('reiniciado (outra instância), segue aceitando sem sessão: o token autoriza', async () => {
    const log = vi.fn()
    const { port, host } = await start({ log })
    const res = await call(port, {
      headers: { ...host, ...auth, 'Mcp-Session-Id': 'sessao-antiga' },
      body: { jsonrpc: '2.0', id: 9, method: 'tools/list' }
    })
    expect(res.status).toBe(200)
  })
})
