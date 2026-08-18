// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const secureState = vi.hoisted(() => ({
  available: true,
  encryptError: null as Error | null,
  decryptError: null as Error | null
}))

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => secureState.available),
  encryptString: vi.fn((value: string) => {
    if (secureState.encryptError) throw secureState.encryptError
    return Buffer.from(`sealed:${value}`, 'utf8')
  }),
  decryptString: vi.fn((value: Buffer) => {
    if (secureState.decryptError) throw secureState.decryptError
    const encoded = value.toString('utf8')
    if (!encoded.startsWith('sealed:')) throw new Error('invalid sealed value')
    return encoded.slice('sealed:'.length)
  })
}))

const storeState = vi.hoisted(() => ({ value: null as string | null }))
const storeMock = vi.hoisted(() => ({
  kvGet: vi.fn(() => storeState.value),
  kvSet: vi.fn((_key: string, value: string) => {
    storeState.value = value
  })
}))

const httpState = vi.hoisted(() => ({
  handler: null as ((request: { url?: string }, response: unknown) => void) | null,
  server: null as { on: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | null
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))
vi.mock('./store', () => storeMock)
vi.mock('node:http', () => ({
  createServer: vi.fn((handler: (request: { url?: string }, response: unknown) => void) => {
    httpState.handler = handler
    const server = {
      on: vi.fn(),
      listen: vi.fn(),
      close: vi.fn()
    }
    server.on.mockImplementation(() => server)
    server.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback()
      return server
    })
    server.close.mockImplementation(() => server)
    httpState.server = server
    return server
  })
}))

const {
  codexLogout,
  codexStatus,
  getValidCodexTokens,
  isCodexConnected,
  refreshCodexTokens,
  refreshCodexTokensAfter,
  runCodexLogin
} = await import('./codexAuth')
type CodexTokens = import('./codexAuth').CodexTokens

const fetchMock = vi.fn()

interface FakeResponse {
  status?: number
  body: string
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function fakeResponse(): FakeResponse {
  const response = {
    status: undefined,
    body: '',
    writeHead: vi.fn(),
    end: vi.fn()
  } as FakeResponse
  response.writeHead.mockImplementation((status: number) => {
    response.status = status
    return response
  })
  response.end.mockImplementation((body?: string) => {
    response.body = body ?? ''
    return response
  })
  return response
}

function jwt(accountId: string | null = 'account-test'): string {
  const auth = accountId === null ? {} : { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' }
  const payload = {
    email: 'person@example.test',
    'https://api.openai.com/auth': auth
  }
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function validExchangePayload(): Record<string, unknown> {
  return {
    access_token: 'access-test',
    refresh_token: 'refresh-test',
    id_token: jwt(),
    expires_in: 3600
  }
}

function validTokens(overrides: Partial<CodexTokens> = {}): CodexTokens {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    idToken: jwt(),
    accountId: 'account-test',
    email: 'person@example.test',
    planType: 'plus',
    expiresAt: Date.now() - 60_000,
    ...overrides
  }
}

function encryptedWrapper(value: unknown): string {
  return JSON.stringify({
    enc: Buffer.from(`sealed:${JSON.stringify(value)}`, 'utf8').toString('base64')
  })
}

function seedTokens(tokens: CodexTokens = validTokens()): string {
  const stored = encryptedWrapper(tokens)
  storeState.value = stored
  return stored
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function beginLogin(): {
  promise: Promise<{ ok: boolean; message?: string }>
  authorizeUrl: URL
  log: ReturnType<typeof vi.fn>
} {
  let opened = ''
  const log = vi.fn()
  const promise = runCodexLogin((url) => {
    opened = url
  }, log)
  expect(opened).not.toBe('')
  return { promise, authorizeUrl: new URL(opened), log }
}

function dispatchValidCallback(authorizeUrl: URL, response: FakeResponse): void {
  const state = authorizeUrl.searchParams.get('state')
  if (!state || !httpState.handler) throw new Error('login callback server was not initialized')
  httpState.handler(
    { url: `/auth/callback?code=${encodeURIComponent('authorization-code')}&state=${encodeURIComponent(state)}` },
    response
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  secureState.available = true
  secureState.encryptError = null
  secureState.decryptError = null
  storeState.value = null
  httpState.handler = null
  httpState.server = null
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Codex OAuth login and secure persistence', () => {
  it('preserves the PKCE contract and shows success only after exchange and encrypted persistence', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))
    const { promise, authorizeUrl } = beginLogin()
    const response = fakeResponse()

    expect(authorizeUrl.origin).toBe('https://auth.openai.com')
    expect(authorizeUrl.pathname).toBe('/oauth/authorize')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(authorizeUrl.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy()

    dispatchValidCallback(authorizeUrl, response)
    await Promise.resolve()
    expect(response.end).not.toHaveBeenCalled()
    expect(storeMock.kvSet).not.toHaveBeenCalled()

    resolveFetch?.(jsonResponse(validExchangePayload()))
    await expect(promise).resolves.toEqual({ ok: true })

    expect(response.status).toBe(200)
    expect(response.body).toContain('Login com o ChatGPT concluído')
    expect(storeMock.kvSet).toHaveBeenCalledTimes(1)
    expect(storeMock.kvSet.mock.invocationCallOrder[0]).toBeLessThan(response.end.mock.invocationCallOrder[0])
    const wrapper = JSON.parse(storeState.value ?? '{}') as Record<string, unknown>
    expect(typeof wrapper.enc).toBe('string')
    expect(wrapper).not.toHaveProperty('plain')
    expect(storeState.value).not.toContain('access-test')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const exchange = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
    })
    expect(exchange.code_verifier).toBeTruthy()
  })

