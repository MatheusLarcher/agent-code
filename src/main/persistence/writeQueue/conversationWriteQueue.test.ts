// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageError, type ConversationRecord, type VersionedConversation } from '../types'
import { ConversationJournal } from './conversationJournal'
import { ConversationWriteQueue } from './conversationWriteQueue'
import { inlinePreparer } from './preparer'
import { CREATED_AT, conversation, fakeRepository, full } from './queueTestKit'

let dir: string
const queues: ConversationWriteQueue[] = []

function setup(options: { online?: boolean } = {}) {
  const db = fakeRepository()
  db.state.online = options.online ?? true
  const journal = new ConversationJournal(join(dir, 'fila'))
  const events = { resync: [] as string[], central: [] as VersionedConversation[], status: [] as string[] }
  const queue = new ConversationWriteQueue({
    repository: () => db.repository,
    preparer: inlinePreparer,
    journal,
    lease: () => undefined,
    identity: async () => ({ projectId: 'p', signature: 's', remoteGit: '' }),
    installationId: () => 'pc-a',
    onStatus: (status) => events.status.push(status.state),
    onResync: (id) => events.resync.push(id),
    onCentralRemote: (record) => events.central.push(record)
  })
  queues.push(queue)
  return { db, queue, journal, events }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-fila-'))
  vi.useFakeTimers({ now: CREATED_AT + 60_000 })
})

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.dispose()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('ConversationWriteQueue', () => {
  it('coalesce: uma rajada de mudanças vira uma gravação, com a última versão', async () => {
    const { db, queue } = setup()
    const base = conversation('c1', ['oi'])
    queue.apply([full(base)])
    for (let i = 0; i < 10; i++) queue.apply([{ id: 'c1', messagesFrom: 1, messages: [{ kind: 'assistant-text', id: 'a', text: `parte ${i}` }], messageCount: 2 }])
    await vi.advanceTimersByTimeAsync(200)
    expect(db.state.writes).toBe(1)
    expect((db.rows.get('c1')?.payload.messages as Array<{ text: string }>)[1].text).toBe('parte 9')
  })

  it('streaming: no máximo ~1 gravação por segundo por conversa; urgente grava na hora', async () => {
    const { db, queue } = setup()
    queue.apply([full(conversation('c1', ['oi']))])
    await vi.advanceTimersByTimeAsync(200)
    for (let i = 0; i < 30; i++) {
      queue.apply([{ id: 'c1', messagesFrom: 1, messages: [{ kind: 'assistant-text', id: 'a', text: `t${i}` }], messageCount: 2 }])
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(db.state.writes).toBeGreaterThanOrEqual(3)
    expect(db.state.writes).toBeLessThanOrEqual(5)
    const before = db.state.writes
    queue.apply([{ id: 'c1', messagesFrom: 1, messages: [{ kind: 'assistant-text', id: 'a', text: 'fim' }], messageCount: 2, urgent: true }])
    await vi.advanceTimersByTimeAsync(1)
    expect(db.state.writes).toBe(before + 1)
  })

  it('pula a gravação sem mudança, mesmo com outro objeto e outra ordem de chaves', async () => {
    const { db, queue } = setup()
    queue.apply([full(conversation('c1', ['oi'], { tokens: { context: 1, output: 2 } }))])
    await vi.advanceTimersByTimeAsync(200)
    expect(db.state.writes).toBe(1)
    const same = { tokens: { output: 2, context: 1 }, ...conversation('c1', ['oi']) }
    for (let i = 0; i < 5; i++) {
      queue.apply([full(same, true)])
      await vi.advanceTimersByTimeAsync(1_100)
    }
    expect(db.state.writes).toBe(1)
  })

  it('ordem por conversa: uma gravação por vez, e o banco termina com a última versão', async () => {
    const { db, queue } = setup()
    db.state.delayMs = 500
    queue.apply([full(conversation('c1', ['v1']), true)])
    await vi.advanceTimersByTimeAsync(10)
    queue.apply([full(conversation('c1', ['v2']), true)])
    queue.apply([full(conversation('c1', ['v3']), true)])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(db.state.maxInFlight).toBe(1)
    expect((db.rows.get('c1')?.payload.messages as Array<{ text: string }>)[0].text).toBe('v3')
  })

  it('conflito de revisão: relê e regrava por cima (o que está na tela vence)', async () => {
    const { db, queue } = setup()
    queue.apply([full(conversation('c1', ['minha']), true)])
    await vi.advanceTimersByTimeAsync(10)
    // Outro writer avançou a linha.
    const row = db.rows.get('c1')!
    db.rows.set('c1', { ...row, revision: row.revision + 1, payload: { ...row.payload, title: 'deles' }, contentHash: 'outro' })
    queue.apply([full(conversation('c1', ['minha', 'nova']), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rows.get('c1')).toMatchObject({ revision: 3 })
    expect((db.rows.get('c1')?.payload.messages as unknown[]).length).toBe(2)
  })

  it('Central: grava mesclada com as entradas do outro PC e entrega o remoto relido', async () => {
    const { db, queue, events } = setup()
    const entry = (id: string, device: string, ts: number) => ({ kind: 'request', id, ts, text: id, state: 'delivered', device })
    db.rows.set('central', {
      payload: { id: 'central', updatedAt: 5, messages: [], central: { entries: [entry('deles', 'pc-b', 1)] } },
      revision: 4,
      contentHash: 'x'
    })
    queue.apply([full({ id: 'central', updatedAt: 6, messages: [], central: { entries: [entry('minha', 'pc-a', 2)] } }, true)])
    await vi.advanceTimersByTimeAsync(10)
    const saved = db.rows.get('central')!
    expect(saved.revision).toBe(5)
    expect((saved.payload.central as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toEqual(['deles', 'minha'])
    expect(events.central).toHaveLength(1)
  })

  it('banco fora: espera com recuo, vai para o diário em ~3 s e grava quando volta (sem duplicar)', async () => {
    const { db, queue, journal } = setup({ online: false })
    queue.apply([full(conversation('c1', ['offline']), true)])
    await vi.advanceTimersByTimeAsync(4_100)
    expect(queue.status()).toMatchObject({ state: 'offline', pending: 1 })
    await vi.waitFor(async () => expect((await journal.loadAll()).map((e) => e.id)).toEqual(['c1']))
    db.state.online = true
    queue.kick()
    await vi.advanceTimersByTimeAsync(50)
    expect(db.state.writes).toBe(1)
    expect(queue.status()).toMatchObject({ state: 'saved', pending: 0 })
    await vi.waitFor(async () => expect(await readdir(join(dir, 'fila'))).toEqual([]))
  })

  it('diário reaplicado é idempotente: o mesmo conteúdo já no banco não vira revisão nova', async () => {
    const first = setup()
    first.queue.apply([full(conversation('c1', ['já gravado']), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(first.db.rows.get('c1')?.revision).toBe(1)
    // Uma abertura nova com o diário que ficou do fechamento anterior.
    const restored = setup()
    restored.db.rows.set('c1', first.db.rows.get('c1')!)
    restored.queue.remember(await restored.db.repository.loadConversations())
    restored.queue.restore([{ id: 'c1', deleted: false, doc: conversation('c1', ['já gravado']) as ConversationRecord, since: Date.now() }])
    await vi.advanceTimersByTimeAsync(1_200)
    expect(restored.db.state.writes).toBe(0)
    expect(restored.db.rows.get('c1')?.revision).toBe(1)
  })

  it('apagar vira tombstone; mudança sem base pede a conversa inteira', async () => {
    const { db, queue, events } = setup()
    queue.apply([full(conversation('c1', ['x']), true)])
    await vi.advanceTimersByTimeAsync(10)
    queue.apply([{ id: 'c1', deleted: true, urgent: true }])
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rows.get('c1')?.deletedAt).toBe('d')
    queue.apply([{ id: 'c9', messagesFrom: 3, messages: [], messageCount: 3 }])
    expect(events.resync).toEqual(['c9'])
  })

  it('leitura vê o pendente: payload da fila por cima do banco e conversa nova que ainda não chegou lá', async () => {
    const { db, queue } = setup({ online: false })
    db.rows.set('c1', { payload: conversation('c1', ['velha'], { cwd: 'C:/p' }) as ConversationRecord, revision: 2, contentHash: 'h' })
    queue.apply([full(conversation('c1', ['nova'], { cwd: 'C:/p' }))])
    queue.apply([full(conversation('c2', ['só na fila'], { cwd: 'C:/p' }))])
    queue.apply([full(conversation('c3', ['outra pasta'], { cwd: 'C:/q' }))])
    const stored = [...db.rows.entries()].map(([id, row]) => ({ id, payload: row.payload, revision: row.revision, contentHash: row.contentHash, createdAt: 'c', updatedAt: 'u' }))
    const seen = queue.overlay(stored, { cwd: 'C:/p' })
    expect(seen.map((r) => [r.id, (r.payload.messages as Array<{ text: string }>)[0].text])).toEqual([['c1', 'nova'], ['c2', 'só na fila']])
    expect(seen[0].revision).toBe(2)
    expect(queue.isPending('c1')).toBe(true)
  })

  it('flush com prazo: sem banco não espera; com banco devolve quando gravou', async () => {
    const offline = setup({ online: false })
    offline.queue.apply([full(conversation('c1', ['x']))])
    await expect(offline.queue.flush(null, 2_000)).resolves.toBe(false)

    const { db, queue } = setup()
    db.state.delayMs = 300
    queue.apply([full(conversation('c1', ['x']))])
    const flushed = queue.flush(['c1'], 2_000)
    await vi.advanceTimersByTimeAsync(400)
    await expect(flushed).resolves.toBe(true)
  })

  it('recusa definitiva: não fica tentando; a próxima mudança tenta de novo', async () => {
    const { db, queue } = setup()
    db.state.failNext = new StorageError('INVALID_PERSISTED_DATA', 'payload torto')
    queue.apply([full(conversation('c1', ['x']), true)])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(queue.status()).toMatchObject({ state: 'error', error: 'payload torto' })
    expect(db.state.writes).toBe(0)
    // Só recusa sobrando: uma troca de banco não fica presa esperando por ela.
    expect(queue.onlyRefusedLeft()).toBe(true)
    queue.apply([full(conversation('c1', ['y']), true)])
    await vi.advanceTimersByTimeAsync(10)
    expect(db.state.writes).toBe(1)
    expect(queue.status().state).toBe('saved')
    expect(queue.onlyRefusedLeft()).toBe(false)
  })
})
