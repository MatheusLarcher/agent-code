import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BoardItem } from '@shared/ipc'
import type { BoardPrintMeta } from '@shared/boardPrints'
import { BoardPanel } from './BoardPanel'
import { CardPrints, PrintBadge, type PrintsApi } from './BoardPrints'

/**
 * Os prints da tarefa visual na tela: o 📷 com o número no cartão, as
 * miniaturas no detalhe e o print grande no clique (legenda e horário).
 */

const THUMB = 'data:image/jpeg;base64,AAAA'

function meta(id: string, boardItemId: string, over: Partial<BoardPrintMeta> = {}): BoardPrintMeta {
  return { id, boardItemId, legenda: `legenda ${id}`, createdAt: '2026-10-07T12:00:00.000Z', width: 1600, height: 900, thumbUrl: THUMB, ...over }
}

function fakeApi(prints: BoardPrintMeta[]): PrintsApi & { boardPrintImage: ReturnType<typeof vi.fn> } {
  return {
    boardPrints: vi.fn(async (q: { projectCwd?: string; boardItemId?: string }) => ({
      available: true,
      prints: q.boardItemId ? prints.filter((p) => p.boardItemId === q.boardItemId) : prints
    })),
    boardPrintImage: vi.fn(async (id: string) => ({ ok: true as const, id, url: 'data:image/jpeg;base64,GRANDE', legenda: `legenda ${id}`, createdAt: '2026-10-07T12:00:00.000Z', width: 1600, height: 900 })),
    onBoardChanged: vi.fn(() => () => undefined)
  }
}

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'a', projectId: 'p1', projectCwd: 'C:/proj', conversationId: 'conv-1', origin: 'agent', sourceId: 't1',
    sourceTitle: 'Tela de login', sourceStatus: 'completed', activeForm: null, seq: 1, poTitle: null, poNote: null,
    poStatus: null, poReason: null, poAt: null, dismissedAt: null, revision: 1,
    createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T11:00:00.000Z', ...over
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('PrintBadge', () => {
  it('📷 com o número; sem print, nada', () => {
    const { container, rerender } = render(<PrintBadge count={2} />)
    expect(screen.getByText('📷 2').getAttribute('title')).toBe('2 prints da tarefa testada')
    rerender(<PrintBadge count={0} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('CardPrints', () => {
  it('miniaturas do cartão; o clique abre o print grande com legenda e horário; Esc fecha', async () => {
    const api = fakeApi([meta('p1', 'a'), meta('p2', 'a'), meta('x', 'b')])
    render(<CardPrints boardItemId="a" api={api} />)
    expect(await screen.findByText('legenda p1')).toBeTruthy()
    expect(screen.queryByText('legenda x')).toBeNull()
    fireEvent.click(screen.getByTitle('legenda p2'))
    const dialog = await screen.findByRole('dialog', { name: 'Print da tarefa' })
    await waitFor(() => expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,GRANDE'))
    expect(api.boardPrintImage).toHaveBeenCalledWith('p2')
    expect(dialog.textContent).toMatch(/legenda p2/)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Print da tarefa' })).toBeNull()
  })

  it('cartão sem print: nada aparece', async () => {
    const api = fakeApi([])
    const { container } = render(<CardPrints boardItemId="a" api={api} />)
    await waitFor(() => expect(api.boardPrints).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })
})

describe('BoardPanel — o 📷 no cartão e as miniaturas no detalhe', () => {
  it('o cartão com prints mostra 📷 2; abrir o cartão mostra as miniaturas', async () => {
    const prints = fakeApi([meta('p1', 'a'), meta('p2', 'a')])
    ;(window as unknown as { api: unknown }).api = {
      boardList: vi.fn().mockResolvedValue({ available: true, items: [card()] }),
      boardDismiss: vi.fn(),
      boardMove: vi.fn(),
      boardItemEvents: vi.fn().mockResolvedValue([]),
      tasksBoard: vi.fn().mockResolvedValue({ available: true, items: [] }),
      tasksDetail: vi.fn(),
      ...prints
    }
    render(
      <BoardPanel projectCwd="C:/proj" conversationId="conv-1" conversationTitles={{ 'conv-1': 'Implementação' }} busy={false} onClose={vi.fn()} onOpenConversation={vi.fn()} />
    )
    expect(await screen.findByText('📷 2')).toBeTruthy()
    fireEvent.click(screen.getByText('Tela de login'))
    expect(await screen.findByText('Prints da tarefa testada')).toBeTruthy()
    expect(screen.getAllByAltText(/legenda p/)).toHaveLength(2)
  })
})
