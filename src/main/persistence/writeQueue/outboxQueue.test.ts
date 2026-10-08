// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageError, type ConversationOutboxRepository } from '../types'
import { ConversationJournal } from './conversationJournal'
import { OutboxWriteQueue } from './outboxQueue'

let dir: string
const queues: OutboxWriteQueue[] = []

function setup() {
  const rows = new Map<string, Array<{ id: string; payload: unknown }>>()
  const state = { online: true }
  const repository: ConversationOutboxRepository = {
    listConversationOutbox: vi.fn(async () =>
      [...rows].flatMap(([conversationId, items]) => items.map((item) => ({ conversationId, ...item })))
    ),
    replaceConversationOutbox: vi.fn(async (conversationId: string, items: ReadonlyArray<{ id: string; payload: unknown }>) => {
      if (!state.online) throw new StorageError('CONNECTION_REFUSED', 'fora do ar', true)
      rows.set(conversationId, [...items])
    })
  }
  const journal = new ConversationJournal(join(dir, 'fila', 'outbox'))
  const make = (): OutboxWriteQueue => {
    const queue = new OutboxWriteQueue({ repository: () => (state.online ? repository : null), journal })
    queues.push(queue)
    return queue
  }
  return { rows, state, repository, journal, make }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-outbox-'))
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.dispose()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('OutboxWriteQueue', () => {
  it('a lista mais nova de cada conversa vence: uma rajada vira uma gravação', async () => {
    const { rows, repository, make } = setup()
    const queue = make()
    queue.replace('c1', [{ id: 'a', payload: 1 }])
    queue.replace('c1', [{ id: 'a', payload: 1 }, { id: 'b', payload: 2 }])
    await vi.advanceTimersByTimeAsync(200)
    expect(repository.replaceConversationOutbox).toHaveBeenCalledTimes(1)
    expect(rows.get('c1')?.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('banco fora: a leitura já mostra o pendente; diário em ~3 s; fechar e reabrir reaplica sem perder a mensagem', async () => {
    const { rows, state, make } = setup()
    const first = make()
    state.online = false
    first.replace('c1', [{ id: 'na-queda', payload: { text: 'mensagem na fila' } }])
    expect(first.overlay([{ conversationId: 'c2', id: 'x', payload: 0 }]).map((item) => item.id)).toEqual(['x', 'na-queda'])
    await vi.advanceTimersByTimeAsync(4_100)
    await vi.waitFor(async () => expect(await readdir(join(dir, 'fila', 'outbox'))).toHaveLength(1))
    await expect(first.flush(1_000)).resolves.toBe(false)
    expect(await first.journalPending()).toBe(1)
    first.dispose()

    // Próxima abertura, banco de volta.
    state.online = true
    const second = make()
    await expect(second.restoreJournal()).resolves.toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(rows.get('c1')).toEqual([{ id: 'na-queda', payload: { text: 'mensagem na fila' } }])
    await vi.waitFor(async () => expect(await readdir(join(dir, 'fila', 'outbox'))).toEqual([]))
  })

  it('o banco volta: kick grava já, sem esperar o recuo', async () => {
    const { rows, state, make } = setup()
    const queue = make()
    state.online = false
    queue.replace('c1', [{ id: 'a', payload: 1 }])
    await vi.advanceTimersByTimeAsync(200)
    state.online = true
    queue.kick()
    await vi.advanceTimersByTimeAsync(5)
    expect(rows.get('c1')).toEqual([{ id: 'a', payload: 1 }])
  })
})
