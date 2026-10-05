import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteClient } from './client'
import { saveConfig } from './config'

class FakeEventSource {
  static last: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  close(): void {
    this.closed = true
  }
}

type Handler = (url: URL, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>

function mockFetch(handler: Handler): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const r = await handler(new URL(input), init)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const STATE = {
  conversations: [
    { id: 'c1', title: 'Um', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 2, queued: [] },
    { id: 'c2', title: 'Dois', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 1, queued: [] }
  ]
}

/** Deixa as promessas (fetch → json → estado) andarem sem disparar os timers longos. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('RemoteClient', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    saveConfig({ base: 'http://pc:8765', token: 'tok', lan: '' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('abre no pareamento salvo, sem POST /api/pair (auto-conexão nunca toma o lugar de outro celular)', async () => {
    const calls: string[] = []
    mockFetch((u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      return { status: 200, body: { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    expect(client.state.screen).toBe('main')
    expect(calls).not.toContain('POST /api/pair')
    expect(calls).toContain('GET /api/history')
    expect(FakeEventSource.last?.url).toContain('/api/events?token=tok')
  })

  it('409 de outro celular → tela própria; "Usar este celular" faz POST /api/pair', async () => {
    let paired = false
    const calls: string[] = []
    mockFetch((u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
      if (u.pathname === '/api/pair') {
        paired = true
        return { status: 200, body: { ok: true } }
      }
      if (!paired) return { status: 409, body: { error: 'another-device', pairedName: 'Galaxy do vizinho' } }
      return { status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    expect(client.state.screen).toBe('blocked')
    expect(client.state.blockedName).toBe('Galaxy do vizinho')
    client.takeover()
    await flush()
    expect(calls).toContain('POST /api/pair')
    expect(client.state.screen).toBe('main')
  })

  it('PC fora do ar: continua tentando com o motivo legível, sem apagar o pareamento', async () => {
    mockFetch(() => ({ status: 503, body: { error: 'pc offline' } }))
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    expect(client.state.screen).toBe('pairing')
    expect(client.state.pairingDetail).toMatch(/não está conectado/)
    expect(localStorage.getItem('agent-remote-config')).toContain('tok')
  })

  it('historyReq: trocar rápido de conversa — só a resposta mais recente vale', async () => {
    const pending: Record<string, (v: { status: number; body: unknown }) => void> = {}
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      const conv = u.searchParams.get('conv')!
      return new Promise((resolve) => (pending[conv] = resolve))
    })
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    client.selectConv('c1')
    client.selectConv('c2')
    pending.c2({ status: 200, body: { messages: [{ kind: 'user', id: 'm2', text: 'dois' }] } })
    await flush()
    pending.c1({ status: 200, body: { messages: [{ kind: 'user', id: 'm1', text: 'um' }] } })
    await flush()
    expect(client.state.convId).toBe('c2')
    expect(client.state.messages.map((m) => m.id)).toEqual(['m2'])
    expect(client.state.historyLoading).toBe(false)
  })

  it('evento ao vivo da conversa aberta entra no feed; o fim do turno libera a conversa', async () => {
    mockFetch((u) => ({ status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }))
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event: { kind: 'assistant-text', id: 'a1', text: 'oi', final: false } }) })
    expect(client.state.messages).toHaveLength(1)
    expect(client.current()?.busy).toBe(true)
    es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event: { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 } }) })
    expect(client.current()?.busy).toBe(false)
    // Avisos do escritório (fase 2) não mexem no chat.
    es.onmessage?.({ data: JSON.stringify({ convId: 'office', event: { kind: 'office-call', id: 'x' } }) })
    expect(client.state.messages).toHaveLength(1)
  })

  it('SSE caiu: faixa "reconectando…" e religa com backoff depois de conferir o estado', async () => {
    mockFetch((u) => ({ status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }))
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    const first = FakeEventSource.last!
    first.onerror?.()
    expect(client.state.online).toBe(false)
    expect(client.state.reconnectText).toMatch(/reconectando/)
    await vi.advanceTimersByTimeAsync(900)
    await flush()
    expect(FakeEventSource.last).not.toBe(first)
    FakeEventSource.last!.onopen?.()
    expect(client.state.reconnectText).toBeNull()
    expect(client.state.online).toBe(true)
  })
})
