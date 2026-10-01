import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { BoardItem, BoardItemEvent, ProjectBoard } from '@shared/ipc'
import { BoardPanel } from './BoardPanel'

/**
 * O motivo de cada alteração do PO aparece para o usuário: no tooltip dos
 * selos, no detalhe ("Motivo atual") e na linha do tempo — com "Sistema" para
 * as regras automáticas, não "PO".
 */

afterEach(cleanup)

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'proj',
    projectCwd: 'C:/proj',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'add board table',
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  }
}

function event(over: Partial<BoardItemEvent>): BoardItemEvent {
  return {
    id: `bie-${Math.random()}`,
    boardItemId: 'bi-1',
    at: '2026-09-14T12:00:00.000Z',
    kind: 'created',
    actor: 'agent',
    fromStatus: null,
    toStatus: null,
    note: null,
    ...over
  }
}

function mockApi(board: ProjectBoard, events: BoardItemEvent[] = []) {
  const api = {
    boardList: vi.fn().mockResolvedValue(board),
    boardDismiss: vi.fn().mockResolvedValue(null),
    boardMove: vi.fn().mockResolvedValue({ ok: true }),
    boardItemEvents: vi.fn().mockResolvedValue(events),
    onBoardChanged: vi.fn().mockReturnValue(() => undefined),
    tasksBoard: vi.fn().mockResolvedValue({ available: true, items: [] }),
    tasksDetail: vi.fn().mockResolvedValue({ steps: [], deliverables: [], events: [] })
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function panel(): JSX.Element {
  return (
    <BoardPanel
      projectCwd="C:/proj"
      conversationId="conv-1"
      conversationTitles={{ 'conv-1': 'Quadro de tarefas' }}
      busy={false}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
    />
  )
}

describe('BoardPanel — motivos do PO', () => {
  it('os selos do PO levam o motivo no tooltip', async () => {
    mockApi({
      available: true,
      items: [
        card({ id: 'a', sourceTitle: 'um', sourceStatus: 'in_progress', poStatus: 'completed', poReason: 'o teste passou' }),
        card({ id: 'b', sourceTitle: 'dois', poTitle: 'Dois legível', poReason: 'título técnico demais' }),
        card({ id: 'c', sourceTitle: 'tres', sourceStatus: 'completed', poStatus: 'completed', poReason: 'confirmado' }),
        card({ id: 'd', sourceTitle: 'quatro', origin: 'po', poReason: 'o agente disse que falta' })
      ]
    })
    render(panel())

    expect((await screen.findByText('PO corrigiu')).getAttribute('title')).toBe('Motivo: o teste passou')
    expect(screen.getByText('PO reescreveu').getAttribute('title')).toBe('Motivo: título técnico demais')
    expect(screen.getByText('PO revisou').getAttribute('title')).toBe('Motivo: confirmado')
    expect(screen.getByText('PO acrescentou').getAttribute('title')).toBe('Motivo: o agente disse que falta')
  })

  it('o detalhe mostra o motivo atual e a linha do tempo mostra "Sistema" e cada justificativa', async () => {
    const reason = 'o turno terminou sem concluir esta tarefa — falta commitar'
    mockApi({ available: true, items: [card({ sourceStatus: 'in_progress', poStatus: 'pending', poReason: reason })] }, [
      event({ kind: 'justified', actor: 'po', fromStatus: 'in_progress', toStatus: 'in_progress', note: 'falta commitar' }),
      event({ kind: 'status_changed', actor: 'system', fromStatus: 'in_progress', toStatus: 'pending', note: reason }),
      event({ kind: 'dismissed', actor: 'system', note: 'concluído há mais de 5 dias' })
    ])
    render(panel())
    fireEvent.click(await screen.findByText('add board table'))

    expect(screen.getByText('Motivo atual')).toBeTruthy()
    expect(await screen.findByText(/justificou/)).toBeTruthy()
    // A nota do evento "justified" é só o motivo concreto.
    expect(screen.getAllByText((_, el) => el?.textContent === ' — falta commitar')).toHaveLength(1)
    expect(screen.getAllByText('Sistema')).toHaveLength(2)
    expect(screen.getByText('PO')).toBeTruthy()
    expect(screen.getByText(/concluído há mais de 5 dias/)).toBeTruthy()
  })
})
