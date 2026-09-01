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
})

/** The reported bug: a message shows up and vanishes about a second later.
 * The change feed echoes back this installation's OWN writes, so a notification
 * that lands while newer local messages are still waiting for the debounced
 * write used to replace the conversation with the last persisted revision. */
describe('change feed never rolls the screen back', () => {
  const stored = {
    id: 'conv-1',
    payload: { id: 'conv-1', title: 'Chat', messages: [{ kind: 'user', id: 'm1', text: 'primeira' }] },
    revision: 4,
    contentHash: 'hash',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z'
  }

  function installApi(installationId = 'this-pc'): { loadVersionedConversations: ReturnType<typeof vi.fn> } {
    const loadVersionedConversations = vi.fn(async () => [stored])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadVersionedConversations,
        upsertConversation: vi.fn(),
        getStorageStatus: vi.fn(async () => ({ installationId }))
      }
    })
    return { loadVersionedConversations }
  }

  beforeEach(async () => {
    localStorage.clear()
    installApi()
    await loadConversations()
  })

  it('ignores the echo of a write made by this installation', async () => {
    const updates = await loadConversationChanges([
      { changeId: '10', entity: 'conversation', entityId: 'conv-1', revision: 5, installationId: 'this-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('does not overwrite a conversation still waiting for its debounced write', async () => {
    markConversationsDirty(['conv-1'])
    const updates = await loadConversationChanges([
      { changeId: '11', entity: 'conversation', entityId: 'conv-1', revision: 9, installationId: 'other-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('skips a revision already held locally', async () => {
    const updates = await loadConversationChanges([
      { changeId: '12', entity: 'conversation', entityId: 'conv-1', revision: 4, installationId: 'other-pc' }
    ])
    expect(updates.size).toBe(0)
  })

  it('still applies a genuinely newer change from another installation', async () => {
    stored.revision = 7
    stored.payload = { ...stored.payload, title: 'Renomeado noutro PC' }
    const updates = await loadConversationChanges([
      { changeId: '13', entity: 'conversation', entityId: 'conv-1', revision: 7, installationId: 'other-pc' }
    ])
    expect(updates.get('conv-1')).toEqual(expect.objectContaining({ title: 'Renomeado noutro PC' }))
  })
})
