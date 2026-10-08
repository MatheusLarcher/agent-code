// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationRecord, VersionedConversation } from '../types'
import { ConversationJournal } from './conversationJournal'
import { ConversationWriteQueue } from './conversationWriteQueue'
import { inlinePreparer } from './preparer'
import { CREATED_AT, fakeRepository, full, versioned } from './queueTestKit'

/**
 * A Central é UMA linha que os dois PCs gravam (ver shared/centralMerge.ts). A fila
 * do PC A grava a dele mesclada por dono com a revisão que o CAS espera; o B é o
 * "outro writer" que avança a linha no banco falso.
 */

const A = 'pc-a'
const B = 'pc-b'

function req(id: string, ts: number, device: string): Record<string, unknown> {
  return { kind: 'request', id, ts, text: id, state: 'delivered', device }
}

function central(entries: Record<string, unknown>[], updatedAt = 1): ConversationRecord {
  return { id: 'central', title: 'Central', cwd: '', mode: 'central', createdAt: CREATED_AT, updatedAt, messages: [], central: { entries } }
}

const ids = (payload: unknown): string[] =>
  ((payload as { central?: { entries?: Array<{ id: string }> } } | undefined)?.central?.entries ?? []).map((e) => e.id)

let dir: string
const queues: ConversationWriteQueue[] = []

function setup() {
  const db = fakeRepository()
  const remote: VersionedConversation[] = []
  const queue = new ConversationWriteQueue({
    repository: () => db.repository,
    preparer: inlinePreparer,
    journal: new ConversationJournal(join(dir, 'fila')),
    lease: () => undefined,
    identity: async () => ({ projectId: 'p', signature: 's', remoteGit: '' }),
    installationId: () => A,
    onStatus: () => undefined,
    onResync: () => undefined,
    onCentralRemote: (record) => remote.push(record)
  })
  queues.push(queue)
  /** O A abre a Central: a leitura vira a base do CAS. */
  const open = async (): Promise<void> => queue.remember(await db.repository.loadConversations({ ids: ['central'] }))
  return { db, queue, remote, open }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-fila-central-'))
  vi.useFakeTimers({ now: CREATED_AT + 60_000 })
})

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.dispose()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('Central na fila de gravação', () => {
  it('conflito: grava mesclada por dono e entrega à tela o remoto relido', async () => {
    const { db, queue, remote, open } = setup()
    db.put('central', central([req('a1', 1, A)]))
    await open()
    db.put('central', central([req('a1', 1, A), req('b1', 2, B)])) // o B grava no meio (rev 2)

    queue.apply([full(central([req('a1', 1, A), req('a2', 3, A)], 2), true)])
    await vi.advanceTimersByTimeAsync(10)

    expect(db.rows.get('central')?.revision).toBe(3)
    expect(ids(db.rows.get('central')?.payload)).toEqual(['a1', 'b1', 'a2'])
    expect(remote.map((record) => [record.revision, ids(record.payload)])).toEqual([[2, ['a1', 'b1']]])
  })

  it('dois conflitos seguidos: relê e mescla a cada um, e a terceira tentativa grava', async () => {
    const { db, queue, remote, open } = setup()
    db.put('central', central([req('a1', 1, A)]))
    await open()
    db.put('central', central([req('a1', 1, A), req('b1', 2, B)])) // rev 2
    db.state.afterLoad.push(() => db.put('central', central([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)]))) // rev 3

    queue.apply([full(central([req('a1', 1, A), req('a2', 3, A)], 2), true)])
    await vi.advanceTimersByTimeAsync(10)

    expect(db.rows.get('central')?.revision).toBe(4)
    expect(ids(db.rows.get('central')?.payload)).toEqual(['a1', 'b1', 'a2', 'b2'])
    // Uma entrega só: o remoto mais novo relido.
    expect(remote.map((record) => record.revision)).toEqual([3])
  })

  it('todos conflitando (1 tentativa + 3 rebases): espera e tenta de novo, sem perder a entrada daqui', async () => {
    const { db, queue, open } = setup()
    db.put('central', central([req('a1', 1, A)]))
    await open()
    const fromB = [req('b1', 2, B), req('b2', 4, B), req('b3', 5, B), req('b4', 6, B)]
    const bWrites = (n: number) => () => db.put('central', central([req('a1', 1, A), ...fromB.slice(0, n)]))
    bWrites(1)() // rev 2
    db.state.afterLoad.push(bWrites(2), bWrites(3), bWrites(4)) // revs 3, 4 e 5: toda nova tentativa perde

    queue.apply([full(central([req('a1', 1, A), req('a2', 3, A)], 2), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(ids(db.rows.get('central')?.payload)).toEqual(['a1', 'b1', 'b2', 'b3', 'b4'])
    // Disputa, não recusa: continua pendente (vai para o diário se fechar agora).
    expect(queue.status()).toMatchObject({ state: 'pending', pending: 1 })

    await vi.advanceTimersByTimeAsync(1_100) // a nova tentativa, depois da espera
    expect(ids(db.rows.get('central')?.payload)).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'b4'])
    expect(queue.status()).toMatchObject({ state: 'saved', pending: 0 })
  })

  it('cópia da tela capturada antes de receber o remoto não apaga as entradas do outro PC', async () => {
    const { db, queue, open } = setup()
    db.put('central', central([req('a1', 1, A)]))
    db.put('central', central([req('a1', 1, A), req('b1', 2, B)]))
    await open() // a fila já viu o b1 (feed/leitura), a tela ainda não

    queue.apply([full(central([req('a1', 1, A), req('a3', 4, A)], 2), true)])
    await vi.advanceTimersByTimeAsync(10)

    expect(db.rows.get('central')?.revision).toBe(3)
    expect(ids(db.rows.get('central')?.payload)).toEqual(['a1', 'b1', 'a3'])
  })

  it('leitura com a Central pendente: as entradas daqui vêm da fila, as do outro PC, do banco', async () => {
    const { db, queue, open } = setup()
    db.put('central', central([req('a1', 1, A)]))
    await open()
    db.state.online = false
    queue.apply([full(central([req('a1', 1, A), req('a2', 3, A)], 2))])
    db.put('central', central([req('a1', 1, A), req('b1', 2, B)])) // o B grava; o A está sem banco

    const [seen] = queue.overlay([versioned('central', db.rows.get('central')!)])
    expect(seen.revision).toBe(2)
    expect(ids(seen.payload)).toEqual(['a1', 'b1', 'a2'])
  })
})
