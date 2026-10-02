// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// sandbox.ts puxa ./store (electron + node:sqlite); aqui só o predicado de pasta importa.
vi.mock('../store', () => ({ getCacheInfo: () => ({ localDir: 'C:\\local' }) }))
// O resumidor de verdade, mas espiável: o cache só vale se ele NÃO rodar de novo.
vi.mock('./centralIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./centralIndex')>()
  return { ...actual, summarizeConversation: vi.fn(actual.summarizeConversation) }
})

import { summarizeConversation, type VersionedConversationLike } from './centralIndex'
import { createCentralIndexStore, type CentralIndexStoreDeps, type CentralLoadQuery } from './centralIndexStore'
import { PROJ_B, SANDBOX_ROOT, change, conv, deferred, ids, makeDb, setup } from './centralStoreTestKit'

const summarize = vi.mocked(summarizeConversation)

beforeEach(() => {
  // Zera as chamadas e volta ao resumidor de verdade (um teste pode trocá-lo).
  summarize.mockReset()
})

// ---------------------------------------------------------------------------
// Feed de mudanças
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — feed de mudanças', () => {
  it('evento de conversa recarrega só aquele id', async () => {
    const db = makeDb([conv('a'), conv('b'), conv('c')])
    const { store, emit } = setup(db)
    const first = await store.getIndex()
    summarize.mockClear()
    db.load.mockClear()

    db.put(conv('b', { title: 'B mudou', updatedAt: 5_000 }))
    emit(change('b'))
    const next = await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(1)
    expect(db.load).toHaveBeenCalledWith({ ids: ['b'] })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(next.byId.get('b')?.title).toBe('B mudou')
    expect(next.byId.get('a')).toBe(first.byId.get('a'))
    expect(next.byId.get('c')).toBe(first.byId.get('c'))

    // Sem novo evento, o cache serve.
    expect(await store.getIndex()).toBe(next)
    expect(db.load).toHaveBeenCalledTimes(1)
  })

  it('vários eventos entre duas chamadas viram uma única recarga, sem repetir id', async () => {
    const db = makeDb([conv('a'), conv('b'), conv('c')])
    const { store, emit } = setup(db)
    await store.getIndex()
    db.load.mockClear()
    db.put(conv('a', { updatedAt: 2 }))
    db.put(conv('c', { updatedAt: 3 }))
    emit(change('a'), change('c'), change('a'))
    emit(change('c'))
    await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(1)
    expect(db.load).toHaveBeenCalledWith({ ids: ['a', 'c'] })
  })

  it('aceita também uma mudança solta (não só o lote do feed real)', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store, listeners } = setup(db)
    await store.getIndex()
    db.load.mockClear()
    db.put(conv('b', { updatedAt: 9 }))
    for (const listener of listeners) listener(change('b'))
    expect((await store.getIndex()).byId.get('b')?.updatedAt).toBe(9)
    expect(db.load).toHaveBeenCalledWith({ ids: ['b'] })
  })

  it('evento de outra entidade, sem id ou malformado não recarrega nada', async () => {
    const db = makeDb([conv('a')])
    const { store, emit, listeners } = setup(db)
    const first = await store.getIndex()
    db.load.mockClear()
    emit(change('a', 'project'), change('a', 'device-kv'), change('a', 'lease'), change('', 'conversation'))
    for (const listener of listeners) {
      listener([null, undefined, {}, { entity: 'conversation' }, { entityId: 'a' }, { entity: 'conversation', entityId: 7 }] as never)
      listener(null as never)
    }
    expect(await store.getIndex()).toBe(first)
    expect(db.load).not.toHaveBeenCalled()
  })

  it('conversa nova (id que o cache não conhece) entra pelo evento', async () => {
    const db = makeDb([conv('a')])
    const { store, emit } = setup(db)
    await store.getIndex()
    db.put(conv('nova', { cwd: PROJ_B }))
    emit(change('nova'))
    const next = await store.getIndex()
    expect(ids(next)).toEqual(['a', 'nova'])
    expect(next.projects.map((p) => p.name).sort()).toEqual(['proj-a', 'proj-b'])
    expect(db.load).toHaveBeenLastCalledWith({ ids: ['nova'] })
  })

  it('conversa apagada some do índice, e o projeto que ficou sem conversa some junto', async () => {
    const db = makeDb([conv('a'), conv('b', { cwd: PROJ_B })])
    const { store, emit } = setup(db)
    expect(ids(await store.getIndex())).toEqual(['a', 'b'])

    // O repositório não devolve apagadas (includeDeleted: false) — o id volta ausente.
    db.put({ ...conv('b', { cwd: PROJ_B }), deletedAt: '2026-10-02T12:00:00.000Z' })
    emit(change('b'))
    const next = await store.getIndex()
    expect(db.load).toHaveBeenLastCalledWith({ ids: ['b'] })
    expect(ids(next)).toEqual(['a'])
    expect(next.projects.map((p) => p.name)).toEqual(['proj-a'])
  })

  it('apagada que o carregador devolve com deletedAt também sai; id que sumiu de vez, idem', async () => {
    const db = makeDb([conv('a'), conv('b'), conv('c')])
    const tombstone = { ...conv('b'), deletedAt: '2026-10-02T12:00:00.000Z' }
    const { store, emit } = setup(db, {
      // Carregador que ignora `includeDeleted` e devolve a lápide.
      load: vi.fn(async (query?: CentralLoadQuery) =>
        query?.ids ? [tombstone, ...[...db.rows.values()].filter((r) => r.id === 'c' && query.ids!.includes('c'))] : [...db.rows.values()]
      )
    })
    expect(ids(await store.getIndex())).toEqual(['a', 'b', 'c'])
    db.drop('c')
    emit(change('b'), change('c'))
    expect(ids(await store.getIndex())).toEqual(['a'])
  })

  it('mudança que chega DURANTE a carga não se perde', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a'), conv('b')])
    const load = vi
      .fn<NonNullable<CentralIndexStoreDeps['load']>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(db.load)
    const { store, emit } = setup(db, { load })

    const pending = store.getIndex() // 1ª carga completa, ainda em andamento
    db.put(conv('b', { title: 'novo', updatedAt: 9_000 }))
    emit(change('b')) // chega depois de a carga ter começado
    gate.resolve([conv('a'), conv('b')]) // ...e a leitura dela ainda traz o `b` antigo
    expect((await pending).byId.get('b')?.title).toBe('Conversa b')

    const fresh = await store.getIndex() // o evento ficou pendente
    expect(load).toHaveBeenLastCalledWith({ ids: ['b'] })
    expect(fresh.byId.get('b')?.title).toBe('novo')
  })

  it('evento anterior à 1ª carga já está coberto por ela (nenhuma recarga a mais)', async () => {
    const db = makeDb([conv('a')])
    const { store, emit } = setup(db)
    emit(change('a'))
    await store.getIndex()
    await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(1)
  })

  it('funciona sem feed (só cache + rede de segurança)', async () => {
    const db = makeDb([conv('a')])
    const store = createCentralIndexStore({ load: db.load, exists: () => true, sandboxRoot: SANDBOX_ROOT })
    const first = await store.getIndex()
    expect(await store.getIndex()).toBe(first)
    store.invalidate('a')
    await store.getIndex()
    expect(db.load).toHaveBeenLastCalledWith({ ids: ['a'] })
    store.dispose()
  })
})

