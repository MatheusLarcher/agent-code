import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { BoardItem } from '@shared/ipc'
import { item } from '../office3d/board/boardTestKit'
import { useBoardOpenRequest, type BoardOpenRequest } from './boardOpenCard'

/** O clique num item do resumo abre o cartão no painel do Quadro. */

function setup(initial: { request: BoardOpenRequest | null; items: BoardItem[]; wholeProject?: boolean }) {
  const open = vi.fn()
  const done = vi.fn()
  const setWholeProject = vi.fn()
  const view = renderHook(
    (p: { request: BoardOpenRequest | null; items: BoardItem[]; wholeProject: boolean }) =>
      useBoardOpenRequest({ request: p.request, items: p.items, conversationId: 'c1', wholeProject: p.wholeProject, setWholeProject, open, done }),
    { initialProps: { request: initial.request, items: initial.items, wholeProject: initial.wholeProject ?? false } }
  )
  return { view, open, done, setWholeProject }
}

describe('useBoardOpenRequest', () => {
  it('cartão já na lista: abre na hora e avisa que atendeu', () => {
    const a = item('a')
    const s = setup({ request: { id: 'a', conversationId: 'c1', seq: 1 }, items: [a] })
    expect(s.open).toHaveBeenCalledWith(a)
    expect(s.done).toHaveBeenCalledWith(1)
    expect(s.setWholeProject).not.toHaveBeenCalled()
  })

  it('cartão de outra conversa: passa a "Projeto inteiro" e abre quando a lista chega', () => {
    const s = setup({ request: { id: 'x', conversationId: 'c2', seq: 1 }, items: [item('a')] })
    expect(s.open).not.toHaveBeenCalled()
    expect(s.setWholeProject).toHaveBeenCalledWith(true)
    const x = item('x', { conversationId: 'c2' })
    s.view.rerender({ request: { id: 'x', conversationId: 'c2', seq: 1 }, items: [item('a'), x], wholeProject: true })
    expect(s.open).toHaveBeenCalledWith(x)
    expect(s.done).toHaveBeenCalledWith(1)
  })

  it('sem pedido, nada; o mesmo pedido não reabre a cada recarga da lista', () => {
    const a = item('a')
    const s = setup({ request: null, items: [a] })
    expect(s.open).not.toHaveBeenCalled()
    s.view.rerender({ request: { id: 'a', conversationId: 'c1', seq: 1 }, items: [a], wholeProject: false })
    s.view.rerender({ request: { id: 'a', conversationId: 'c1', seq: 1 }, items: [{ ...a, revision: 2 }], wholeProject: false })
    expect(s.open).toHaveBeenCalledTimes(1)
  })
})
