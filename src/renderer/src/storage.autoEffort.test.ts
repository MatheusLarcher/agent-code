import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationChangeDto } from '@shared/ipc'
import { loadConversations } from './storage'
import { resetConversationSync, syncConversations } from './conversationSync'
import { applyChanges } from './conversationSyncFake'
import type { Conversation } from './types'

/** Um registro como o banco devolve hoje (VersionedConversationDto com o
 *  payload jsonb), gravado ANTES da separação dos Automáticos: modelo em
 *  Automático e um esforço fixo que o decisor ignorava. */
function legacyRecord(): Record<string, unknown> {
  return {
    id: 'c-legado',
    payload: {
      id: 'c-legado',
      title: 'Refatorar o parser',
      titleSource: 'llm',
      cwd: 'C:\\GitHub\\proj',
      model: 'auto',
      autoModel: 'claude-sonnet-5-5',
      effort: 'medium',
      fastMode: false,
      sdkSessionId: 'sess-1',
      messages: [{ kind: 'user', id: 'u1', text: 'refatora o parser', ts: 1758800000000 }],
      tokens: { context: 1200, output: 300, cost: 0.01 },
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    revision: 3,
    contentHash: 'hash',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z'
  }
}

/** Banco falso: o que a tela entrega à fila do main é o que a próxima abertura lê
 *  (o carimbo do marcador em conversa nova é do main: conversationPrepare.test.ts). */
function fakeDb(initial: Record<string, unknown>[]) {
  const rows = new Map(initial.map((row) => [row.id as string, row as Record<string, unknown> & { payload: Record<string, unknown> }]))
  const syncConversations = vi.fn((changes: ConversationChangeDto[]) => {
    const docs = [...rows.values()].map((row) => ({ ...row.payload, id: row.id as string }))
    for (const doc of applyChanges(docs, changes)) {
      const prev = rows.get(doc.id) as { revision?: number } | undefined
      rows.set(doc.id, {
        id: doc.id,
        payload: doc,
        revision: (prev?.revision ?? 0) + 1,
        contentHash: 'hash',
        createdAt: '2026-09-25T12:00:00.000Z',
        updatedAt: '2026-09-26T12:00:00.000Z'
      })
    }
  })
  const loadVersionedConversations = vi.fn(async () => [...rows.values()].map((r) => JSON.parse(JSON.stringify(r))))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadVersionedConversations, syncConversations }
  })
  return { rows, syncConversations }
}

describe('migração one-shot do esforço Automático nas conversas', () => {
  beforeEach(() => {
    localStorage.clear()
    resetConversationSync()
  })

  it("registro antigo com model:'auto' abre com effort:'auto', sem trocar o modelo salvo", async () => {
    const db = fakeDb([legacyRecord()])

    const [conv] = await loadConversations()

    expect(conv).toMatchObject({ model: 'auto', autoModel: 'claude-sonnet-5-5', effort: 'auto', effortSplit: true })
    // Normalização sozinha não vira escrita.
    syncConversations([conv])
    expect(db.syncConversations).not.toHaveBeenCalled()
    // Reabrir sem ter mexido: continua migrado (o registro ainda é o antigo).
    expect((await loadConversations())[0]).toMatchObject({ effort: 'auto' })
  })

  it('"Automático + Alto" escolhido depois sobrevive a reabrir: o marcador vai com a escrita', async () => {
    const db = fakeDb([legacyRecord()])
    const [conv] = await loadConversations()

    const escolhido: Conversation = { ...conv, effort: 'high' }
    syncConversations([escolhido])

    expect(db.syncConversations).toHaveBeenCalledTimes(1)
    expect(db.rows.get('c-legado')).toMatchObject({ payload: { model: 'auto', effort: 'high', effortSplit: true } })

    // Reabre (e de novo): a migração não reaplica.
    expect((await loadConversations())[0]).toMatchObject({ model: 'auto', effort: 'high' })
    expect((await loadConversations())[0]).toMatchObject({ model: 'auto', effort: 'high' })
  })

  it('conversa nova vai inteira para a fila; com o marcador, reabre sem reaplicar a migração', async () => {
    const db = fakeDb([])
    const nova = {
      id: 'c-nova',
      title: 'Nova conversa',
      cwd: 'C:\\GitHub\\proj',
      model: 'auto',
      effort: 'low',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as Conversation

    syncConversations([nova])

    expect(db.rows.get('c-nova')).toMatchObject({ payload: { model: 'auto', effort: 'low' } })
    // O main carimba o marcador ao preparar o documento (conversationPrepare.ts).
    db.rows.get('c-nova')!.payload.effortSplit = true
    expect((await loadConversations())[0]).toMatchObject({ model: 'auto', effort: 'low' })
  })
})
