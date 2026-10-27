/**
 * O `heartbeat` do PC no celular: é ESTADO da conversa — avança o `lastSignalAt`
 * (nunca volta) e carrega o início do bloco de raciocínio aberto (`thinkingSince`);
 * vale para qualquer conversa e nunca entra no feed. A saída do modelo da conversa
 * aberta (texto, pensamento, ferramenta, resultado) também é sinal de vida.
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
    { id: 'c1', title: 'Um', cwd: 'C:\\p', busy: true, connected: true, updatedAt: 2, queued: [] },
    { id: 'c2', title: 'Dois', cwd: 'C:\\q', busy: true, connected: true, updatedAt: 2, queued: [] }
  ]
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('RemoteClient — último sinal (heartbeat) e raciocínio aberto', () => {
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

  async function open(): Promise<{ client: RemoteClient; send: (convId: string, event: unknown) => void }> {
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    return { client, send: (convId, event) => es.onmessage?.({ data: JSON.stringify({ convId, event }) }) }
  }

  it('heartbeat: lastSignalAt só avança, thinkingSince acompanha; nada entra no feed', async () => {
    const { client, send } = await open()
    send('c1', { kind: 'heartbeat', lastActivityAt: 5000, thinkingSince: null })
    expect(client.current()?.lastSignalAt).toBe(5000)
    expect(client.current()?.thinkingSince).toBeUndefined()
    send('c1', { kind: 'heartbeat', lastActivityAt: 4000, thinkingSince: 4500 })
    expect(client.current()?.lastSignalAt).toBe(5000)
    expect(client.current()?.thinkingSince).toBe(4500)
    send('c1', { kind: 'heartbeat', lastActivityAt: 6000, thinkingSince: null })
    expect(client.current()?.thinkingSince).toBeUndefined()
    expect(client.state.messages).toHaveLength(0)
  })

  it('heartbeat de OUTRA conversa também marca o sinal dela', async () => {
    const { client, send } = await open()
    send('c2', { kind: 'heartbeat', lastActivityAt: 7000, thinkingSince: null })
    expect(client.state.conversations.find((c) => c.id === 'c2')?.lastSignalAt).toBe(7000)
    expect(client.current()?.lastSignalAt).toBeUndefined()
  })

  it('saída do modelo na conversa aberta é sinal de vida (lastSignalAt = agora)', async () => {
    const { client, send } = await open()
    vi.setSystemTime(123_000)
    send('c1', { kind: 'thinking', id: 'th', text: 'Vou ver', final: false })
    expect(client.current()?.lastSignalAt).toBe(123_000)
    expect(client.state.messages).toHaveLength(1)
    vi.setSystemTime(124_000)
    send('c1', { kind: 'tool-use', id: 't1', name: 'Read', input: {}, parentToolUseId: null })
    expect(client.current()?.lastSignalAt).toBe(124_000)
    expect(client.state.messages[1]).toMatchObject({ kind: 'tool-use', ts: 124_000 })
  })
})
