// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { planReplayBatch, replayDedupStore, sessionKeyId } from './replayDedup'

/** Store em memória com a mesma semântica do Postgres: uuid é chave única,
 *  entrada sem uuid é sempre anexada. */
function memoryStore(): SessionStore & { rows: Map<string, SessionStoreEntry[]> } {
  const rows = new Map<string, SessionStoreEntry[]>()
  return {
    rows,
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      const list = rows.get(sessionKeyId(key)) ?? []
      for (const entry of entries) {
        if (entry.uuid && list.some((row) => row.uuid === entry.uuid)) continue
        list.push(entry)
      }
      rows.set(sessionKeyId(key), list)
    },
    async load(key: SessionKey) {
      return rows.get(sessionKeyId(key)) ?? null
    }
  }
}

const key: SessionKey = { projectKey: 'p', sessionId: '11111111-1111-4111-8111-111111111111' }
const user = (n: number): SessionStoreEntry => ({ type: 'user', uuid: `u-${n}`, n })
const title = (t: string): SessionStoreEntry => ({ type: 'custom-title', customTitle: t })

describe('replay sem duplicar', () => {
  it('reenviar o transcript inteiro só grava o que o banco perdeu', async () => {
    const store = memoryStore()
    const transcript = [user(1), title('A'), user(2), user(3), title('B'), user(4)]
    // Espelho vivo: o 1º lote gravou, o 2º (user 3, título B, user 4) foi descartado.
    await store.append(key, transcript.slice(0, 3))

    await replayDedupStore(store).append(key, transcript)

    expect(await store.load(key)).toEqual([user(1), title('A'), user(2), user(3), title('B'), user(4)])
  })

  it('replay repetido é idempotente', async () => {
    const store = memoryStore()
    const transcript = [title('A'), user(1), title('A')]
    await replayDedupStore(store).append(key, transcript)
    await replayDedupStore(store).append(key, transcript)
    expect(await store.load(key)).toHaveLength(3)
  })

  it('repetição legítima sem uuid sobrevive (conta ocorrências, não existência)', async () => {
    const store = memoryStore()
    // O banco tem o 1º "A"; o 2º "A" (título redefinido) estava no lote perdido.
    await store.append(key, [title('A'), user(1)])
    await replayDedupStore(store).append(key, [title('A'), user(1), title('B'), title('A')])
    const titles = ((await store.load(key)) ?? []).filter((entry) => entry.type === 'custom-title')
    expect(titles.map((entry) => entry.customTitle)).toEqual(['A', 'B', 'A'])
  })

  it('conta através de vários lotes do mesmo replay', async () => {
    const store = memoryStore()
    await store.append(key, [title('A')])
    const replay = replayDedupStore(store)
    await replay.append(key, [title('A')])
    await replay.append(key, [title('A')])
    expect(((await store.load(key)) ?? []).length).toBe(2)
  })

  it('entradas idênticas legítimas em momentos diferentes continuam gravadas (espelho vivo não deduplica; replay não as remove nem duplica)', async () => {
    const store = memoryStore()
    // Espelho vivo: a mesma tag em dois turnos diferentes, em lotes separados.
    await store.append(key, [user(1), title('X')])
    await store.append(key, [user(2), title('X')])
    // Lote perdido (3º turno, mesma tag de novo) — só o transcript local tem.
    const transcript = [user(1), title('X'), user(2), title('X'), user(3), title('X')]

    // Reparo repetido (a 1ª tentativa caiu no meio): em lotes, duas vezes.
    for (let round = 0; round < 2; round += 1) {
      const replay = replayDedupStore(store)
      await replay.append(key, transcript.slice(0, 3))
      await replay.append(key, transcript.slice(3))
    }

    const rows = (await store.load(key)) ?? []
    expect(rows.filter((entry) => entry.type === 'custom-title')).toHaveLength(3)
    expect(rows.filter((entry) => entry.uuid)).toHaveLength(3)
  })

  it('subpath é contado à parte', async () => {
    const store = memoryStore()
    const sub: SessionKey = { ...key, subpath: 'subagents/agent-x' }
    await store.append(key, [title('A')])
    await replayDedupStore(store).append(sub, [title('A')])
    expect(await store.load(sub)).toEqual([title('A')])
  })
})

describe('planReplayBatch', () => {
  it('não altera os mapas recebidos (o chamador só guarda depois do commit)', () => {
    const stored = new Map<string, number>()
    const seen = new Map<string, number>()
    const plan = planReplayBatch([title('A')], stored, seen)
    expect(plan.keep).toHaveLength(1)
    expect(seen.size).toBe(0)
    expect(stored.size).toBe(0)
    expect(plan.seen.size).toBe(1)
  })
})
