import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadConversationChanges,
  loadConversations,
  markConversationsDirty,
  saveConversations
} from './storage'

describe('conversation storage normalization', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps history available when a legacy PostgreSQL payload lacks renderer fields', async () => {
    const loadVersionedConversations = vi.fn(async () => [{
      id: 'legacy-partial',
      payload: { id: 'wrong-id', title: 'Sessão recuperada' },
      revision: 1,
      contentHash: 'hash',
      createdAt: '2026-08-28T12:00:00.000Z',
      updatedAt: '2026-08-29T12:00:00.000Z'
    }])
    const upsertConversation = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadVersionedConversations, upsertConversation }
    })

    const loaded = await loadConversations()
    expect(loaded).toEqual([expect.objectContaining({
      id: 'legacy-partial',
      title: 'Sessão recuperada',
      cwd: '',
      model: 'claude-opus-5',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: Date.parse('2026-08-28T12:00:00.000Z'),
      updatedAt: Date.parse('2026-08-29T12:00:00.000Z')
    })])
    await saveConversations(loaded)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('a conversa de planejamento volta do banco com mode e planningSlug', async () => {
    // Ida: o que o renderer grava. Volta: o que o banco devolve na próxima
    // abertura. storage.ts não conhece os campos novos — eles passam por serem
    // parte do objeto.
    const saved: Record<string, unknown>[] = []
    const upsertConversation = vi.fn(async (input: { id: string; payload: Record<string, unknown> }) => {
      saved.push(input.payload)
      return {
        id: input.id,
        payload: input.payload,
        revision: 1,
        contentHash: 'hash',
        createdAt: '2026-09-22T12:00:00.000Z',
        updatedAt: '2026-09-22T12:00:00.000Z'
      }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => []),
        upsertConversation,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    // Zera o cache de revisões do módulo (sobra de outros testes): senão o save
    // tentaria apagar as conversas que eles carregaram.
    await loadConversations()
    const now = Date.now()
    await saveConversations([
      {
        id: 'plan-roundtrip',
        title: 'Planejamento: Checkout',
        cwd: 'C:/proj',
        model: 'claude-sonnet-5',
        mode: 'planning',
        planningSlug: 'checkout',
        sdkSessionId: null,
        messages: [],
        tokens: { context: 0, output: 0, cost: 0 },
        createdAt: now,
        updatedAt: now
      }
    ])
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ mode: 'planning', planningSlug: 'checkout' })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [
          {
            id: 'plan-roundtrip',
            payload: saved[0],
            revision: 1,
            contentHash: 'hash',
            createdAt: '2026-09-22T12:00:00.000Z',
            updatedAt: '2026-09-22T12:00:00.000Z'
          }
        ]),
        upsertConversation: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const [loaded] = await loadConversations()
    expect(loaded).toMatchObject({
      id: 'plan-roundtrip',
      mode: 'planning',
      planningSlug: 'checkout',
      title: 'Planejamento: Checkout',
      model: 'claude-sonnet-5'
    })
  })
})

/** The reported bug: a message shows up and vanishes about a second later.
 * The change feed echoes back this installation's OWN writes, so a notification
 * that lands while newer local messages are still waiting for the debounced
 * write used to replace the conversation with the last persisted revision. */
