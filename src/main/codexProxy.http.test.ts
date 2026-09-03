// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./codexAuth', () => ({
  getValidCodexTokens: vi.fn(async () => null),
  refreshCodexTokens: vi.fn(async () => null)
}))

const { startCodexProxyServer } = await import('./codexProxy')

type ProxyHandle = Awaited<ReturnType<typeof startCodexProxyServer>>
type TokenSet = {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  expiresAt: number
}
type UpstreamCall = {
  url: string
  headers: Headers
  body: Record<string, unknown>
  signal?: AbortSignal
}
type ParsedEvent = { event: string; data: Record<string, unknown> }

const SECRET = 'proxy-test-secret'
const SESSION_ID = 'session_http_123'
const MODEL = 'gpt-5.6-luna'
const handles: ProxyHandle[] = []

function tokens(accessToken: string, accountId = 'account-123'): TokenSet {
  return {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    idToken: `id-${accessToken}`,
    accountId,
    expiresAt: Date.now() + 60_000
  }
}

function providerResponse(events: Record<string, unknown>[], newline: '\n' | '\r\n' = '\n'): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}${newline}${newline}`).join('')
  return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function fragmentedProviderResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

function finalTextEvent(text: string, id = 'message-final'): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: {
      output: [
        {
          type: 'message',
          id,
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        }
      ],
      usage: { input_tokens: 10, output_tokens: 4 }
    }
  }
}

function parseSse(text: string): ParsedEvent[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n')
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? ''
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

function captureFetch(
  responder: (call: UpstreamCall, index: number) => Response | Promise<Response>
): { fetchImpl: typeof fetch; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: UpstreamCall = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined
    }
    calls.push(call)
    return await responder(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function start(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof startCodexProxyServer>[0]> = {}
): Promise<{
  baseUrl: string
  getTokens: ReturnType<typeof vi.fn>
  refreshTokens: ReturnType<typeof vi.fn>
}> {
  const getTokens = vi.fn(async () => tokens('access-old'))
  const refreshTokens = vi.fn(async () => tokens('access-new'))
  const handle = await startCodexProxyServer({
    secret: SECRET,
    fetchImpl,
    getTokens,
    refreshTokens,
    ...overrides
  })
  handles.push(handle)
  return { baseUrl: `http://127.0.0.1:${handle.port}`, getTokens, refreshTokens }
}

