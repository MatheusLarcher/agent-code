import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { hashJson, normalizeJson } from './hashes'

/**
 * Replay do transcript local para o store (reparo do espelho). Entrada COM uuid
 * já é idempotente no store (chave única). Entrada SEM uuid (título, tag,
 * marcador de modo, `agent_metadata`) o SDK manda anexar sem dedup — e o replay
 * reenvia o transcript INTEIRO, então sem cuidado cada uma dessas viraria
 * duplicata.
 *
 * A regra é por contagem, não por existência: a N-ésima ocorrência de um
 * conteúdo no replay só é gravada se o store tem menos de N cópias dele. Assim
 * uma repetição legítima (o mesmo título definido duas vezes) sobrevive, e o
 * que já estava no banco não é gravado de novo.
 */

export function sessionKeyId(key: SessionKey): string {
  return `${key.sessionId}\u0000${key.subpath ?? ''}`
}

export function entryHash(entry: SessionStoreEntry): string {
  return hashJson(normalizeJson(entry))
}

export function countUuidless(entries: readonly SessionStoreEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.uuid) continue
    const hash = entryHash(entry)
    counts.set(hash, (counts.get(hash) ?? 0) + 1)
  }
  return counts
}

/**
 * Decide o que do lote vai para o store. `stored` = cópias SEM uuid já no store
 * (lido agora, dentro da mesma transação quando possível); `seen` = ocorrências
 * já vistas neste replay para a mesma chave. Não altera os mapas recebidos:
 * devolve o `seen` atualizado para o chamador guardar só se o lote for gravado.
 */
export function planReplayBatch(
  entries: readonly SessionStoreEntry[],
  stored: ReadonlyMap<string, number>,
  seen: ReadonlyMap<string, number>
): { keep: SessionStoreEntry[]; seen: Map<string, number> } {
  const nextSeen = new Map(seen)
  const nextStored = new Map(stored)
  const keep: SessionStoreEntry[] = []
  for (const entry of entries) {
    if (entry.uuid) {
      keep.push(entry)
      continue
    }
    const hash = entryHash(entry)
    const occurrence = (nextSeen.get(hash) ?? 0) + 1
    nextSeen.set(hash, occurrence)
    const copies = nextStored.get(hash) ?? 0
    if (copies >= occurrence) continue
    nextStored.set(hash, copies + 1)
    keep.push(entry)
  }
  return { keep, seen: nextSeen }
}

/**
 * Embrulho genérico para qualquer `SessionStore` (usado quando o repositório não
 * tem um replay nativo). Relê o store a cada lote para contar as cópias — correto
 * mesmo com gravações concorrentes, e barato no SQLite local. O PostgreSQL faz a
 * mesma conta dentro da transação do `append` (ver postgresSessionStore.ts).
 */
export function replayDedupStore(store: SessionStore): SessionStore {
  const seenByKey = new Map<string, Map<string, number>>()
  return {
    ...store,
    async append(key, entries) {
      if (!entries.length) return
      const id = sessionKeyId(key)
      const stored = entries.some((entry) => !entry.uuid) ? countUuidless((await store.load(key)) ?? []) : new Map()
      const plan = planReplayBatch(entries, stored, seenByKey.get(id) ?? new Map())
      if (plan.keep.length) await store.append(key, plan.keep)
      seenByKey.set(id, plan.seen)
    }
  }
}
