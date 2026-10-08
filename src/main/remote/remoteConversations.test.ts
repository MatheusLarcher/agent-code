// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { RemoteConversationLight } from '../../shared/ipc'
import { LOAD_DEADLINE_MS, RemoteConversationStore, type RemoteMessageSource } from './remoteConversations'

const light = (id: string, extra: Partial<RemoteConversationLight> = {}): RemoteConversationLight => ({
  id,
  title: `Conversa ${id}`,
  cwd: 'C:/proj',
  busy: false,
  connected: false,
  updatedAt: 1,
  messageCount: 2,
  ...extra
})

const msgs = (...texts: string[]): unknown[] =>
  texts.flatMap((text, i) => [
    { kind: 'user', id: `u${i}`, text, ts: i },
    { kind: 'assistant-text', id: `a${i}`, text: `resposta ${i}` }
  ])

function source(snapshots: Record<string, unknown[]> = {}, db: Record<string, unknown[]> = {}) {
  const load = vi.fn(async (id: string) => db[id] ?? null)
  const src: RemoteMessageSource = { snapshot: (id) => snapshots[id] ?? null, load }
  return { src, load, snapshots }
}

describe('RemoteConversationStore — o estado leve e as mensagens tiradas do main', () => {
  it('sem delta troca a lista; com delta só atualiza as que mudaram e tira as que saíram', () => {
    const store = new RemoteConversationStore()
    store.apply({ conversations: [light('a'), light('b')], skipPerms: true })
    store.apply({ delta: true, conversations: [light('a', { busy: true })], removed: ['b'] })
    expect(store.list().map((c) => [c.id, c.busy])).toEqual([['a', true]])
    expect(store.global('skipPerms')).toBe(true)
    store.apply({ conversations: [light('z')] })
    expect(store.list().map((c) => c.id)).toEqual(['z'])
  })

  it('o histórico vem do instantâneo da fila; sem ele, do banco (uma vez, guardado)', async () => {
    const { src, load } = source({ a: msgs('oi da fila') }, { b: msgs('do banco') })
    const store = new RemoteConversationStore(src)
    store.apply({ conversations: [light('a'), light('b')] })
    expect((await store.messages('a'))?.[0]).toMatchObject({ text: 'oi da fila' })
    expect(load).not.toHaveBeenCalled()
    expect((await store.messages('b'))?.[0]).toMatchObject({ text: 'do banco' })
    await store.messages('b')
    expect(load).toHaveBeenCalledTimes(1)
    // Conversa que o celular não conhece não vai ao banco.
    expect(await store.messages('fantasma')).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('sem banco (ou banco lento além de LOAD_DEADLINE_MS), o histórico volta null na hora: o celular não fica esperando', async () => {
    vi.useFakeTimers()
    try {
      const down: RemoteMessageSource = { snapshot: () => null, load: vi.fn(async () => Promise.reject(new Error('banco indisponível'))) }
      const store = new RemoteConversationStore(down)
      store.apply({ conversations: [light('a')] })
      expect(await store.messages('a')).toBeNull()
      const slow: RemoteMessageSource = { snapshot: () => null, load: () => new Promise<null>(() => undefined) }
      const waiting = new RemoteConversationStore(slow)
      waiting.apply({ conversations: [light('b')] })
      const pending = waiting.messages('b')
      await vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS)
      expect(await pending).toBeNull()
      // Na fila, a conversa sai na hora mesmo sem banco.
      const queued = new RemoteConversationStore({ ...slow, snapshot: () => msgs('da fila') })
      queued.apply({ conversations: [light('c')] })
      expect((await queued.messages('c'))?.[0]).toMatchObject({ text: 'da fila' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('as perguntas do /api/state saem das mensagens à mão (com a fila de espera no fim) e são calculadas uma vez por lista', () => {
    const snapshot = msgs('primeira', 'segunda')
    const { src } = source({ a: snapshot })
    const store = new RemoteConversationStore(src)
    store.apply({ conversations: [light('a', { queued: [{ id: 'q1', text: 'na fila' }] }), light('b', { messageCount: 7 })] })
    const [a, b] = store.summaries()
    expect(a.messageCount).toBe(4)
    expect(a.questions).toEqual([
      { id: 'u0', text: 'primeira', ts: 0, position: 0 },
      { id: 'u1', text: 'segunda', ts: 1, position: 2 },
      { id: 'q1', text: 'na fila', position: 4, queued: true }
    ])
    // Sem mensagens à mão: a contagem que a tela mandou, sem perguntas.
    expect(b).toMatchObject({ messageCount: 7, queued: [] })
    expect(b.questions).toBeUndefined()
    expect(store.summaries()[0].questions?.[0]).toBe(a.questions?.[0])
  })

  it('downloads e busca usam só o que está na memória do main; resposta otimista do celular', async () => {
    const { src } = source({ a: [{ kind: 'assistant-text', id: 'x', text: 'pronto: [[download:C:/out/app.apk]]' }] })
    const store = new RemoteConversationStore(src)
    store.apply({ conversations: [light('a'), light('b', { title: 'Relatório de selênio' })] })
    expect(store.downloadables().map((p) => p.replace(/\\/g, '/'))).toContain('C:/out/app.apk')
    expect(store.search('selenio').map((r) => r.id)).toEqual(['b'])
    store.patch('a', { fastMode: true })
    expect(store.get('a')?.fastMode).toBe(true)
  })

  it('cliente antigo (mensagens no próprio estado) continua servido', async () => {
    const store = new RemoteConversationStore()
    store.apply({ conversations: [{ ...light('a'), messages: msgs('antigo') }] })
    expect((await store.messages('a'))?.[0]).toMatchObject({ text: 'antigo' })
    expect(store.summaries()[0].questions?.map((q) => q.text)).toEqual(['antigo'])
  })
})
