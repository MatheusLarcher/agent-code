import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { BoardItem, ProjectBoard } from '@shared/ipc'
import { BoardPanel } from './BoardPanel'

/**
 * A pendência (commitar, verificar, deploy) diz de qual pedido sobrou: o detalhe
 * mostra "Pendência de" com o título do cartão de origem, e o clique abre ele.
 */

afterEach(cleanup)

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'proj',
    projectCwd: 'C:/proj',
    conversationId: 'conv-1',
    origin: 'po',
    sourceId: null,
    sourceTitle: 'Implementar a fase 1 do escritório',
    sourceStatus: 'completed',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: 'código entregue, testes verdes',
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  }
}

function mockApi(board: ProjectBoard): void {
  ;(window as unknown as { api: unknown }).api = {
    boardList: vi.fn().mockResolvedValue(board),
    boardDismiss: vi.fn().mockResolvedValue(null),
    boardMove: vi.fn().mockResolvedValue({ ok: true }),
    boardItemEvents: vi.fn().mockResolvedValue([]),
    onBoardChanged: vi.fn().mockReturnValue(() => undefined),
    tasksBoard: vi.fn().mockResolvedValue({ available: true, items: [] }),
    tasksDetail: vi.fn().mockResolvedValue({ steps: [], deliverables: [], events: [] })
  }
}

function panel(): JSX.Element {
  return (
    <BoardPanel
      projectCwd="C:/proj"
      conversationId="conv-1"
      conversationTitles={{ 'conv-1': 'Implementação' }}
      busy={false}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
    />
  )
}

const parent = card({ id: 'bi-pedido' })
const child = card({
  id: 'bi-pendencia',
  seq: 1,
  sourceTitle: 'Commitar a fase 1 do escritório',
  sourceStatus: 'pending',
  poReason: 'aguardando autorização do usuário',
  parentId: 'bi-pedido'
})

describe('BoardCardDetail — "Pendência de"', () => {
  it('o detalhe da pendência mostra o cartão de origem, e o clique abre ele', async () => {
    mockApi({ available: true, items: [parent, child] })
    render(panel())
    fireEvent.click(await screen.findByText('Commitar a fase 1 do escritório'))

    const detail = document.querySelector('.board-detail') as HTMLElement
    expect(within(detail).getByText('Pendência de')).toBeTruthy()
    const link = within(detail).getByRole('button', { name: 'Implementar a fase 1 do escritório' })
    fireEvent.click(link)

    const opened = document.querySelector('.board-detail') as HTMLElement
    expect(within(opened).getByRole('heading', { name: 'Implementar a fase 1 do escritório' })).toBeTruthy()
    expect(within(opened).queryByText('Pendência de')).toBeNull()
  })

  it('pai que saiu do quadro: avisa, sem link quebrado', async () => {
    mockApi({ available: true, items: [child] })
    render(panel())
    fireEvent.click(await screen.findByText('Commitar a fase 1 do escritório'))
    const detail = document.querySelector('.board-detail') as HTMLElement
    expect(within(detail).getByText('um cartão que não está mais no quadro')).toBeTruthy()
  })

  it('cartão comum não tem a linha', async () => {
    mockApi({ available: true, items: [parent] })
    render(panel())
    fireEvent.click(await screen.findByText('Implementar a fase 1 do escritório'))
    expect(within(document.querySelector('.board-detail') as HTMLElement).queryByText('Pendência de')).toBeNull()
  })
})
