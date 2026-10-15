/**
 * O evento `compacting` do PC no celular: é ESTADO da conversa (como o
 * stall-status) — liga/desliga o `compactingSince` e nunca entra no feed.
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

describe('RemoteClient — compactação ao vivo', () => {
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

  it('início marca compactingSince, fim limpa; nada entra no feed', async () => {
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    const send = (event: unknown): void => es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event }) })
    send({ kind: 'compacting', active: true, since: 1234 })
    expect(client.current()?.compactingSince).toBe(1234)
    expect(client.state.messages).toHaveLength(0)
    send({ kind: 'compacting', active: false, since: 1234 })
    expect(client.current()?.compactingSince).toBeUndefined()
    expect(client.state.messages).toHaveLength(0)
  })
})
