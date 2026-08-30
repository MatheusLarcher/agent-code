import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConversations, saveConversations } from './storage'

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
