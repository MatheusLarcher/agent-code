import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from './types'

const syncConversations = vi.fn()
vi.mock('./conversationSync', () => ({ syncConversations: (...args: unknown[]) => syncConversations(...args) }))

const { syncChangedConversations } = await import('./autosaveChanged')

const list = [{ id: 'c1' }, { id: 'c2' }] as Conversation[]

describe('syncChangedConversations', () => {
  beforeEach(() => {
    syncConversations.mockReset()
  })

  it('manda o acumulado como only, esvazia o conjunto e devolve o que a entrega tratou', () => {
    syncConversations.mockReturnValue({ processed: 1, sent: 1 })
    const pending = new Set(['c1'])
    expect(syncChangedConversations(pending, list)).toEqual({ processed: 1, sent: 1 })
    expect(syncConversations).toHaveBeenCalledWith(list, { only: new Set(['c1']) })
    expect(pending.size).toBe(0)
  })

  it('o que muda depois da entrega fica para o próximo tique', () => {
    syncConversations.mockReturnValue({ processed: 1, sent: 1 })
    const pending = new Set(['c1'])
    syncChangedConversations(pending, list)
    pending.add('c2')
    expect(syncConversations.mock.calls[0][1]).toEqual({ only: new Set(['c1']) })
    expect([...pending]).toEqual(['c2'])
  })
})
