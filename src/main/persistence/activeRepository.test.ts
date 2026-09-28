// @vitest-environment node
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { MirrorRepair } from '../mirrorRepair'
import { activeReplayStore, activeResumeMarker, activeSessionStore, activeTokenUsage } from './activeRepository'
import { isTransientPostgresError } from './postgresRetry'
import { StorageError, type PersistenceRepository } from './types'

/** Repositório de mentira: depois de `end()` se comporta como um pool encerrado. */
function fakeRepository(name: string) {
  let ended = false
  const guard = () => {
    if (ended) throw new Error('Cannot use a pool after calling end on the pool')
  }
  const appended: unknown[] = []
  const createSessionStore = vi.fn(
    (): SessionStore => ({
      append: async (_key, entries) => {
        guard()
        appended.push(...entries)
      },
      load: async () => {
        guard()
        return appended.length ? (appended as never) : null
      },
      listSessions: async () => {
        guard()
        return [{ sessionId: name, mtime: 1 }]
      }
    })
  )
  const repository = {
    createSessionStore,
    markSessionResumeReady: vi.fn(async () => guard()),
    insertLlmCall: vi.fn(async () => {
      guard()
      return { id: name } as never
    }),
    updateLlmCall: vi.fn(async () => null),
    listLlmCalls: vi.fn(async () => []),
    listLlmUsageTotals: vi.fn(async () => [])
  } as unknown as PersistenceRepository
  return { repository, appended, createSessionStore, end: () => (ended = true) }
}

const key = { projectKey: 'c1', sessionId: 's1' }
const entry = (uuid: string) => ({ type: 'user', uuid }) as never

