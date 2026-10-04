import { describe, expect, it } from 'vitest'
import { boardCard, boardSnap, BoardStepQueue, diffBoard, NEUTRAL_TEXT, stepsFor, type BoardSnap } from './boardModel'
import { at, event, item } from './boardTestKit'

const snap = (...items: ReturnType<typeof item>[]): BoardSnap => boardSnap({ available: true, items })

describe('retrato do quadro (boardModel)', () => {
  it('status e título EFETIVOS (a correção do PO aparece igual à tela), selo de aguardando e dispensados fora', () => {
    const s = boardSnap({
      available: true,
      items: [
        item('a', { poTitle: 'Título do PO', poStatus: 'completed', poReason: 'conferido' }),
        item('b', { poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa' }),
        item('c', { dismissedAt: at(1) })
      ]
    })
    expect(s.cards.map((c) => [c.id, c.status, c.title, c.awaiting])).toEqual([
      ['a', 'completed', 'Título do PO', null],
      ['b', 'pending', 'Tarefa b', 'result']
    ])
    expect(boardSnap({ available: false, items: [item('x')] })).toEqual({ available: false, cards: [] })
  })

  it('diff: novo, mudou de coluna, renomeado, justificado, saiu e voltou', () => {
    const prev = snap(item('a'), item('b'), item('c'), item('d'))
    const next = snap(
      item('a', { sourceStatus: 'in_progress', revision: 2 }),
      item('b', { poTitle: 'Outro nome', revision: 2 }),
      item('c', { revision: 3, poReason: 'motivo novo' }),
      item('e'),
      item('f')
    )
    const changes = diffBoard(prev, next, new Set(['f']))
    expect(changes.map((c) => [c.card.id, c.kind])).toEqual([
      ['a', 'moved'],
      ['b', 'renamed'],
      ['c', 'justified'],
      ['e', 'new'],
      ['f', 'restored'],
      ['d', 'removed']
    ])
    expect(diffBoard(prev, prev)).toEqual([])
  })

  it('passos: um por evento novo, na ordem real, com autor e nota; o que já foi visto não volta', () => {
    const card = boardCard(item('a', { sourceStatus: 'completed', updatedAt: at(9) }))
    const events = [
      event('a', at(8), { actor: 'po', toStatus: 'completed', note: 'conferi os testes' }),
      event('a', at(1), { kind: 'created', actor: 'agent', toStatus: 'pending' }),
      event('a', at(5), { actor: 'user', toStatus: 'in_progress' })
    ]
    const steps = stepsFor('r1', { kind: 'moved', card, prev: null }, events, at(2))
    expect(steps.map((s) => [s.kind, s.actor, s.text, s.toStatus])).toEqual([
      ['moved', 'user', 'mudou para fazendo', 'in_progress'],
      ['moved', 'po', 'conferi os testes', 'completed']
    ])
    expect(steps[0]).toMatchObject({ roomId: 'r1', cardId: 'a', convId: 'c1', title: 'Tarefa a' })
  })

  it('cartão que sumiu do plano sem evento é do agente; leitura que falhou sai sem autor e neutra', () => {
    const card = boardCard(item('a'))
    const gone = stepsFor('r1', { kind: 'removed', card, prev: card }, [], at(0))
    expect(gone).toEqual([expect.objectContaining({ kind: 'removed', actor: 'agent', toStatus: null })])
    const failed = stepsFor('r1', { kind: 'moved', card, prev: card }, null, at(0))
    expect(failed).toEqual([expect.objectContaining({ kind: 'moved', actor: null, text: NEUTRAL_TEXT })])
    const dismissed = stepsFor('r1', { kind: 'removed', card, prev: card }, [event('a', at(3), { kind: 'dismissed', actor: 'user' })], at(0))
    expect(dismissed).toEqual([expect.objectContaining({ kind: 'removed', actor: 'user', text: 'tirou do quadro' })])
  })

  it('a fila entrega na ordem e esvazia ao drenar', () => {
    const q = new BoardStepQueue()
    let pushes = 0
    q.onPush = () => pushes++
    const card = boardCard(item('a'))
    q.push(stepsFor('r', { kind: 'new', card, prev: null }, null, null))
    q.push([])
    expect([q.size, pushes]).toEqual([1, 1])
    expect(q.drain().map((s) => s.cardId)).toEqual(['a'])
    expect(q.size).toBe(0)
  })
})
