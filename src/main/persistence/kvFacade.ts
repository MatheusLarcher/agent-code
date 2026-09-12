import { kvGet as legacyKvGet, kvSet as legacyKvSet } from '../store'
import { persistedKeyDefinition } from './keyRegistry'
import type { KvScope, PersistenceRepository, VersionedKv } from './types'

let repository: PersistenceRepository | null = null
let offline = false
const writes = new Map<string, Promise<VersionedKv>>()

export function configureKvRepository(next: PersistenceRepository | null): void {
  repository = next
  offline = false
  writes.clear()
}

export function configureKvRepositoryOffline(): void {
  repository = null
  offline = true
  writes.clear()
}

export function hasConfiguredKvRepository(): boolean {
  // Offline PostgreSQL is still an explicitly selected managed backend. Treating
  // it as "unconfigured" would let callers silently read the legacy SQLite KV.
  return repository !== null || offline
}

export async function readPersistedKv(key: string): Promise<string | null> {
  if (offline) throw new Error('Storage autoritativo offline.')
  if (!repository) return legacyKvGet(key)
  const definition = persistedKeyDefinition(key)
  return (await repository.getKv({ scope: definition.scope, key }))?.value ?? null
}

/**
 * Lê várias chaves de uma vez, agrupadas pelo escopo declarado no registro.
 * Devolve `null` para a chave ausente, igual ao `readPersistedKv`. O ganho é de
 * rede: com PostgreSQL remoto, ler a configuração campo a campo era uma ida e
 * volta por campo ANTES de a janela existir.
 */
export async function readPersistedKvMany(keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(keys.map((key) => [key, null]))
  if (!keys.length) return out
  if (offline) throw new Error('Storage autoritativo offline.')
  if (!repository) {
    for (const key of keys) out.set(key, legacyKvGet(key))
    return out
  }
  const byScope = new Map<KvScope, string[]>()
  for (const key of keys) {
    const { scope } = persistedKeyDefinition(key)
    const bucket = byScope.get(scope)
    if (bucket) bucket.push(key)
    else byScope.set(scope, [key])
  }
  const reads = await Promise.all(
    [...byScope].map(([scope, scopedKeys]) => repository!.getKvMany(scope, scopedKeys))
  )
  for (const entry of reads.flat()) out.set(entry.key, entry.value)
  return out
}

export async function writePersistedKv(key: string, value: string): Promise<void> {
  if (offline) throw new Error('Storage autoritativo offline.')
  if (!repository) {
    legacyKvSet(key, value)
    return
  }
  const definition = persistedKeyDefinition(key)
  const queueKey = `${definition.scope}:${key}`
  const previous = writes.get(queueKey)
  const run = async (): Promise<VersionedKv> => {
    await previous?.catch(() => undefined)
    const current = await repository!.getKv({ scope: definition.scope, key })
    return repository!.setKv({
      scope: definition.scope,
      key,
      value,
      ...(current ? { expectedRevision: current.revision } : {})
    })
  }
  const pending = run()
  writes.set(queueKey, pending)
  try {
    await pending
  } finally {
    if (writes.get(queueKey) === pending) writes.delete(queueKey)
  }
}
