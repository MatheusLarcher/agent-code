import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationChangeDto } from '@shared/ipc'
import { loadConversationChanges, loadConversations, markConversationsDirty } from './storage'
import { resetConversationSync, syncConversations } from './conversationSync'
import { applyChanges } from './conversationSyncFake'

describe('conversation storage normalization', () => {
  beforeEach(() => {
    localStorage.clear()
    resetConversationSync()
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
    const sync = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadVersionedConversations, syncConversations: sync }
    })

    const loaded = await loadConversations()
    expect(loaded).toEqual([expect.objectContaining({
      id: 'legacy-partial',
      title: 'Sessão recuperada',
      cwd: '',
      model: 'claude-opus-5-5',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: Date.parse('2026-08-28T12:00:00.000Z'),
      updatedAt: Date.parse('2026-08-29T12:00:00.000Z')
    })])
    // Normalizar não é editar: o que veio do banco não volta para a fila.
    syncConversations(loaded)
    expect(sync).not.toHaveBeenCalled()
  })

  it('a conversa de planejamento volta do banco com mode e planningSlug', async () => {
    // Ida: o que a tela entrega à fila do main. Volta: o que o banco devolve na
    // próxima abertura. storage.ts não conhece os campos novos — eles passam por
    // serem parte do objeto.
    let saved: Array<Record<string, unknown> & { id: string }> = []
    const sync = vi.fn((changes: ConversationChangeDto[]) => {
      saved = applyChanges(saved, changes)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => []),
        syncConversations: sync,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const now = Date.now()
    syncConversations([
      {
        id: 'plan-roundtrip',
        title: 'Planejamento: Checkout',
        cwd: 'C:/proj',
        model: 'claude-sonnet-5-5',
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
        syncConversations: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const [loaded] = await loadConversations()
    expect(loaded).toMatchObject({
      id: 'plan-roundtrip',
      mode: 'planning',
      planningSlug: 'checkout',
      title: 'Planejamento: Checkout',
      model: 'claude-sonnet-5-5'
    })
  })
})

/** The reported bug: a message shows up and vanishes about a second later.
 * The change feed echoes back this installation's OWN writes, so a notification
 * that lands while newer local messages are still waiting for the debounced
 * write used to replace the conversation with the last persisted revision. */
describe('change feed never rolls the screen back', () => {
  // The feed's revision map is module state that survives between tests, so
  // each case uses its own conversation id.
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
        syncConversations: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId }))
      }
    })
    await loadConversations()
  }

  beforeEach(() => {
    localStorage.clear()
    resetConversationSync()
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
        syncConversations: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const updates = await loadConversationChanges([
      { changeId: '13', entity: 'conversation', entityId: 'remote', revision: 7, installationId: 'other-pc' }
    ])
    expect(updates.get('remote')).toEqual(expect.objectContaining({ title: 'Renomeado noutro PC' }))
  })

  it('what the feed brought from another installation is not handed back to the write queue', async () => {
    const sync = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [record('no-echo', 4)]),
        syncConversations: sync,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const screen = await loadConversations()
    syncConversations(screen)
    const api = window.api as unknown as { loadVersionedConversations: ReturnType<typeof vi.fn> }
    api.loadVersionedConversations.mockResolvedValue([record('no-echo', 5, 'Do outro PC')])
    const updates = await loadConversationChanges([
      { changeId: '14', entity: 'conversation', entityId: 'no-echo', revision: 5, installationId: 'other-pc' }
    ])
    syncConversations([updates.get('no-echo')!])
    expect(sync).not.toHaveBeenCalled()
  })

  it('a conversation deleted by another installation leaves the screen without becoming a delete from here', async () => {
    const sync = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations: vi.fn(async () => [record('gone', 4), record('stays', 4)]),
        syncConversations: sync,
        getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
      }
    })
    const screen = await loadConversations()
    syncConversations(screen)
    const api = window.api as unknown as { loadVersionedConversations: ReturnType<typeof vi.fn> }
    api.loadVersionedConversations.mockResolvedValue([{ ...record('gone', 5), deletedAt: '2026-09-02T12:00:00.000Z' }])
    const updates = await loadConversationChanges([
      { changeId: '15', entity: 'conversation', entityId: 'gone', revision: 5, installationId: 'other-pc' }
    ])
    expect(updates.get('gone')).toBeNull()
    syncConversations(screen.filter((conversation) => conversation.id !== 'gone'))
    expect(sync).not.toHaveBeenCalled()
  })
})