// ---------------------------------------------------------------------------
// invalidate
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — invalidate', () => {
  it('com id: recarrega só aquele id; sem id: recarga completa', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store } = setup(db)
    await store.getIndex()
    db.load.mockClear()

    store.invalidate('b')
    await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(1)
    expect(db.load).toHaveBeenLastCalledWith({ ids: ['b'] })

    store.invalidate()
    await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(2)
    expect(db.load).toHaveBeenLastCalledWith({ includeDeleted: false })

    // Pedido uma vez, atendido uma vez.
    await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(2)
  })

  it('invalidate geral seguido de falha na recarga: a próxima chamada ainda recarrega tudo', async () => {
    const db = makeDb([conv('a')])
    const { store } = setup(db)
    await store.getIndex()
    store.invalidate()
    db.load.mockRejectedValueOnce(new Error('caiu'))
    await expect(store.getIndex()).rejects.toThrow('caiu')
    db.load.mockClear()
    await store.getIndex()
    expect(db.load).toHaveBeenCalledWith({ includeDeleted: false })
  })

  it('invalidate geral durante uma carga completa vale para a próxima chamada', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a')])
    const load = vi
      .fn<NonNullable<CentralIndexStoreDeps['load']>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(db.load)
    const { store } = setup(db, { load })
    const pending = store.getIndex()
    store.invalidate()
    gate.resolve([conv('a')])
    await pending
    await store.getIndex()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith({ includeDeleted: false })
  })
})

// ---------------------------------------------------------------------------
// Concorrência
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — chamadas simultâneas', () => {
  it('compartilham uma única carga', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const load = vi.fn(() => gate.promise)
    const { store } = setup(makeDb(), { load })
    const p1 = store.getIndex()
    const p2 = store.getIndex()
    const p3 = store.getIndex()
    expect(load).toHaveBeenCalledTimes(1)
    gate.resolve([conv('a')])
    const [i1, i2, i3] = await Promise.all([p1, p2, p3])
    expect(i1).toBe(i2)
    expect(i2).toBe(i3)
    expect(ids(i1)).toEqual(['a'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('numa recarga parcial também compartilham a mesma carga', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store, emit } = setup(db)
    await store.getIndex()
    db.load.mockClear()
    db.put(conv('b', { updatedAt: 7 }))
    emit(change('b'))
    const [x, y] = await Promise.all([store.getIndex(), store.getIndex()])
    expect(x).toBe(y)
    expect(db.load).toHaveBeenCalledTimes(1)
  })

  it('a falha rejeita quem esperava, e a chamada seguinte tenta de novo', async () => {
    const db = makeDb([conv('a')])
    const gate = deferred<VersionedConversationLike[]>()
    const load = vi
      .fn<NonNullable<CentralIndexStoreDeps['load']>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(db.load)
    const { store } = setup(db, { load })
    const p1 = store.getIndex()
    const p2 = store.getIndex()
    const settled = Promise.allSettled([p1, p2])
    gate.reject(new Error('banco fora do ar'))
    const [r1, r2] = await settled
    expect(r1.status).toBe('rejected')
    expect(r2.status).toBe('rejected')
    expect(load).toHaveBeenCalledTimes(1)

    expect(ids(await store.getIndex())).toEqual(['a'])
    expect(load).toHaveBeenCalledTimes(2)
  })
})
