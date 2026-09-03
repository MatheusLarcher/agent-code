// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 8 live conversations in A, 2 in B, plus one deleted in A. `updated_at` follows write order. */
async function seeded(): Promise<SqliteRepository> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-sqlite-paging-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  for (let i = 1; i <= 8; i++) {
    await repository.upsertConversation({ id: `a${i}`, payload: { id: `a${i}`, cwd: 'C:/a', title: `A${i}` } })
  }
  await repository.upsertConversation({ id: 'b1', payload: { id: 'b1', cwd: 'C:/b', title: 'B1' } })
  await repository.upsertConversation({ id: 'b2', payload: { id: 'b2', cwd: 'C:/b', title: 'B2' } })
  const dead = await repository.upsertConversation({ id: 'a9', payload: { id: 'a9', cwd: 'C:/a', title: 'apagada' } })
  await repository.deleteConversation({ id: 'a9', expectedRevision: dead.revision })
  return repository
}

describe('SqliteRepository — paginação por projeto', () => {
  it('perProject devolve só as N mais recentes de CADA projeto, sem contar tombstones', async () => {
    const repository = await seeded()
    const page = await repository.loadConversations({ perProject: 6, includeDeleted: true })
    const byCwd = (cwd: string): string[] => page.filter((c) => c.payload.cwd === cwd).map((c) => c.id)
    // A has 8 live rows → the 6 most recent (a8..a3); the deleted a9 takes no slot.
    expect(byCwd('C:/a')).toEqual(['a8', 'a7', 'a6', 'a5', 'a4', 'a3'])
    expect(byCwd('C:/b')).toEqual(['b2', 'b1'])
    expect(page.some((c) => c.deletedAt)).toBe(false)
    await repository.close()
  })

  it('cwd devolve o projeto inteiro; ids devolve só os pedidos (com tombstone)', async () => {
    const repository = await seeded()
    const all = await repository.loadConversations({ cwd: 'C:/a' })
    expect(all.map((c) => c.id)).toEqual(['a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1'])
    const some = await repository.loadConversations({ ids: ['a1', 'a9', 'nao-existe'], includeDeleted: true })
    expect(some.map((c) => c.id).sort()).toEqual(['a1', 'a9'])
    expect(some.find((c) => c.id === 'a9')?.deletedAt).toBeTruthy()
    expect(await repository.loadConversations({ ids: [] })).toEqual([])
    await repository.close()
  })

  it('sem query continua devolvendo tudo (contrato legado intacto)', async () => {
    const repository = await seeded()
    expect((await repository.loadConversations({ includeDeleted: true })).length).toBe(11)
    expect((await repository.loadConversations()).length).toBe(10)
    await repository.close()
  })

  it('countConversationsByProject conta só as vivas', async () => {
    const repository = await seeded()
    const counts = await repository.countConversationsByProject()
    expect(counts.sort((x, y) => x.cwd.localeCompare(y.cwd))).toEqual([
      { cwd: 'C:/a', total: 8 },
      { cwd: 'C:/b', total: 2 }
    ])
    await repository.close()
  })
})
