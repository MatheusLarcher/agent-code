// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// sandbox.ts puxa ./store (electron + node:sqlite); aqui só o predicado de pasta importa.
vi.mock('../store', () => ({ getCacheInfo: () => ({ localDir: 'C:\\local' }) }))
// O resumidor de verdade, mas espiável: o cache só vale se ele NÃO rodar de novo.
vi.mock('./centralIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./centralIndex')>()
  return { ...actual, summarizeConversation: vi.fn(actual.summarizeConversation) }
})

import { summarizeConversation, type VersionedConversationLike } from './centralIndex'
import { CENTRAL_INDEX_MAX_AGE_MS, createCentralIndexStore, type CentralIndexStoreDeps } from './centralIndexStore'
import { MIN, SANDBOX_ROOT, change, conv, deferred, ids, makeDb, setup, type Db } from './centralStoreTestKit'

const summarize = vi.mocked(summarizeConversation)

beforeEach(() => {
  // Zera as chamadas e volta ao resumidor de verdade (um teste pode trocá-lo).
  summarize.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Deixa terminar o que já está em andamento (a recarga em segundo plano termina em microtarefas). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** O valor de `p` se ele resolve antes do próximo ciclo de timers; senão 'esperou' (a chamada ficou presa na carga). */
const promptly = <T>(p: Promise<T>): Promise<T | 'esperou'> =>
  Promise.race([p, new Promise<'esperou'>((resolve) => setTimeout(() => resolve('esperou'), 0))])

/** Carregador lento só na 2ª chamada (a recarga por idade fica presa em `gate`); a 1ª e as seguintes vão ao banco de mentira. */
function slowSecondLoad(db: Db, gate: Promise<VersionedConversationLike[]>) {
  return vi
    .fn<NonNullable<CentralIndexStoreDeps['load']>>()
    .mockImplementationOnce(db.load)
    .mockImplementationOnce(() => gate)
    .mockImplementation(db.load)
}

/** Silencia (e espiona) o log de erro da recarga em segundo plano. */
const spyLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

// ---------------------------------------------------------------------------
// Rede de segurança e falhas
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — rede de segurança (cache velho)', () => {
  it('o limite é de 10 minutos', () => {
    expect(CENTRAL_INDEX_MAX_AGE_MS).toBe(10 * MIN)
  })

  it('cache mais velho que 10 minutos: devolve o cache NA HORA e relê tudo em segundo plano (o outro PC grava sem o evento chegar)', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a'), conv('b')])
    const load = slowSecondLoad(db, gate.promise)
    const { store, clock } = setup(db, { load })
    const first = await store.getIndex()
    db.put(conv('nova')) // gravada pelo outro PC: nenhum evento chegou
    db.put(conv('b', { updatedAt: 4_000 }))

    clock.now += 10 * MIN - 1
    expect(await store.getIndex()).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)

    // Venceu: o cache volta na hora, com a carga completa ainda presa no banco lento.
    clock.now += 1
    expect(await promptly(store.getIndex())).toBe(first)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith({ includeDeleted: false })

    // Quem chega durante a recarga também recebe o cache na hora, e nenhuma 2ª carga começa.
    expect(await promptly(store.getIndex())).toBe(first)
    expect(await promptly(store.getIndex())).toBe(first)
    expect(load).toHaveBeenCalledTimes(2)

    // Terminou: a chamada seguinte já traz o que o outro PC gravou.
    summarize.mockClear()
    gate.resolve([...db.rows.values()])
    await settle()
    const next = await store.getIndex()
    expect(ids(next)).toEqual(['a', 'b', 'nova'])
    expect(next.byId.get('b')?.updatedAt).toBe(4_000)
    // Só as que mudaram (b) ou chegaram (nova) foram resumidas de novo.
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(next.byId.get('a')).toBe(first.byId.get('a'))

    // A idade zerou (conta do começo da recarga): mais 9 minutos e nada de outra.
    clock.now += 9 * MIN
    expect(await store.getIndex()).toBe(next)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a recarga em segundo plano que falha não rejeita ninguém: o cache fica, a mensagem vai ao log e a chamada seguinte tenta de novo', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const log = spyLog()
    try {
      const gate = deferred<VersionedConversationLike[]>()
      const db = makeDb([conv('a')])
      const load = slowSecondLoad(db, gate.promise)
      const { store, clock } = setup(db, { load })
      const first = await store.getIndex()

      clock.now += 10 * MIN
      expect(await promptly(store.getIndex())).toBe(first)
      gate.reject(new Error('banco fora do ar'))
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0][0])).toContain('banco fora do ar')

      // A idade continua vencida: a próxima chamada devolve o cache e dispara outra recarga, que agora dá certo.
      db.put(conv('nova'))
      expect(await promptly(store.getIndex())).toBe(first)
      expect(load).toHaveBeenCalledTimes(3)
      expect(load).toHaveBeenLastCalledWith({ includeDeleted: false })
      await settle()
      expect(ids(await store.getIndex())).toEqual(['a', 'nova'])
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      log.mockRestore()
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a recarga completa também tira o que o outro PC apagou', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store, clock } = setup(db)
    expect(ids(await store.getIndex())).toEqual(['a', 'b'])
    db.drop('b')
    clock.now += 10 * MIN
    expect(ids(await store.getIndex())).toEqual(['a', 'b']) // o cache, na hora
    await settle()
    expect(ids(await store.getIndex())).toEqual(['a'])
  })

  it('uma carga por vez: mudança que chega durante a recarga em segundo plano é relida depois dela, não junto', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a'), conv('b')])
    const load = slowSecondLoad(db, gate.promise)
    const { store, emit, clock } = setup(db, { load })
    const first = await store.getIndex()
    clock.now += 10 * MIN
    expect(await promptly(store.getIndex())).toBe(first)

    db.put(conv('b', { title: 'novo', updatedAt: 9_000 }))
    emit(change('b'))
    expect(await promptly(store.getIndex())).toBe(first)
    expect(load).toHaveBeenCalledTimes(2) // nenhuma parcial junto com a completa

    gate.resolve([conv('a'), conv('b')]) // a leitura da recarga é de antes da mudança
    await settle()
    const fresh = await store.getIndex()
    expect(load).toHaveBeenCalledTimes(3)
    expect(load).toHaveBeenLastCalledWith({ ids: ['b'] })
    expect(fresh.byId.get('b')?.title).toBe('novo')
  })

  it('com a idade vencida, os ids já marcados vão na recarga completa (sem uma parcial a mais)', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a'), conv('b')])
    const load = slowSecondLoad(db, gate.promise)
    const { store, emit, clock } = setup(db, { load })
    const first = await store.getIndex()
    db.put(conv('b', { title: 'mudou', updatedAt: 5_000 }))
    emit(change('b'))
    clock.now += 10 * MIN
    expect(await promptly(store.getIndex())).toBe(first)
    expect(load).toHaveBeenLastCalledWith({ includeDeleted: false })

    gate.resolve([...db.rows.values()])
    await settle()
    expect((await store.getIndex()).byId.get('b')?.title).toBe('mudou')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('o invalidate() geral continua bloqueante, também durante uma recarga em segundo plano (relê tudo depois dela)', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a')])
    const load = slowSecondLoad(db, gate.promise)
    const { store, clock } = setup(db, { load })
    const first = await store.getIndex()
    clock.now += 10 * MIN
    expect(await promptly(store.getIndex())).toBe(first)

    db.put(conv('nova'))
    store.invalidate()
    const pending = store.getIndex()
    expect(await promptly(pending)).toBe('esperou') // a leitura em andamento é de antes do invalidate
    gate.resolve([conv('a')])
    expect(ids(await pending)).toEqual(['a', 'nova'])
    expect(load).toHaveBeenCalledTimes(3)
    expect(load).toHaveBeenLastCalledWith({ includeDeleted: false })
  })

  it('recarga parcial não rejuvenesce o cache inteiro', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store, emit, clock } = setup(db)
    await store.getIndex() // carga completa em t0
    clock.now += 6 * MIN
    emit(change('a'))
    await store.getIndex() // parcial
    clock.now += 5 * MIN // 11 min desde a carga completa
    db.load.mockClear()
    await store.getIndex()
    expect(db.load).toHaveBeenCalledWith({ includeDeleted: false })
  })

  it('o relógio padrão é o do sistema', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
      const db = makeDb([conv('a')])
      const store = createCentralIndexStore({ load: db.load, exists: () => true, sandboxRoot: SANDBOX_ROOT })
      await store.getIndex()
      vi.setSystemTime(new Date('2026-10-02T10:09:59Z'))
      await store.getIndex()
      expect(db.load).toHaveBeenCalledTimes(1)
      vi.setSystemTime(new Date('2026-10-02T10:10:01Z'))
      await store.getIndex()
      expect(db.load).toHaveBeenCalledTimes(2)
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falha do carregador rejeita; o cache anterior fica e a próxima chamada tenta de novo', async () => {
    const db = makeDb([conv('a')])
    const { store, emit, clock } = setup(db)

    // 1ª carga falha.
    db.load.mockRejectedValueOnce(new Error('banco fora do ar'))
    await expect(store.getIndex()).rejects.toThrow('banco fora do ar')
    const first = await store.getIndex()
    expect(ids(first)).toEqual(['a'])

    // Recarga parcial falha: o aviso do id não se perde.
    db.put(conv('a', { title: 'depois', updatedAt: 3 }))
    emit(change('a'))
    db.load.mockRejectedValueOnce(new Error('rede caiu'))
    await expect(store.getIndex()).rejects.toThrow('rede caiu')
    const retried = await store.getIndex()
    expect(db.load).toHaveBeenLastCalledWith({ ids: ['a'] })
    expect(retried.byId.get('a')?.title).toBe('depois')

    // Recarga por idade falha em segundo plano: quem chamou já recebeu o cache, e a chamada seguinte tenta de novo.
    const log = spyLog()
    try {
      clock.now += 11 * MIN
      db.load.mockRejectedValueOnce(new Error('timeout'))
      expect(await store.getIndex()).toBe(retried)
      await settle()
      expect(log).toHaveBeenCalledTimes(1)
      db.load.mockClear()
      expect(await store.getIndex()).toBe(retried)
      expect(db.load).toHaveBeenCalledWith({ includeDeleted: false })
    } finally {
      log.mockRestore()
    }
  })

  it('um carregador que não devolve lista rejeita (e não deixa a loja travada)', async () => {
    const db = makeDb([conv('a')])
    const load = vi
      .fn<NonNullable<CentralIndexStoreDeps['load']>>()
      .mockResolvedValueOnce(undefined as never)
      .mockImplementation(db.load)
    const { store } = setup(db, { load })
    await expect(store.getIndex()).rejects.toThrow()
    expect(ids(await store.getIndex())).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — dispose', () => {
  it('cancela a assinatura (uma vez só) e fecha a loja', async () => {
    const db = makeDb([conv('a')])
    const { store, unsubscribe, listeners, emit } = setup(db)
    await store.getIndex()
    store.dispose()
    store.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
    emit(change('a')) // ninguém ouve mais
    db.load.mockClear()
    await expect(store.getIndex()).rejects.toThrow(/descartad/i)
    expect(db.load).not.toHaveBeenCalled() // fechada: nem vai ao banco
    expect(() => store.invalidate('a')).not.toThrow()
    expect(() => store.invalidate()).not.toThrow()
  })

  it('uma carga em andamento que termina depois do dispose não entrega o índice', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const { store } = setup(makeDb(), { load: () => gate.promise })
    const pending = store.getIndex()
    store.dispose()
    gate.resolve([conv('a')])
    await expect(pending).rejects.toThrow(/descartad/i)
  })

  it('o mesmo vale para uma recarga parcial em andamento', async () => {
    const gate = deferred<VersionedConversationLike[]>()
    const db = makeDb([conv('a')])
    const load = vi
      .fn<NonNullable<CentralIndexStoreDeps['load']>>()
      .mockImplementationOnce(db.load)
      .mockImplementation(() => gate.promise)
    const { store, emit } = setup(db, { load })
    await store.getIndex()
    emit(change('a'))
    const pending = store.getIndex() // recarga parcial, ainda em andamento
    store.dispose()
    gate.resolve([conv('a', { title: 'depois do dispose', updatedAt: 9 })])
    await expect(pending).rejects.toThrow(/descartad/i)
  })

  it('dispose durante a recarga em segundo plano: ela morre quieta (sem log) e a loja continua fechada', async () => {
    const log = spyLog()
    try {
      const gate = deferred<VersionedConversationLike[]>()
      const db = makeDb([conv('a')])
      const { store, clock } = setup(db, { load: slowSecondLoad(db, gate.promise) })
      await store.getIndex()
      clock.now += 10 * MIN
      await store.getIndex() // o cache; a recarga fica presa no banco lento
      store.dispose()
      gate.resolve([conv('a'), conv('b')])
      await settle()
      expect(log).not.toHaveBeenCalled()
      await expect(store.getIndex()).rejects.toThrow(/descartad/i)
    } finally {
      log.mockRestore()
    }
  })
})