async function post(
  baseUrl: string,
  body: Record<string, unknown>,
  options: { secret?: string; sessionId?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  return await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.secret ?? SECRET}`,
      'Content-Type': 'application/json',
      'x-claude-code-session-id': options.sessionId ?? SESSION_ID
    },
    body: JSON.stringify(body),
    signal: options.signal
  })
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  vi.restoreAllMocks()
})

describe('Codex proxy HTTP — ciclo real do servidor', () => {
  it('traduz tools em tool_use e o segundo POST devolve o tool_result como function_call_output', async () => {
    const callId = 'call_read_1'
    const argumentsText = JSON.stringify({ file_path: 'fixture.txt' })
    const { fetchImpl, calls } = captureFetch((_call, index) => {
      if (index === 0) {
        return providerResponse([
          {
            type: 'response.completed',
            response: {
              output: [
                { type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque-provider-state' },
                {
                  type: 'function_call',
                  id: 'function-item-1',
                  call_id: callId,
                  name: 'Read',
                  arguments: argumentsText
                }
              ],
              usage: { input_tokens: 8, output_tokens: 2 }
            }
          }
        ])
      }
      return providerResponse([finalTextEvent('O arquivo contém: conteúdo real.')])
    })
    const { baseUrl } = await start(fetchImpl)
    const tools = [
      {
        name: 'Read',
        description: 'Read one local file.',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    ]

    const first = await post(baseUrl, {
      model: MODEL,
      stream: true,
      system: 'Use ferramentas reais.',
      tools,
      messages: [{ role: 'user', content: 'Leia fixture.txt.' }]
    })
    expect(first.status).toBe(200)
    const firstEvents = parseSse(await first.text())
    const toolStart = firstEvents.find(
      (event) =>
        event.event === 'content_block_start' &&
        (event.data.content_block as { type?: string } | undefined)?.type === 'tool_use'
    )
    expect(toolStart?.data.content_block).toEqual({
      type: 'tool_use',
      id: callId,
      name: 'Read',
      input: {}
    })
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        event: 'message_delta',
        data: expect.objectContaining({ delta: expect.objectContaining({ stop_reason: 'tool_use' }) })
      })
    )
    expect(firstEvents.filter((event) => event.event === 'message_stop')).toHaveLength(1)
    expect(calls[0].body.tools).toBeUndefined()
    expect(calls[0].body.input).toEqual(
      expect.arrayContaining([
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'function',
              name: 'Read',
              description: 'Read one local file.',
              parameters: tools[0].input_schema,
              strict: false
            }
          ]
        },
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Use ferramentas reais.' }]
        }
      ])
    )
    expect(calls[0].body.parallel_tool_calls).toBe(false)
    expect(calls[0].body.reasoning).toEqual(expect.objectContaining({ context: 'all_turns' }))
    expect(calls[0].body.prompt_cache_key).toBe(SESSION_ID)

    const second = await post(baseUrl, {
      model: MODEL,
      stream: true,
      tools,
      messages: [
        { role: 'user', content: 'Leia fixture.txt.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: 'fixture.txt' } }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: 'conteúdo real' }] }]
        }
      ]
    })
    expect(second.status).toBe(200)
    const secondEvents = parseSse(await second.text())
    const text = secondEvents
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => (event.data.delta as { text?: string }).text ?? '')
      .join('')
    expect(text).toBe('O arquivo contém: conteúdo real.')
    expect(secondEvents.filter((event) => event.event === 'message_stop')).toHaveLength(1)

    const secondInput = calls[1].body.input as Record<string, unknown>[]
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', id: 'reason-1' }),
        expect.objectContaining({
          type: 'function_call',
          id: 'function-item-1',
          call_id: callId,
          name: 'Read',
          arguments: argumentsText
        }),
        { type: 'function_call_output', call_id: callId, output: 'conteúdo real' }
      ])
    )
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.headers.get('session_id'))).toEqual([SESSION_ID, SESSION_ID])
    expect(calls.map((call) => call.headers.get('originator'))).toEqual(['codex_cli_rs', 'codex_cli_rs'])
    expect(calls.map((call) => call.headers.get('version'))).toEqual(['0.146.0', '0.146.0'])
    expect(calls.map((call) => call.headers.get('x-openai-internal-codex-responses-lite'))).toEqual([
      'true',
      'true'
    ])
    expect(calls.map((call) => call.headers.get('user-agent'))).toEqual([
      'codex_cli_rs/0.146.0',
      'codex_cli_rs/0.146.0'
    ])
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer access-old',
      'Bearer access-old'
    ])
  })

  it('faz exatamente um refresh após 401 e repete com o mesmo session_id', async () => {
    const { fetchImpl, calls } = captureFetch((_call, index) =>
      index === 0
        ? new Response('expired', { status: 401 })
        : providerResponse([finalTextEvent('recuperado')])
    )
    const { baseUrl, refreshTokens } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, stream: true, messages: [{ role: 'user', content: 'oi' }] })
    expect(response.status).toBe(200)
    expect(parseSse(await response.text()).filter((event) => event.event === 'message_stop')).toHaveLength(1)
    expect(refreshTokens).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer access-old',
      'Bearer access-new'
    ])
    expect(calls.map((call) => call.headers.get('session_id'))).toEqual([SESSION_ID, SESSION_ID])
  })

  it('reuses a token already refreshed by another request instead of refreshing again', async () => {
    let current = tokens('access-old')
    const refreshTokens = vi.fn(async (failed: string) =>
      current.accessToken === failed ? tokens('access-unexpected') : current
    )
    const { fetchImpl, calls } = captureFetch((_call, index) => {
      if (index === 0) {
        current = tokens('access-current')
        return new Response('expired', { status: 401 })
      }
      return providerResponse([finalTextEvent('recuperado sem novo refresh')])
    })
    const { baseUrl } = await start(fetchImpl, { getTokens: async () => current, refreshTokens })
    expect((await post(baseUrl, { model: MODEL, messages: [] })).status).toBe(200)
    expect(refreshTokens).toHaveBeenCalledExactlyOnceWith('access-old')
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer access-old', 'Bearer access-current'])
  })

  it('retorna authentication_error quando o refresh do 401 falha, sem novo retry', async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response('expired', { status: 401 }))
    const refreshTokens = vi.fn(async () => null)
    const { baseUrl } = await start(fetchImpl, { refreshTokens })

    const response = await post(baseUrl, { model: MODEL, messages: [] })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' }
    })
    expect(refreshTokens).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
  })

  it.each([
    [403, 'api_error', /recusou/i],
    [429, 'rate_limit_error', /limite de uso/i]
  ])('preserva o HTTP %i do upstream sem tentar refresh', async (status, type, message) => {
    const { fetchImpl, calls } = captureFetch(() => new Response('provider error', { status }))
    const { baseUrl, refreshTokens } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, messages: [] })
    expect(response.status).toBe(status)
    const body = (await response.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe(type)
    expect(body.error.message).toMatch(message)
    expect(refreshTokens).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('nega bearer local inválido antes de ler tokens ou chamar o upstream', async () => {
    const { fetchImpl, calls } = captureFetch(() => providerResponse([finalTextEvent('não deve chegar')]))
    const { baseUrl, getTokens } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, messages: [] }, { secret: 'segredo-errado' })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid local proxy credentials.' }
    })
    expect(getTokens).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('aceita SSE CRLF fragmentado no meio de frames e JSON', async () => {
    const first = JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'message-crlf',
      output_index: 0,
      delta: 'Olá fragmentado'
    })
    const terminal = JSON.stringify(finalTextEvent('Olá fragmentado', 'message-crlf'))
    const payload = `data: ${first}\r\n\r\ndata: ${terminal}\r\n\r\n`
    const cuts = [7, 19, 37, 58, 91, 137, payload.length]
    let from = 0
    const chunks = cuts.map((to) => {
      const chunk = payload.slice(from, to)
      from = to
      return chunk
    })
    const { fetchImpl } = captureFetch(() => fragmentedProviderResponse(chunks))
    const { baseUrl } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, stream: true, messages: [] })
    const events = parseSse(await response.text())
    expect(response.status).toBe(200)
    expect(events.some((event) => JSON.stringify(event.data).includes('Olá fragmentado'))).toBe(true)
    expect(events.filter((event) => event.event === 'message_stop')).toHaveLength(1)
    expect(events.some((event) => event.event === 'error')).toBe(false)
  })

  it('transforma EOF sem evento terminal em erro SSE, sem forjar message_stop', async () => {
    const { fetchImpl } = captureFetch(() =>
      providerResponse([
        {
          type: 'response.output_text.delta',
          item_id: 'message-incomplete',
          output_index: 0,
          delta: 'parcial'
        }
      ])
    )
    const { baseUrl } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, stream: true, messages: [] })
    const events = parseSse(await response.text())
    expect(response.status).toBe(200)
    expect(events.find((event) => event.event === 'error')?.data).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringMatching(/malformada|terminal/i) })
      })
    )
    expect(events.filter((event) => event.event === 'message_stop')).toHaveLength(0)
  })

  it('transforma JSON SSE malformado em erro estruturado', async () => {
    const { fetchImpl } = captureFetch(() => fragmentedProviderResponse(['data: {"type":\r\n\r\n']))
    const { baseUrl } = await start(fetchImpl)

    const response = await post(baseUrl, { model: MODEL, stream: true, messages: [] })
    const events = parseSse(await response.text())
    expect(response.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('error')
    expect((events[0].data.error as { message: string }).message).toMatch(/malformada|Malformed JSON/i)
  })

  it('rejects a JSON null request as 400 instead of crashing with 500', async () => {
    const { fetchImpl } = captureFetch(() => providerResponse([finalTextEvent('unused')]))
    const { baseUrl } = await start(fetchImpl)
    const response = await post(baseUrl, null as unknown as Record<string, unknown>)
    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/JSON object|objeto|request/i)
  })

  it('refuses to continue a live session after the OAuth account changes', async () => {
    let current = tokens('access-a', 'account-a')
    const { fetchImpl, calls } = captureFetch(() => providerResponse([finalTextEvent('ok')]))
    const { baseUrl } = await start(fetchImpl, { getTokens: async () => current })
    const body = { model: MODEL, stream: true, messages: [] }

    const first = await post(baseUrl, body)
    expect(first.status).toBe(200)
    await first.text()

    current = tokens('access-b', 'account-b')
    const second = await post(baseUrl, body)
    expect(second.status).toBe(401)
    expect(await second.text()).toMatch(/reconecte/i)
    expect(calls).toHaveLength(1)
  })

  it('aborta o fetch upstream quando o cliente fecha o stream local', async () => {
    let markAborted!: () => void
    const upstreamAborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })
    const encoder = new TextEncoder()
    const { fetchImpl, calls } = captureFetch((call) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                item_id: 'message-abort',
                output_index: 0,
                delta: 'começou'
              })}\n\n`
            )
          )
          call.signal?.addEventListener(
            'abort',
            () => {
              markAborted()
              controller.error(new DOMException('aborted', 'AbortError'))
            },
            { once: true }
          )
        }
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    const { baseUrl } = await start(fetchImpl)
    const controller = new AbortController()

    const response = await post(
      baseUrl,
      { model: MODEL, stream: true, messages: [] },
      { signal: controller.signal }
    )
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    await expect(
      Promise.race([
        upstreamAborted,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 1_000))
      ])
    ).resolves.toBeUndefined()
    expect(calls[0].signal?.aborted).toBe(true)
  })
})

