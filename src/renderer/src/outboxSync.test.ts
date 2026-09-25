import { describe, expect, it } from 'vitest'
import { changedConversations, outboxItemsFor, restoreOutbox } from './outboxSync'

type Item = { id: string; convId: string; text: string }
const item = (id: string, convId: string, text = id): Item => ({ id, convId, text })
const isPayload = (v: unknown): v is { text: string } => !!v && typeof (v as { text?: unknown }).text === 'string'

describe('fila de espera persistente', () => {
  it('só regrava as conversas cuja fila mudou (inclusive a que esvaziou)', () => {
    const before = [item('q1', 'a'), item('q2', 'a'), item('q3', 'b')]
    expect(changedConversations(before, before)).toEqual([])
    expect(changedConversations(before, [item('q2', 'a'), item('q3', 'b')])).toEqual(['a'])
    expect(changedConversations(before, [item('q1', 'a'), item('q2', 'a')])).toEqual(['b'])
    expect(changedConversations(before, [item('q2', 'a'), item('q1', 'a'), item('q3', 'b')])).toEqual(['a'])
    expect(changedConversations([], [item('q9', 'c')])).toEqual(['c'])
  })

  it('grava a fila de uma conversa na ordem, sem o convId no payload, e restaura igual', () => {
    const queue = [item('q1', 'a', 'um'), item('q9', 'b'), item('q2', 'a', 'dois')]
    const saved = outboxItemsFor(queue, 'a')
    expect(saved).toEqual([
      { id: 'q1', payload: { text: 'um' } },
      { id: 'q2', payload: { text: 'dois' } }
    ])
    const restored = restoreOutbox<Item>(
      saved.map((s) => ({ conversationId: 'a', id: s.id, payload: s.payload })),
      isPayload
    )
    expect(restored).toEqual([item('q1', 'a', 'um'), item('q2', 'a', 'dois')])
  })

  it('descarta entrada malformada do banco', () => {
    const restored = restoreOutbox<Item>(
      [
        { conversationId: 'a', id: 'q1', payload: { text: 'ok' } },
        { conversationId: 'a', id: 'q2', payload: { nada: 1 } },
        { conversationId: 5 as unknown as string, id: 'q3', payload: { text: 'x' } }
      ],
      isPayload
    )
    expect(restored.map((r) => r.id)).toEqual(['q1'])
  })
})
