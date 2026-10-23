/**
 * O evento `api-retry` do PC no celular: é ESTADO da conversa (como o
 * `compacting`) — liga/desliga o `apiRetry` e nunca entra no feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteClient } from './client'
import { saveConfig } from './config'

class FakeEventSource {
  static last: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  close(): void {}
}

const STATE = { conversations: [{ id: 'c1', title: 'Um', cwd: 'C:\\p', busy: true, connected: true, updatedAt: 2, queued: [] }] }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('RemoteClient — nova tentativa da API', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const body = new URL(input).pathname === '/api/state' ? STATE : { messages: [] }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
    )
    saveConfig({ base: 'http://pc:8765', token: 'tok', lan: '' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('início marca apiRetry, fim limpa; nada entra no feed', async () => {
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    const send = (event: unknown): void => es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event }) })
    send({ kind: 'api-retry', active: true, attempt: 2, maxRetries: 10, retryAt: 5000, status: 429, error: 'rate_limit' })
    expect(client.current()?.apiRetry).toEqual({ attempt: 2, maxRetries: 10, retryAt: 5000, status: 429, error: 'rate_limit' })
    expect(client.state.messages).toHaveLength(0)
    send({ kind: 'api-retry', active: false })
    expect(client.current()?.apiRetry).toBeUndefined()
    expect(client.state.messages).toHaveLength(0)
  })
})