// Modo rápido do GPT. Vale medido em 2026-09-03 contra o backend real: só
// `service_tier: 'priority'` é aceito (todo outro valor e todo parâmetro
// desconhecido voltam HTTP 400), e a RESPOSTA ecoa "default" mesmo quando
// priority foi aplicado — por isso o contrato que testamos é o que sai na
// requisição, nunca o eco.
describe('Codex proxy HTTP — modo rápido por conversa (service_tier)', () => {
  const body = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'oi' }] }

  it('token com sufixo +fast: manda service_tier=priority', async () => {
    const { fetchImpl, calls } = captureFetch(() => providerResponse([finalTextEvent('ok')]))
    const { baseUrl } = await start(fetchImpl)
    const res = await post(baseUrl, body, { secret: `${SECRET}+fast` })
    expect(res.status).toBe(200)
    await res.text()
    expect(calls[0].body.service_tier).toBe('priority')
  })

  it('token normal: NÃO manda service_tier (cai no padrão do backend)', async () => {
    const { fetchImpl, calls } = captureFetch(() => providerResponse([finalTextEvent('ok')]))
    const { baseUrl } = await start(fetchImpl)
    const res = await post(baseUrl, body)
    expect(res.status).toBe(200)
    await res.text()
    expect(calls[0].body).not.toHaveProperty('service_tier')
  })

  // O sufixo é uma preferência, não uma credencial: sozinho não abre a porta.
  it('segredo errado, mesmo com o sufixo: 401 e nenhuma chamada ao upstream', async () => {
    const { fetchImpl, calls } = captureFetch(() => providerResponse([finalTextEvent('ok')]))
    const { baseUrl } = await start(fetchImpl)
    const res = await post(baseUrl, body, { secret: 'segredo-errado+fast' })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe('parseCodexRateLimitHeaders — consumo do plano ChatGPT', () => {
  it('lê primary/secondary com percentual, janela e reset (duas grafias do reset)', async () => {
    const { parseCodexRateLimitHeaders } = await import('./codexProxy')
    const headers = new Headers({
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-resets-in-seconds': '600',
      'x-codex-secondary-used-percent': '90',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '3600'
    })
    const now = 1_000_000
    const limits = parseCodexRateLimitHeaders(headers, now)
    expect(limits).toEqual([
      {
        rateLimitType: 'gpt_primary',
        status: 'allowed',
        utilization: 0.425,
        resetsAt: now + 600_000,
        windowMinutes: 300,
        updatedAt: now
      },
      {
        rateLimitType: 'gpt_secondary',
        status: 'allowed_warning',
        utilization: 0.9,
        resetsAt: now + 3_600_000,
        windowMinutes: 10080,
        updatedAt: now
      }
    ])
  })

  it('sem header de percentual não inventa janela; percentual inválido é ignorado', async () => {
    const { parseCodexRateLimitHeaders } = await import('./codexProxy')
    expect(parseCodexRateLimitHeaders(new Headers())).toEqual([])
    const bad = new Headers({ 'x-codex-primary-used-percent': 'abc', 'x-codex-secondary-used-percent': '120' })
    const limits = parseCodexRateLimitHeaders(bad, 5)
    expect(limits).toHaveLength(1)
    expect(limits[0]).toMatchObject({ rateLimitType: 'gpt_secondary', utilization: 1, status: 'rejected' })
    expect(limits[0].resetsAt).toBeUndefined()
  })
})
