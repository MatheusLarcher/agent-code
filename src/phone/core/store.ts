/**
 * Store mínimo (sem dependência): estado imutável + inscrição, lido no React por
 * useSyncExternalStore. O cliente da ponte (client.ts) escreve; as telas leem.
 */
import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void
  subscribe: (fn: () => void) => () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch
      const keys = Object.keys(p) as Array<keyof T>
      if (!keys.some((k) => !Object.is(state[k], p[k]))) return
      state = { ...state, ...p }
      for (const fn of subs) fn()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
}

/** Lê um pedaço do store (re-renderiza só quando ele muda por referência). */
export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()))
}
