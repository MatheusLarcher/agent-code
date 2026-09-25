// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'

const dirs: string[] = []

async function open(dir?: string): Promise<{ repo: SqliteRepository; dir: string }> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), 'agent-code-outbox-')))
  if (!dir) dirs.push(base)
  const repo = new SqliteRepository(base, join(base, 'agent-code.db'), 'outbox-test')
  await repo.initialize()
  return { repo, dir: base }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ConversationOutboxRepository (SQLite) — fila de espera que sobrevive ao reinício', () => {
  it('grava a fila de cada conversa na ordem e devolve igual depois de reabrir o banco', async () => {
    const first = await open()
    await first.repo.replaceConversationOutbox('conv-a', [
      { id: 'q1', payload: { text: 'primeira', images: [{ mediaType: 'image/png', data: 'AAA' }] } },
      { id: 'q2', payload: { text: 'segunda' } }
    ])
    await first.repo.replaceConversationOutbox('conv-b', [{ id: 'q3', payload: { text: 'do manager' } }])
    await first.repo.close()

    // "Reiniciar o app": abre o mesmo arquivo de novo.
    const again = await open(first.dir)
    const items = await again.repo.listConversationOutbox()
    expect(items.map((i) => [i.conversationId, i.id])).toEqual([
      ['conv-a', 'q1'],
      ['conv-a', 'q2'],
      ['conv-b', 'q3']
    ])
    expect(items[0].payload).toEqual({ text: 'primeira', images: [{ mediaType: 'image/png', data: 'AAA' }] })
    await again.repo.close()
  })

  it('trocar a fila substitui a anterior; lista vazia apaga só aquela conversa', async () => {
    const { repo } = await open()
    await repo.replaceConversationOutbox('conv-a', [{ id: 'q1', payload: 1 }, { id: 'q2', payload: 2 }])
    await repo.replaceConversationOutbox('conv-b', [{ id: 'q9', payload: 9 }])
    await repo.replaceConversationOutbox('conv-a', [{ id: 'q2', payload: 2 }])
    expect((await repo.listConversationOutbox()).map((i) => i.id)).toEqual(['q2', 'q9'])
    await repo.replaceConversationOutbox('conv-a', [])
    expect((await repo.listConversationOutbox()).map((i) => i.id)).toEqual(['q9'])
    await repo.close()
  })
})
