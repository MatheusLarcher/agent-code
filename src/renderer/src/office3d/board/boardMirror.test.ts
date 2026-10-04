import { describe, expect, it } from 'vitest'
import { BoardMirror, MAX_LAG_MS } from './boardMirror'
import { boardSnap } from './boardModel'
import { item } from './boardTestKit'

const snap = (...items: ReturnType<typeof item>[]) => boardSnap({ available: true, items })
const wall = (m: BoardMirror): string[] => m.shown.map((c) => `${c.id}:${c.status}`)

describe('BoardMirror (parede × real)', () => {
  it('1ª leitura vai direto (sem replay); depois a parede só anda com o passo do cartão', () => {
    const m = new BoardMirror()
    expect([m.loaded, m.available]).toEqual([false, null])
    m.setTarget(snap(item('a'), item('b')), 0)
    expect(wall(m)).toEqual(['a:pending', 'b:pending'])
    m.setTarget(snap(item('b', { sourceStatus: 'in_progress', revision: 2 }), item('a'), item('c')), 1000)
    expect(wall(m)).toEqual(['a:pending', 'b:pending'])
    expect(m.pending).toBe(2)
    m.applyCard('b')
    expect(wall(m)).toEqual(['b:in_progress', 'a:pending'])
    m.applyCard('c')
    expect(wall(m)).toEqual(['b:in_progress', 'a:pending', 'c:pending'])
    expect(m.pending).toBe(0)
  })

  it('quem saiu do real espera o passo no lugar e some quando ele chega', () => {
    const m = new BoardMirror()
    m.setTarget(snap(item('a'), item('b'), item('c')), 0)
    m.setTarget(snap(item('a'), item('c')), 10)
    expect(wall(m)).toEqual(['a:pending', 'b:pending', 'c:pending'])
    m.applyCard('b')
    expect(wall(m)).toEqual(['a:pending', 'c:pending'])
  })

  it('indisponível mostra nada (nunca papel falso) e é diferente de vazio', () => {
    const m = new BoardMirror()
    m.setTarget(snap(item('a')), 0)
    m.setTarget({ available: false, cards: [] }, 5)
    expect([m.available, m.shown.length]).toEqual([false, 0])
    m.setTarget(snap(), 9)
    expect([m.available, m.shown.length]).toEqual([true, 0])
  })

  it(`nunca mais que ${MAX_LAG_MS} ms atrás do real: overdue devolve os atrasados`, () => {
    const m = new BoardMirror()
    m.setTarget(snap(item('a')), 0)
    m.setTarget(snap(item('a', { sourceStatus: 'completed', revision: 2 })), 1000)
    expect(m.overdue(1000 + MAX_LAG_MS - 1)).toEqual([])
    expect(m.overdue(1000 + MAX_LAG_MS)).toEqual(['a'])
  })

  it('arrasto do usuário: otimista no topo da coluna; o retrato que confirma não move o papel (não reanima)', () => {
    const m = new BoardMirror()
    m.setTarget(snap(item('x', { sourceStatus: 'in_progress' }), item('a'), item('b')), 0)
    expect(m.userMove('b', 'in_progress')).toBe(true)
    expect(m.userMove('b', 'in_progress')).toBe(false)
    expect(wall(m)).toEqual(['b:in_progress', 'x:in_progress', 'a:pending'])
    // Retrato velho chegando no meio do arrasto: o papel fica onde o usuário soltou.
    m.setTarget(snap(item('x', { sourceStatus: 'in_progress' }), item('a'), item('b')), 100)
    expect(wall(m)).toEqual(['b:in_progress', 'x:in_progress', 'a:pending'])
    m.endUserMove('b', true, 200)
    // O main confirma: o b é o mais recente da coluna (topo) — o mesmo lugar.
    const before = wall(m)
    m.setTarget(snap(item('b', { poStatus: 'in_progress', revision: 2, updatedAt: '2026-10-03T11:00:00.000Z' }), item('x', { sourceStatus: 'in_progress' }), item('a')), 300)
    m.applyCard('b')
    expect(wall(m)).toEqual(before)
    expect(m.pending).toBe(0)
  })

  it('arrasto recusado: o papel volta para a coluna real', () => {
    const m = new BoardMirror()
    m.setTarget(snap(item('a'), item('b')), 0)
    m.userMove('a', 'completed')
    expect(m.moving('a')).toBe(true)
    m.endUserMove('a', false, 50)
    expect(wall(m)).toEqual(['a:pending', 'b:pending'])
    expect(m.moving('a')).toBe(false)
  })
})