  it.each(['unavailable', 'encrypt throws'] as const)(
    'never falls back to plaintext when safeStorage is %s',
    async (failure) => {
      if (failure === 'unavailable') secureState.available = false
      else secureState.encryptError = new Error('DPAPI failure')
      fetchMock.mockResolvedValueOnce(jsonResponse(validExchangePayload()))
      const { promise, authorizeUrl } = beginLogin()
      const response = fakeResponse()

      dispatchValidCallback(authorizeUrl, response)
      const result = await promise

      expect(result.ok).toBe(false)
      expect(response.status).toBe(500)
      expect(response.body).not.toContain('Login com o ChatGPT concluído')
      expect(storeMock.kvSet).not.toHaveBeenCalled()
      expect(storeState.value).toBeNull()
    }
  )

  it('rejects legacy plaintext and malformed encrypted token records', async () => {
    storeState.value = JSON.stringify({ plain: JSON.stringify(validTokens()) })
    expect(codexStatus()).toEqual({ connected: false })
    expect(isCodexConnected()).toBe(false)

    storeState.value = encryptedWrapper({ ...validTokens(), accountId: '' })
    expect(codexStatus()).toEqual({ connected: false })
    await expect(getValidCodexTokens()).resolves.toBeNull()
  })

  it('keeps listening after callbacks with an invalid state or missing code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validExchangePayload()))
    const { promise, authorizeUrl } = beginLogin()
    if (!httpState.handler) throw new Error('login callback server was not initialized')

    const wrongState = fakeResponse()
    httpState.handler({ url: '/auth/callback?error=access_denied&state=wrong-state' }, wrongState)
    expect(wrongState.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(httpState.server?.close).not.toHaveBeenCalled()

    const missingCode = fakeResponse()
    const state = authorizeUrl.searchParams.get('state')
    httpState.handler({ url: `/auth/callback?state=${encodeURIComponent(state ?? '')}` }, missingCode)
    expect(missingCode.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(httpState.server?.close).not.toHaveBeenCalled()

    const valid = fakeResponse()
    dispatchValidCallback(authorizeUrl, valid)
    await expect(promise).resolves.toEqual({ ok: true })
    expect(valid.status).toBe(200)
    expect(codexStatus()).toMatchObject({ connected: true, accountId: 'account-test' })
  })
})

describe('Codex OAuth response validation', () => {
  it.each([
    ['missing access token', { ...validExchangePayload(), access_token: '' }],
    ['missing refresh token', { ...validExchangePayload(), refresh_token: undefined }],
    ['invalid expiry', { ...validExchangePayload(), expires_in: 0 }],
    ['missing account id', { ...validExchangePayload(), id_token: jwt(null) }]
  ])('rejects exchange payload with %s before persistence', async (_name, payload) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(payload))
    const { promise, authorizeUrl } = beginLogin()
    const response = fakeResponse()

    dispatchValidCallback(authorizeUrl, response)
    const result = await promise

    expect(result.ok).toBe(false)
    expect(response.status).toBe(500)
    expect(storeMock.kvSet).not.toHaveBeenCalled()
    expect(codexStatus()).toEqual({ connected: false })
  })
})

