import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from './types'

const saveConversations = vi.fn()
vi.mock('./storage', () => ({ saveConversations: (...args: unknown[]) => saveConversations(...args) }))

const { saveChangedConversations } = await import('./autosaveChanged')

const list = [{ id: 'c1' }, { id: 'c2' }] as Conversation[]

describe('saveChangedConversations', () => {
  beforeEach(() => {
    saveConversations.mockReset()
  })

  it('manda o acumulado como only, esvazia o conjunto e devolve o que o salvamento tratou', async () => {
    saveConversations.mockResolvedValue({ processed: 1, bytes: 42 })
    const pending = new Set(['c1'])
    await expect(saveChangedConversations(pending, list)).resolves.toEqual({ processed: 1, bytes: 42 })
    expect(saveConversations).toHaveBeenCalledWith(list, { only: new Set(['c1']) })
    expect(pending.size).toBe(0)
  })

  it('o que muda durante a gravação fica para o próximo tique, sem entrar no only em curso', async () => {
    let finish!: (value: unknown) => void
    saveConversations.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const pending = new Set(['c1'])
    const saving = saveChangedConversations(pending, list)
    pending.add('c2')
    finish({ processed: 1, bytes: 1 })
    await saving
    expect(saveConversations.mock.calls[0][1]).toEqual({ only: new Set(['c1']) })
    expect([...pending]).toEqual(['c2'])
  })

  it('falha devolve os ids ao conjunto e propaga o erro', async () => {
    saveConversations.mockImplementation(async () => {
      throw new Error('offline')
    })
    const pending = new Set(['c1'])
    const saving = saveChangedConversations(pending, list)
    pending.add('c2')
    await expect(saving).rejects.toThrow('offline')
    expect([...pending].sort()).toEqual(['c1', 'c2'])
  })
})
