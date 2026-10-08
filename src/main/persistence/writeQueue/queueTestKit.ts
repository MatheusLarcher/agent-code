import { StorageError, type ConversationRecord, type PersistenceRepository, type PreparedConversationWrite, type VersionedConversation } from '../types'

/** Só para testes da fila: banco de mentira, documentos e mudanças. */

export interface Row {
  payload: ConversationRecord
  revision: number
  contentHash: string
  deletedAt?: string
}

/** Banco de mentira com a regra de revisão do PostgreSQL. `afterLoad`: o que roda
 *  logo depois de cada leitura (um por leitura) — outro PC gravando no meio. */
export function fakeRepository() {
  const rows = new Map<string, Row>()
  const state = {
    online: true,
    delayMs: 0,
    writes: 0,
    inFlight: 0,
    maxInFlight: 0,
    failNext: null as Error | null,
    afterLoad: [] as Array<() => void>
  }
  const assertRevision = (expected: number | undefined, row: Row | undefined, id: string): void => {
    if (!row) {
      if (expected !== undefined && expected !== 0) throw new StorageError('REVISION_CONFLICT', `${id} não existe.`)
      return
    }
    if (expected === undefined || expected !== row.revision) throw new StorageError('REVISION_CONFLICT', `${id} mudou.`)
  }
  const repository = {
    conversationHashScope: 'shared' as const,
    async writeConversation(write: PreparedConversationWrite) {
      if (!state.online) throw new StorageError('CONNECTION_REFUSED', 'fora do ar', true)
      if (state.failNext) {
        const error = state.failNext
        state.failNext = null
        throw error
      }
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
        const row = rows.get(write.id)
        assertRevision(write.expectedRevision, row, write.id)
        // Como o PostgreSQL: o mesmo conteúdo só regrava o estado do dispositivo.
        if (row && row.contentHash === write.prepared.contentHash && !row.deletedAt) {
          return { id: write.id, revision: row.revision, contentHash: row.contentHash, createdAt: 'c', updatedAt: 'u' }
        }
        state.writes += 1
        const next = { payload: JSON.parse(write.prepared.payloadJson) as ConversationRecord, revision: (row?.revision ?? 0) + 1, contentHash: write.prepared.contentHash }
        rows.set(write.id, next)
        return { id: write.id, revision: next.revision, contentHash: next.contentHash, createdAt: 'c', updatedAt: 'u' }
      } finally {
        state.inFlight -= 1
      }
    },
    async deleteConversation(input: { id: string; expectedRevision: number }) {
      if (!state.online) throw new StorageError('CONNECTION_REFUSED', 'fora do ar', true)
      const row = rows.get(input.id)
      if (!row) throw new StorageError('REVISION_CONFLICT', 'não existe')
      assertRevision(input.expectedRevision, row, input.id)
      const next = { ...row, revision: row.revision + 1, deletedAt: 'd' }
      rows.set(input.id, next)
      return { id: input.id, payload: next.payload, revision: next.revision, contentHash: next.contentHash, createdAt: 'c', updatedAt: 'u', deletedAt: 'd' }
    },
    async loadConversations(query?: { ids?: string[] }): Promise<VersionedConversation[]> {
      if (!state.online) throw new StorageError('CONNECTION_REFUSED', 'fora do ar', true)
      const found = [...rows.entries()]
        .filter(([id]) => !query?.ids || query.ids.includes(id))
        .map(([id, row]) => versioned(id, row))
      state.afterLoad.shift()?.()
      return found
    }
  }
  /** Outro writer grava a linha (a revisão anda). */
  const put = (id: string, payload: ConversationRecord): void => {
    const row = rows.get(id)
    rows.set(id, { payload: JSON.parse(JSON.stringify(payload)) as ConversationRecord, revision: (row?.revision ?? 0) + 1, contentHash: `outro-${(row?.revision ?? 0) + 1}` })
  }
  return { rows, state, put, repository: repository as unknown as PersistenceRepository }
}

export function versioned(id: string, row: Row): VersionedConversation {
  return {
    id,
    payload: JSON.parse(JSON.stringify(row.payload)) as ConversationRecord,
    revision: row.revision,
    contentHash: row.contentHash,
    createdAt: 'c',
    updatedAt: 'u',
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {})
  }
}

export const CREATED_AT = Date.parse('2026-10-08T00:00:00Z')

export const conversation = (id: string, messages: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: 'Teste',
  cwd: '',
  createdAt: CREATED_AT,
  updatedAt: 1,
  messages: messages.map((text, i) => ({ kind: 'user', id: `m${i}`, text })),
  ...extra
})

/** A conversa inteira como a tela entrega na 1ª vez. */
export const full = (doc: Record<string, unknown>, urgent = false) => {
  const { messages, ...top } = doc
  return { id: String(doc.id), top, messagesFrom: 0, messages: messages as unknown[], messageCount: (messages as unknown[]).length, ...(urgent ? { urgent } : {}) }
}
