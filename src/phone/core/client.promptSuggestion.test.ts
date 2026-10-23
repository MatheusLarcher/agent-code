/**
 * O evento `prompt-suggestion` do PC no celular: é ESTADO da conversa (como o
 * `api-retry`) — põe/tira o `suggestion`, em qualquer conversa, e nunca entra no
 * feed nem liga o "ocupado".
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

const STATE = {
  conversations: [
    { id: 'c1', title: 'Um', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 2, queued: [] },
    { id: 'c2', title: 'Dois', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 1, queued: [] }
  ]
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('RemoteClient — sugestão do próximo prompt', () => {
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

  it('chega e marca a conversa (até a que não está aberta); null tira; feed e ocupado intactos', async () => {
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    const send = (convId: string, event: unknown): void => es.onmessage?.({ data: JSON.stringify({ convId, event }) })
    const conv = (id: string) => client.state.conversations.find((c) => c.id === id)
    send('c1', { kind: 'prompt-suggestion', text: 'Agora o 2º passo.' })
    send('c2', { kind: 'prompt-suggestion', text: 'Faça o commit' })
    expect(conv('c1')?.suggestion).toBe('Agora o 2º passo.')
    expect(conv('c2')?.suggestion).toBe('Faça o commit')
    expect(conv('c1')?.busy).toBe(false)
    expect(client.state.messages).toHaveLength(0)
    send('c1', { kind: 'prompt-suggestion', text: null })
    expect(conv('c1')?.suggestion).toBeUndefined()
    expect(client.state.messages).toHaveLength(0)
  })
})
