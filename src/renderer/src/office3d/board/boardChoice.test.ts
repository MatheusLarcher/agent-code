import { describe, expect, it } from 'vitest'
import { BoardChoice } from './boardChoice'

const IDS = ['a', 'b', 'c']

describe('qual projeto o kanban mostra (boardChoice)', () => {
  it('sem filtro: o da conversa ativa; sem ela, o que já estava; senão o primeiro', () => {
    const c = new BoardChoice()
    expect(c.pick(IDS)).toBe('a')
    c.setActive('conv-b', 'b')
    expect(c.pick(IDS)).toBe('b')
    // Conversa ativa sem quadro (ex.: a Central): fica o que estava.
    c.setActive('central', null)
    expect(c.pick(IDS)).toBe('b')
    expect(c.pick([])).toBeNull()
  })

  it('a aba vale até a conversa ativa mudar', () => {
    const c = new BoardChoice()
    c.setActive('conv-a', 'a')
    c.choose('c')
    expect(c.pick(IDS)).toBe('c')
    c.setActive('conv-a', 'a')
    expect(c.pick(IDS)).toBe('c')
    c.setActive('conv-b', 'b')
    expect(c.pick(IDS)).toBe('b')
  })

  it('com filtro: o filtrado (a aba e a conversa ativa não tiram); visita só do filtrado', () => {
    const c = new BoardChoice()
    c.setActive('conv-a', 'a')
    c.filter = 'c'
    c.choose('b')
    expect(c.pick(IDS)).toBe('c')
    expect(c.canVisit('a')).toBe(false)
    expect(c.canVisit('c')).toBe(true)
    c.filter = null
    expect(c.pick(IDS)).toBe('b')
  })

  it('a visita da coreografia mostra o projeto dela e, ao acabar, volta à escolha de antes', () => {
    const c = new BoardChoice()
    c.setActive('conv-a', 'a')
    expect(c.pick(IDS)).toBe('a')
    c.visit = 'c'
    expect(c.pick(IDS)).toBe('c')
    c.visit = null
    expect(c.pick(IDS)).toBe('a')
  })
})
