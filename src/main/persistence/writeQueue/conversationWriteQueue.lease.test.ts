// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageError } from '../types'
import { ConversationJournal, type JournalEntry } from './conversationJournal'
import { ConversationWriteQueue } from './conversationWriteQueue'
import { inlinePreparer } from './preparer'
import { CREATED_AT, conversation, fakeRepository, full } from './queueTestKit'

let dir: string
const queues: ConversationWriteQueue[] = []

/** Diário em memória: o relógio falso manda em tudo, sem esperar o disco de verdade. */
function memoryJournal() {
  const files = new Map<string, JournalEntry>()
  const journal = {
    save: async (entry: JournalEntry) => { files.set(entry.id, JSON.parse(JSON.stringify(entry)) as JournalEntry) },
    remove: async (id: string) => { files.delete(id) },
    loadAll: async () => [...files.values()]
  } as unknown as ConversationJournal
  return { files, journal }
}

function setup(memory?: ReturnType<typeof memoryJournal>) {
  const db = fakeRepository()
  const journal = memory?.journal ?? new ConversationJournal(join(dir, 'fila'))
  const saves = vi.spyOn(journal, 'save')
  const logs: string[] = []
  const queue = new ConversationWriteQueue({
    repository: () => db.repository,
    preparer: inlinePreparer,
    journal,
    lease: () => undefined,
    identity: async () => ({ projectId: 'p', signature: 's', remoteGit: '' }),
    installationId: () => 'pc-a',
    onStatus: () => undefined,
    onResync: () => undefined,
    onCentralRemote: () => undefined,
    log: (line) => logs.push(line)
  })
  queues.push(queue)
  return { db, queue, journal, saves, logs }
}

const files = (): Promise<string[]> => readdir(join(dir, 'fila')).catch(() => [])
const lastText = (payload: unknown): string => {
  const messages = (payload as { messages: Array<{ text: string }> }).messages
  return messages[messages.length - 1].text
}
const delta = (text: string) => ({ id: 'c1', messagesFrom: 1, messages: [{ kind: 'assistant-text', id: 'a', text }], messageCount: 2 })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-fila-lease-'))
  vi.useFakeTimers({ now: CREATED_AT + 60_000 })
})

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.dispose()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('ConversationWriteQueue: lease e diário', () => {
  it('lease recusado: tenta de novo sozinho (sem nova mudança), sem ficar offline, e grava a versão mais nova', async () => {
    const { db, queue, logs } = setup()
    db.state.failNext = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    queue.apply([full(conversation('c1', ['fim do turno']), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(db.state.writes).toBe(0)
    expect(queue.status()).toMatchObject({ state: 'pending', pending: 1 })
    expect(queue.onlyRefusedLeft()).toBe(false)
    expect(logs).toContain('[fila] c1: lease recusado, nova tentativa (Lease ou fencing token inválido.)')
    await vi.advanceTimersByTimeAsync(1_100)
    expect(db.state.writes).toBe(1)
    expect(lastText(db.rows.get('c1')?.payload)).toBe('fim do turno')
    expect(queue.status()).toMatchObject({ state: 'saved', pending: 0 })
  })

  it('recusa definitiva vai para o diário em ~3 s, com o instantâneo mais novo, e o timer para', async () => {
    const { db, queue, journal, saves } = setup()
    db.state.failNext = new StorageError('INVALID_PERSISTED_DATA', 'payload torto')
    queue.apply([full(conversation('c1', ['v1']), true)])
    await vi.advanceTimersByTimeAsync(10)
    db.state.failNext = new StorageError('INVALID_PERSISTED_DATA', 'payload torto')
    queue.apply([full(conversation('c1', ['v2']), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(queue.status()).toMatchObject({ state: 'error', error: 'payload torto' })
    expect(saves).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_100)
    await vi.waitFor(async () => expect((await journal.loadAll()).map((e) => lastText(e.doc))).toEqual(['v2']), { timeout: 10_000 })
    // Já no diário: o timer para e não regrava o arquivo à toa.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(saves).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    // Fechamento também leva a recusa (nada fica só em memória).
    await expect(queue.journalPending()).resolves.toBe(1)
    expect(queue.onlyRefusedLeft()).toBe(true)
    await expect(queue.flush(null, 2_000)).resolves.toBe(false)
  })

  it('streaming contínuo com banco saudável não escreve diário', async () => {
    const { db, queue, saves } = setup()
    db.state.delayMs = 300
    queue.apply([full(conversation('c1', ['oi']))])
    for (let i = 0; i < 100; i++) {
      queue.apply([delta(`t${i}`)])
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(db.state.writes).toBeGreaterThanOrEqual(5)
    expect(queue.status().oldestMs).toBeLessThan(3_000)
    expect(saves).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lastText(db.rows.get('c1')?.payload)).toBe('t99')
    expect(saves).not.toHaveBeenCalled()
    expect(await files()).toEqual([])
  })

  it('diário do banco lento é apagado quando uma gravação cobre a versão dele, mesmo com mudança nova chegando', async () => {
    const memory = memoryJournal()
    const { db, queue } = setup(memory)
    const journaled = (): string | undefined => {
      const entry = memory.files.get('c1')
      return entry?.doc ? lastText(entry.doc) : undefined
    }
    db.state.delayMs = 4_000
    queue.apply([full(conversation('c1', ['oi']), true)])
    let i = 0
    const stream = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 500) {
        queue.apply([delta(`t${i++}`)])
        await vi.advanceTimersByTimeAsync(500)
      }
    }
    // Banco lento: a mudança passa de 3 s sem chegar lá e vai para o diário.
    await stream(3_500)
    expect(journaled()).toBeDefined()
    // O banco melhora, mas as mudanças seguem chegando: a fila nunca alcança tudo,
    // então só a regra "o banco cobre o diário" apaga o arquivo.
    db.state.delayMs = 1_000
    for (let k = 0; k < 20 && memory.files.size; k++) await stream(500)
    expect(queue.isPending('c1')).toBe(true)
    expect(memory.files.size).toBe(0)
    // Seguindo o streaming, o diário não volta (a espera conta da mudança mais antiga não gravada).
    await stream(4_000)
    expect(memory.files.size).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(lastText(db.rows.get('c1')?.payload)).toBe(`t${i - 1}`)
    expect(queue.status()).toMatchObject({ state: 'saved', pending: 0 })
  })
})