describe('change feed never rolls the screen back', () => {
  // `dirtyConversationIds` and `conversationRecords` are module state that
  // survives between tests, so each case uses its own conversation id.
  function record(id: string, revision: number, title = 'Chat'): Record<string, unknown> {
    return {
      id,
      payload: { id, title, messages: [{ kind: 'user', id: 'm1', text: 'primeira' }] },
      revision,
      contentHash: 'hash',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z'
    }
  }

  async function seed(stored: Record<string, unknown>, installationId = 'this-pc'): Promise<void> {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [stored]),
        upsertConversation: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId }))
      }
    })
    await loadConversations()
  }

  beforeEach(() => {
    localStorage.clear()
  })

  it('ignores the echo of a write made by this installation', async () => {
    await seed(record('echo', 4))
    const updates = await loadConversationChanges([
      { changeId: '10', entity: 'conversation', entityId: 'echo', revision: 5, installationId: 'this-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('does not overwrite a conversation still waiting for its debounced write', async () => {
    await seed(record('pending', 4))
    markConversationsDirty(['pending'])
    const updates = await loadConversationChanges([
      { changeId: '11', entity: 'conversation', entityId: 'pending', revision: 9, installationId: 'other-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('skips a revision already held locally', async () => {
    await seed(record('same-rev', 4))
    const updates = await loadConversationChanges([
      { changeId: '12', entity: 'conversation', entityId: 'same-rev', revision: 4, installationId: 'other-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('still applies a genuinely newer change from another installation', async () => {
    await seed(record('remote', 4))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [record('remote', 7, 'Renomeado noutro PC')]),
        upsertConversation: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const updates = await loadConversationChanges([
      { changeId: '13', entity: 'conversation', entityId: 'remote', revision: 7, installationId: 'other-pc' }
    ])
    expect(updates.get('remote')).toEqual(expect.objectContaining({ title: 'Renomeado noutro PC' }))
  })
})

/** "Não consegue gravar porque tem outra escrita ativa" — the CAS lost a race
 * once and the stale cached revision then wedged EVERY later write of that
 * conversation, so the error kept coming back. */
describe('revision conflict rebases instead of surfacing an error', () => {
  const conflict = (): Error => {
    const error = new Error('[agent-code-storage-error:REVISION_CONFLICT:fatal] A conversa foi alterada por outra gravação.')
    error.name = 'StorageError'
    return error
  }

  function stored(id: string, revision: number): Record<string, unknown> {
    return {
      id,
      payload: { id, title: 'Chat', messages: [] },
      revision,
      contentHash: 'hash',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z'
    }
  }

  beforeEach(() => {
    localStorage.clear()
  })

  it('retries the write against the authoritative revision', async () => {
    const upsertConversation = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockImplementationOnce(async () => stored('rebase', 12))
    // The first load seeds revision 3; after the conflict the row is at 11.
    const loadVersionedConversations = vi.fn()
      .mockImplementationOnce(async () => [stored('rebase', 3)])
      .mockImplementationOnce(async () => [stored('rebase', 11)])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadVersionedConversations, upsertConversation, getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' })) }
    })

    const [conversation] = await loadConversations()
    await saveConversations([{ ...conversation, title: 'Editado' }])

    expect(upsertConversation).toHaveBeenCalledTimes(2)
    expect(upsertConversation.mock.calls[0][0].expectedRevision).toBe(3)
    expect(upsertConversation.mock.calls[1][0].expectedRevision).toBe(11)
  })

  it('does not wedge the next write after a conflict', async () => {
    const upsertConversation = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockImplementationOnce(async () => stored('wedge', 12))
      .mockImplementationOnce(async () => stored('wedge', 13))
    const loadVersionedConversations = vi.fn()
      .mockImplementationOnce(async () => [stored('wedge', 3)])
      .mockImplementationOnce(async () => [stored('wedge', 11)])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadVersionedConversations, upsertConversation, getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' })) }
    })

    const [conversation] = await loadConversations()
    await saveConversations([{ ...conversation, title: 'Primeira' }])
    // The cached revision must now be the one the successful write returned.
    await expect(saveConversations([{ ...conversation, title: 'Segunda' }])).resolves.toBeUndefined()
    expect(upsertConversation).toHaveBeenCalledTimes(3)
    expect(upsertConversation.mock.calls[2][0].expectedRevision).toBe(12)
  })

  it('uma conversa já gravada não é reescrita de novo só porque o JSONB reordenou as chaves', async () => {
    // O PostgreSQL guarda o payload em `jsonb`, que NÃO preserva ordem de chave:
    // devolve na ordem interna dele (comprimento, depois bytes), inclusive nos
    // objetos aninhados. A resposta do upsert é o que vira a baseline do próximo
    // "isso mudou?" — então, sem uma comparação estável, a conversa ficava suja
    // para sempre e era reescrita a cada tick de autosave. Foi o que encheu o
    // servidor de 200 mil updates numa tabela de 52 linhas.
    const jsonbOrder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(jsonbOrder)
      if (value === null || typeof value !== 'object') return value
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      const keys = Object.keys(source).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0))
      for (const key of keys) out[key] = jsonbOrder(source[key])
      return out
    }

    const upsertConversation = vi.fn(async (input: { payload: Record<string, unknown> }) => ({
      id: 'jsonb',
      payload: jsonbOrder(input.payload) as Record<string, unknown>,
      revision: 4,
      contentHash: 'hash',
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z'
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [stored('jsonb', 3)]),
        upsertConversation,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })

    const [conversation] = await loadConversations()
    const editada = { ...conversation, title: 'Editado' }
    await saveConversations([editada])
    expect(upsertConversation).toHaveBeenCalledTimes(1)

    // Nada mudou desde a gravação: o tick seguinte não pode escrever nada.
    await saveConversations([editada])
    await saveConversations([editada])
    expect(upsertConversation).toHaveBeenCalledTimes(1)
  })

  it('propagates a failure that is not a revision conflict', async () => {
    const upsertConversation = vi.fn().mockRejectedValue(new Error('[agent-code-storage-error:STORAGE_OFFLINE:retryable] offline'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [stored('offline', 3)]),
        upsertConversation,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })

    const [conversation] = await loadConversations()
    await expect(saveConversations([{ ...conversation, title: 'Editado' }])).rejects.toThrow(/offline/)
    expect(upsertConversation).toHaveBeenCalledTimes(1)
  })
})
