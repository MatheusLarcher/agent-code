import { kvGet as legacyKvGet, kvSet as legacyKvSet } from '../store'
import { isLocalPersistedKey, localPersistedKeys, persistedKeyDefinition } from './keyRegistry'
import type { LocalKvStore } from './localKvStore'
import type { KvScope, PersistenceRepository, VersionedKv } from './types'

let repository: PersistenceRepository | null = null
let offline = false
let local: LocalKvStore | null = null
/** Fechada só na 1ª abertura depois da atualização, até a cópia única do banco. */
let seedGate: { promise: Promise<void>; open: () => void } | null = null
const writes = new Map<string, Promise<VersionedKv>>()

/** Marcador, no próprio SQLite local, da cópia única que veio do banco. */
const LOCAL_SEED_MARK = 'seeded-from-repository'

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

/** As chaves `store: 'local'` (config, contas Claude, estado da tela) passam a
 *  morar neste SQLite: lidas e gravadas com o banco de pé ou não. */
export function configureLocalKvStore(next: LocalKvStore | null): void {
  local = next
}

/**
 * Na 1ª abertura depois da atualização, o SQLite local ainda não tem o que está
 * no banco: quem lesse antes da cópia (tela, contas, config) pegaria o vazio — e
 * poderia regravá-lo por cima. Até `releaseLocalKv()`, as chaves locais esperam.
 */
export function holdLocalKvUntilSeeded(): void {
  if (seedGate || localKvSeeded()) return
  let open!: () => void
  seedGate = { promise: new Promise<void>((resolve) => (open = resolve)), open }
}

export function releaseLocalKv(): void {
  seedGate?.open()
  seedGate = null
}

async function localStore(): Promise<LocalKvStore> {
  await seedGate?.promise
  return local!
}

export function hasConfiguredKvRepository(): boolean {
  // Offline PostgreSQL is still an explicitly selected managed backend. Treating
  // it as "unconfigured" would let callers silently read the legacy SQLite KV.
  return repository !== null || offline
}

const isLocal = (key: string): boolean => local !== null && isLocalPersistedKey(key)

export async function readPersistedKv(key: string): Promise<string | null> {
  if (isLocal(key)) return (await localStore()).get(key)
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
  const localKeys = keys.filter(isLocal)
  if (localKeys.length) for (const [key, value] of (await localStore()).getMany(localKeys)) out.set(key, value)
  const remoteKeys = keys.filter((key) => !isLocal(key))
  if (!remoteKeys.length) return out
  if (offline) throw new Error('Storage autoritativo offline.')
  if (!repository) {
    for (const key of remoteKeys) out.set(key, legacyKvGet(key))
    return out
  }
  const byScope = new Map<KvScope, string[]>()
  for (const key of remoteKeys) {
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
  if (isLocal(key)) {
    const store = await localStore()
    store.set(key, value)
    return
  }
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

/** A cópia única do banco para o SQLite local já foi feita? */
export function localKvSeeded(): boolean {
  return !local || local.meta(LOCAL_SEED_MARK) !== null
}

/**
 * Atualização: copia UMA vez, do backend autoritativo para o SQLite local, o
 * valor das chaves que agora moram nele. O banco vence o que o SQLite já tiver —
 * até a atualização, era ele a fonte. Sem banco à mão, fica para quando ele
 * voltar. Devolve se copiou agora (quem chama relê a configuração).
 */
export function seedLocalKvFromRepository(): Promise<boolean> {
  // Uma cópia por vez: a abertura e o aviso de "banco pronto" chamam juntos.
  seeding ??= copyRepositoryToLocal().finally(() => {
    seeding = null
  })
  return seeding
}

let seeding: Promise<boolean> | null = null

async function copyRepositoryToLocal(): Promise<boolean> {
  const source = repository
  const target = local
  if (!target || !source || localKvSeeded()) return false
  const byScope = new Map<KvScope, string[]>()
  for (const key of localPersistedKeys()) {
    const { scope } = persistedKeyDefinition(key)
    byScope.set(scope, [...(byScope.get(scope) ?? []), key])
  }
  const found = (await Promise.all([...byScope].map(([scope, keys]) => source.getKvMany(scope, keys)))).flat()
  target.setMany(found.map((entry): [string, string] => [entry.key, entry.value]))
  target.setMeta(LOCAL_SEED_MARK, new Date().toISOString())
  return true
}