describe('acesso ao repositório ativo (sessão que atravessa uma reconexão)', () => {
  it('o store do espelho segue o repositório novo depois de o antigo ser fechado (pool.end)', async () => {
    const a = fakeRepository('a')
    const b = fakeRepository('b')
    let current: PersistenceRepository | null = a.repository
    const resolve = () => {
      if (!current) throw new StorageError('STORAGE_OFFLINE', 'Persistência autoritativa offline.', true)
      return current
    }
    const store = activeSessionStore(resolve, 'c1')
    await store.append(key, [entry('1')])
    expect(a.appended).toHaveLength(1)

    // Queda: setOffline fecha o repositório e não há ativo.
    a.end()
    current = null
    const offline = await store.append(key, [entry('2')]).catch((error: unknown) => error)
    expect(offline).toBeInstanceOf(StorageError)
    // Transitório para o reparo do espelho (não o "pool encerrado", que não é).
    expect(isTransientPostgresError(offline)).toBe(true)

    // Reconexão instalou outro repositório: as chamadas seguintes vão para ele.
    current = b.repository
    await store.append(key, [entry('2')])
    expect(b.appended).toHaveLength(1)
    expect(await store.load(key)).toHaveLength(1)
    expect(await store.listSessions?.('c1')).toEqual([{ sessionId: 'b', mtime: 1 }])
    // Um store por repositório, não um por chamada.
    await store.append(key, [entry('3')])
    expect(b.createSessionStore).toHaveBeenCalledTimes(1)
  })

  it('só expõe os métodos opcionais que o store do repositório oferece', () => {
    const a = fakeRepository('a')
    const store = activeSessionStore(() => a.repository, 'c1')
    expect(store.listSessions).toBeTypeOf('function')
    expect(store.delete).toBeUndefined()
    expect(store.listSubkeys).toBeUndefined()
  })

  describe('chamada já em curso quando setOffline faz pool.end()', () => {
    /** Repositório cujo append fica preso até `release`, e então falha como pool encerrado. */
    function inFlightRepository() {
      const base = fakeRepository('a')
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const failAfterGate = async () => {
        await gate
        throw new Error('Cannot use a pool after calling end on the pool')
      }
      const createSessionStore = vi.fn((): SessionStore => ({ append: failAfterGate, load: failAfterGate as never }))
      const repository = {
        ...base.repository,
        createSessionStore,
        createSessionReplayStore: vi.fn((): SessionStore => ({ append: failAfterGate, load: failAfterGate as never })),
        markSessionResumeReady: vi.fn(failAfterGate),
        insertLlmCall: vi.fn(failAfterGate)
      } as unknown as PersistenceRepository
      return { repository, release }
    }

    it('repositório fechado (offline): a falha vira STORAGE_OFFLINE, transitória para o reparo', async () => {
      const a = inFlightRepository()
      let current: PersistenceRepository | null = a.repository
      const resolve = () => {
        if (!current) throw new StorageError('STORAGE_OFFLINE', 'Persistência autoritativa offline.', true)
        return current
      }
      const store = activeSessionStore(resolve, 'c1')
      const append = store.append(key, [entry('1')]).catch((error: unknown) => error)
      const marker = activeResumeMarker(resolve).markSessionResumeReady('c1', 's1', true).catch((error: unknown) => error)
      const usage = activeTokenUsage(resolve).insertLlmCall({} as never).catch((error: unknown) => error)
      current = null
      a.release()
      for (const error of [await append, await marker, await usage]) {
        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({ code: 'STORAGE_OFFLINE', retryable: true })
        expect(isTransientPostgresError(error)).toBe(true)
        expect((error as Error).cause).toBeInstanceOf(Error)
      }
    })

    it('repositório trocado pela reconexão: STORAGE_OFFLINE, e a próxima chamada vai para o novo', async () => {
      const a = inFlightRepository()
      const b = fakeRepository('b')
      let current = a.repository
      const store = activeSessionStore(() => current, 'c1')
      const append = store.append(key, [entry('1')]).catch((error: unknown) => error)
      current = b.repository
      a.release()
      expect(isTransientPostgresError(await append)).toBe(true)
      await store.append(key, [entry('1')])
      expect(b.appended).toHaveLength(1)
    })

    it('pool encerrado que AINDA é o repositório ativo continua erro definitivo', async () => {
      const a = inFlightRepository()
      const store = activeSessionStore(() => a.repository, 'c1')
      const append = store.append(key, [entry('1')]).catch((error: unknown) => error)
      a.release()
      const error = await append
      expect(error).not.toBeInstanceOf(StorageError)
      expect((error as Error).message).toBe('Cannot use a pool after calling end on the pool')
      expect(isTransientPostgresError(error)).toBe(false)
    })

    it('store do replay: preso ao repositório da tentativa, falha depois da troca vira transitória', async () => {
      const a = inFlightRepository()
      const b = fakeRepository('b')
      let current = a.repository
      const fallback = vi.fn((): SessionStore => ({ append: async () => undefined, load: async () => null }))
      const replay = activeReplayStore(() => current, 'c1', fallback)
      const append = replay.append(key, [entry('1')]).catch((error: unknown) => error)
      current = b.repository
      a.release()
      expect(isTransientPostgresError(await append)).toBe(true)
      expect(fallback).not.toHaveBeenCalled()
      // Repositório sem store de replay próprio (SQLite): usa o fallback.
      activeReplayStore(() => b.repository, 'c1', fallback)
      expect(fallback).toHaveBeenCalledTimes(1)
    })

    it('o MirrorRepair não desiste: a tentativa pega na queda é repetida e restaura no repositório novo', async () => {
      vi.useFakeTimers()
      try {
        const a = inFlightRepository()
        const b = fakeRepository('b')
        let current: PersistenceRepository | null = a.repository
        const resolve = () => {
          if (!current) throw new StorageError('STORAGE_OFFLINE', 'Persistência autoritativa offline.', true)
          return current
        }
        const store = activeSessionStore(resolve, 'c1')
        const onGiveUp = vi.fn()
        const onRestored = vi.fn()
        const repair = new MirrorRepair({ attempt: () => store.append(key, [entry('1')]), onGiveUp, onRestored, delays: [10] })
        repair.begin()
        await vi.advanceTimersByTimeAsync(10)
        // setOffline no meio da tentativa: fecha o repositório e não há ativo.
        current = null
        a.release()
        await vi.advanceTimersByTimeAsync(0)
        expect(onGiveUp).not.toHaveBeenCalled()
        expect(repair.pending).toBe(true)
        current = b.repository
        await vi.advanceTimersByTimeAsync(10)
        expect(onRestored).toHaveBeenCalledTimes(1)
        expect(b.appended).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('markSessionResumeReady e llm_calls também seguem o repositório ativo', async () => {
    const a = fakeRepository('a')
    const b = fakeRepository('b')
    let current = a.repository
    const marker = activeResumeMarker(() => current)
    const usage = activeTokenUsage(() => current)
    a.end()
    current = b.repository
    await marker.markSessionResumeReady('c1', 's1', true, 'hash')
    await usage.insertLlmCall({} as never)
    expect(b.repository.markSessionResumeReady).toHaveBeenCalledWith('c1', 's1', true, 'hash')
    expect(b.repository.insertLlmCall).toHaveBeenCalledTimes(1)
    expect(a.repository.markSessionResumeReady).not.toHaveBeenCalled()
  })
})
