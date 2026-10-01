import { describe, expect, it } from 'vitest'
import { stableRoomOrder } from './roomOrder'

describe('stableRoomOrder', () => {
  it('sem histórico, vale a ordem atual', () => {
    expect(stableRoomOrder([], ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('remover do meio deixa a vaga e não move as outras', () => {
    expect(stableRoomOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', '', 'c'])
  })
  it('sala nova entra no fim, sem ocupar a vaga do meio', () => {
    expect(stableRoomOrder(['a', '', 'c'], ['d', 'a', 'c'])).toEqual(['a', '', 'c', 'd'])
  })
  it('a ordem do current não reordena quem já existe', () => {
    expect(stableRoomOrder(['a', 'b'], ['b', 'a'])).toEqual(['a', 'b'])
  })
  it('vagas no fim somem', () => {
    expect(stableRoomOrder(['a', 'b', 'c'], ['a'])).toEqual(['a'])
    expect(stableRoomOrder(['a'], [])).toEqual([])
  })
})