describe('Codex OAuth refresh', () => {
  it('uses one in-flight refresh for concurrent callers and persists the result once', async () => {
    seedTokens()
    let resolveFetch: ((response: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const first = refreshCodexTokensAfter('access-old')
    const second = refreshCodexTokensAfter('access-old')
    const throughGetValid = getValidCodexTokens()
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch?.(jsonResponse({ access_token: 'access-new', expires_in: 3600 }))
    const results = await Promise.all([first, second, throughGetValid])

    expect(results.map((tokens) => tokens?.accessToken)).toEqual(['access-new', 'access-new', 'access-new'])
    expect(storeMock.kvSet).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
    })
  })

  it('does not rotate again when a staggered 401 references the token that was already refreshed', async () => {
    seedTokens()
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'access-new', expires_in: 3600 }))

    await expect(refreshCodexTokensAfter('access-old')).resolves.toMatchObject({ accessToken: 'access-new' })
    await expect(refreshCodexTokensAfter('access-old')).resolves.toMatchObject({ accessToken: 'access-new' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([400, 401])('clears the saved login after definitive HTTP %s rejection', async (status) => {
    seedTokens()
    fetchMock.mockResolvedValueOnce(new Response('rejected', { status }))

    await expect(refreshCodexTokens()).resolves.toBeNull()

    expect(storeState.value).toBe('null')
    expect(codexStatus()).toEqual({ connected: false })
  })

  it('keeps the saved login after a transient server failure', async () => {
    const original = seedTokens()
    fetchMock.mockResolvedValueOnce(new Response('temporary', { status: 503 }))

    await expect(refreshCodexTokens()).resolves.toBeNull()

    expect(storeState.value).toBe(original)
    expect(codexStatus().connected).toBe(true)
  })

  it.each([
    ['missing access token', { expires_in: 3600 }],
    ['missing account id', { access_token: 'access-new', id_token: jwt(null), expires_in: 3600 }],
    ['different account id', { access_token: 'access-new', id_token: jwt('other-account'), expires_in: 3600 }]
  ])('rejects malformed refresh payload with %s without overwriting the login', async (_name, payload) => {
    const original = seedTokens()
    fetchMock.mockResolvedValueOnce(jsonResponse(payload))

    await expect(refreshCodexTokens()).rejects.toThrow()

    expect(storeState.value).toBe(original)
    expect(codexStatus().connected).toBe(true)
  })

  it('ignores a successful refresh that finishes after logout', async () => {
    seedTokens()
    let resolveFetch: ((response: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const refreshing = refreshCodexTokens()
    codexLogout()
    resolveFetch?.(jsonResponse({ access_token: 'stale-access', expires_in: 3600 }))

    await expect(refreshing).resolves.toBeNull()
    expect(storeState.value).toBe('null')
    expect(codexStatus()).toEqual({ connected: false })
  })

  it.each([
    ['successful', () => jsonResponse({ access_token: 'stale-access', expires_in: 3600 })],
    ['rejected', () => new Response('old refresh rejected', { status: 401 })]
  ])('does not let a %s refresh from account A overwrite or erase a new account B login', async (_name, oldResult) => {
    seedTokens()
    let resolveOldRefresh: ((response: Response) => void) | undefined
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveOldRefresh = resolve
      }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-b',
          refresh_token: 'refresh-b',
          id_token: jwt('account-b'),
          expires_in: 3600
        })
      )

    const staleRefresh = refreshCodexTokens()
    const { promise, authorizeUrl } = beginLogin()
    dispatchValidCallback(authorizeUrl, fakeResponse())
    await expect(promise).resolves.toEqual({ ok: true })
    expect(codexStatus()).toMatchObject({ connected: true, accountId: 'account-b' })

    resolveOldRefresh?.(oldResult())
    await expect(staleRefresh).resolves.toBeNull()
    expect(codexStatus()).toMatchObject({ connected: true, accountId: 'account-b' })
  })
})
