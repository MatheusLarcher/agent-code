import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BoardItem } from '@shared/ipc'
import { BoardMirror } from './boardMirror'
import { boardSnap } from './boardModel'
import { BoardOverlay } from './BoardOverlay'
import { at, event, item } from './boardTestKit'
import type { EngineBoard } from './engineBoard'

function fakeBoard(items: BoardItem[]) {
  const state = { items }
  const mirror = new BoardMirror()
  mirror.setTarget(boardSnap({ available: true, items }), 0, true)
  const board = {
    sync: {
      item: (id: string) => state.items.find((i) => i.id === id),
      mirror: () => mirror,
      // A janela lê e dispensa pela fonte do quadro da sala (aqui, o window.api falso).
      events: (id: string) => api.boardItemEvents(id),
      dismiss: async (id: string, dismissed: boolean) => void (await api.boardDismiss(id, dismissed))
    },
    title: (convId: string) => (convId === 'c1' ? 'Conversa do quadro' : null)
  } as unknown as EngineBoard
  return { board, state, mirror }
}

const api = {
  boardItemEvents: vi.fn(async (id: string) => [event(id, at(1), { kind: 'created', actor: 'agent', toStatus: 'pending' }), event(id, at(2), { actor: 'po', toStatus: 'completed', note: 'conferi os testes' })]),
  boardDismiss: vi.fn(async (_id: string, _dismissed: boolean) => null)
}

beforeEach(() => {
  api.boardItemEvents.mockClear()
  api.boardDismiss.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('janela do kanban (BoardOverlay)', () => {
  it('cartão grande: o mesmo detalhe da aba Quadro, com a linha do tempo (autor e motivo)', async () => {
    const { board } = fakeBoard([item('a', { poTitle: 'Título do PO', poStatus: 'completed', poReason: 'conferi os testes' })])
    render(<BoardOverlay open={{ kind: 'card', id: 'a', x: 10, y: 10 }} board={board} onClose={vi.fn()} onOpen={vi.fn()} onOpenConversation={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Cartão do quadro' })).toBeTruthy()
    expect(screen.getByText('Título do PO')).toBeTruthy()
    expect(screen.getByText('Conversa do quadro')).toBeTruthy()
    expect(screen.getByLabelText('Motivo atual').textContent).toContain('conferi os testes')
    await waitFor(() => expect(screen.getByText('PO')).toBeTruthy())
    expect(screen.getByText(/mudou para concluído/)).toBeTruthy()
    expect(api.boardItemEvents).toHaveBeenCalledWith('a')
  })

  it('Esc fecha só a janela (na captura: quem ouve a janela depois não recebe); clique fora fecha', () => {
    const { board } = fakeBoard([item('a')])
    const onClose = vi.fn()
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    render(<BoardOverlay open={{ kind: 'card', id: 'a', x: null, y: null }} board={board} onClose={onClose} onOpen={vi.fn()} onOpenConversation={vi.fn()} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
    window.removeEventListener('keydown', behind)
    fireEvent.pointerDown(screen.getByTestId('o3d-board-overlay'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('acompanha a revisão (relê a linha do tempo) e fecha quando o cartão sai do quadro', async () => {
    const f = fakeBoard([item('a')])
    const onClose = vi.fn()
    const props = { board: f.board, onClose, onOpen: vi.fn(), onOpenConversation: vi.fn() }
    const view = render(<BoardOverlay open={{ kind: 'card', id: 'a', x: null, y: null }} {...props} />)
    await waitFor(() => expect(api.boardItemEvents).toHaveBeenCalledTimes(1))
    f.state.items = [item('a', { poTitle: 'Renomeado', revision: 2 })]
    view.rerender(<BoardOverlay open={{ kind: 'card', id: 'a', x: null, y: null }} {...props} />)
    expect(screen.getByText('Renomeado')).toBeTruthy()
    await waitFor(() => expect(api.boardItemEvents).toHaveBeenCalledTimes(2))
    f.state.items = []
    view.rerender(<BoardOverlay open={{ kind: 'card', id: 'a', x: null, y: null }} {...props} />)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('o3d-board-overlay')).toBeNull()
  })

  it('dispensar e abrir a conversa (que fecha a janela)', async () => {
    const { board } = fakeBoard([item('a')])
    const onClose = vi.fn()
    const onOpenConversation = vi.fn()
    render(<BoardOverlay open={{ kind: 'card', id: 'a', x: null, y: null }} board={board} onClose={onClose} onOpen={vi.fn()} onOpenConversation={onOpenConversation} />)
    fireEvent.click(screen.getByText('Conversa do quadro'))
    expect(onOpenConversation).toHaveBeenCalledWith('c1')
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByText('Dispensar cartão'))
    })
    expect(api.boardDismiss).toHaveBeenCalledWith('a', true)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('pilha: a lista inteira da coluna, na ordem do Quadro; clicar abre o cartão grande', () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`p${i}`, { updatedAt: at(9 - i), ...(i === 2 ? { poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa' } : {}) }))
    const { board } = fakeBoard([...items, item('d', { sourceStatus: 'completed' })])
    const onOpen = vi.fn()
    render(<BoardOverlay open={{ kind: 'pile', roomId: 'r', status: 'pending', x: null, y: null }} board={board} onClose={vi.fn()} onOpen={onOpen} onOpenConversation={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Coluna A fazer' })).toBeTruthy()
    const rows = screen.getAllByRole('button').filter((b) => b.classList.contains('board-row'))
    expect(rows.map((r) => r.querySelector('.board-row-title')?.textContent)).toEqual(items.map((i) => i.sourceTitle))
    expect(screen.getByText('Aguardando você')).toBeTruthy()
    fireEvent.click(rows[3])
    expect(onOpen).toHaveBeenCalledWith({ kind: 'card', id: 'p3', x: null, y: null })
  })
})
