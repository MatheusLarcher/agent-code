import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { CentralIndex, VersionedConversationLike } from './centralIndex'
import {
  createCentralIndexStore,
  type CentralChangeHandler,
  type CentralChangeLike,
  type CentralIndexStoreDeps,
  type CentralLoadQuery
} from './centralIndexStore'

/**
 * Fixtures dos testes do store: um "banco" de mentira, o feed de mudanças e o relógio à
 * mão. O teste que importa isto precisa mockar `../store` e `./centralIndex` ANTES (ver o
 * cabeçalho dos centralIndexStore.*.test.ts): o store de verdade puxa o electron.
 */

export const BASE = join(tmpdir(), 'ac-central-store-test')
export const SANDBOX_ROOT = join(BASE, 'sandbox')
export const PROJ_A = join(BASE, 'proj-a')
export const PROJ_B = join(BASE, 'proj-b')
export const MIN = 60_000

export function conv(
  id: string,
  payload: Record<string, unknown> = {},
  row: Partial<VersionedConversationLike> = {}
): VersionedConversationLike {
  return {
    id,
    payload: {
      id,
      title: `Conversa ${id}`,
      cwd: PROJ_A,
      messages: [{ kind: 'user', id: `u-${id}`, text: `pedido de ${id}` }],
      updatedAt: 1_000,
      ...payload
    },
    revision: 1,
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...row
  }
}

/** Um "banco" de mentira: respeita `ids` e `includeDeleted` como o repositório de verdade. */
export function makeDb(initial: VersionedConversationLike[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]))
  const load = vi.fn(async (query?: CentralLoadQuery): Promise<VersionedConversationLike[]> => {
    const wanted = query?.ids
    return [...rows.values()].filter(
      (row) => (query?.includeDeleted || !row.deletedAt) && (!wanted || wanted.includes(row.id))
    )
  })
  return {
    rows,
    load,
    put: (row: VersionedConversationLike): void => void rows.set(row.id, row),
    drop: (id: string): void => void rows.delete(id)
  }
}
export type Db = ReturnType<typeof makeDb>

export function setup(db: Db, extra: Partial<CentralIndexStoreDeps> = {}) {
  const listeners = new Set<CentralChangeHandler>()
  const unsubscribe = vi.fn()
  const clock = { now: 1_000_000 }
  const store = createCentralIndexStore({
    load: db.load,
    subscribe: (handler) => {
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
        unsubscribe()
      }
    },
    exists: () => true,
    sandboxRoot: SANDBOX_ROOT,
    now: () => clock.now,
    ...extra
  })
  /** O feed real entrega um LOTE de mudanças por vez. */
  const emit = (...changes: CentralChangeLike[]): void => {
    for (const listener of listeners) listener(changes)
  }
  return { store, emit, clock, unsubscribe, listeners }
}

/** Atalho: o store com as dependências padrão do `setup`. */
export function makeStore(db: Db, extra: Partial<CentralIndexStoreDeps> = {}) {
  return setup(db, extra).store
}

export const change = (entityId: string, entity = 'conversation'): CentralChangeLike => ({ entity, entityId })
export const ids = (index: CentralIndex): string[] => [...index.byId.keys()].sort()

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
