import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { BoardItem, ProjectBoard } from '@shared/ipc'
import { BoardPanel, boardProgress, effectiveStatus, effectiveTitle, isPoCorrected } from './BoardPanel'

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

function mockApi(board: ProjectBoard) {
  const api = {
    boardList: vi.fn().mockResolvedValue(board),
    boardDismiss: vi.fn().mockResolvedValue(null),
    onBoardChanged: vi.fn().mockReturnValue(() => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function panel(over: Partial<Parameters<typeof BoardPanel>[0]> = {}): JSX.Element {
  return (
    <BoardPanel
      projectCwd="C:/proj"
      conversationId="conv-1"
      conversationTitles={{ 'conv-1': 'Quadro de tarefas' }}
      busy={false}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
      {...over}
    />
  )
}

describe('sobreposição das camadas na tela', () => {
  it('mostra o título e o status do PO, mas preserva os do agente por baixo', () => {
    const item = card({ poTitle: 'Criar a tabela do quadro', poStatus: 'completed', poReason: 'esqueceu de marcar' })
    expect(effectiveTitle(item)).toBe('Criar a tabela do quadro')
    expect(effectiveStatus(item)).toBe('completed')
    expect(isPoCorrected(item)).toBe(true)
    expect(item.sourceTitle).toBe('add board table')
  })

  it('boardProgress conta pelo status efetivo', () => {
    const items = [card({ id: 'a', sourceStatus: 'completed' }), card({ id: 'b', poStatus: 'completed', poReason: 'x' }), card({ id: 'c' })]
    expect(boardProgress(items)).toEqual({ done: 2, total: 3 })
  })
})

describe('BoardPanel', () => {
  it('distribui os cartões pelas três colunas', async () => {
    mockApi({
      available: true,
      items: [
        card({ id: 'a', sourceTitle: 'a fazer', sourceStatus: 'pending' }),
        card({ id: 'b', sourceTitle: 'fazendo agora', sourceStatus: 'in_progress' }),
        card({ id: 'c', sourceTitle: 'já feito', sourceStatus: 'completed' })
      ]
    })
    render(panel())
    expect(await screen.findByText('a fazer')).toBeTruthy()
    expect(screen.getByText('fazendo agora')).toBeTruthy()
    expect(screen.getByText('já feito')).toBeTruthy()
    expect(screen.getByText('A fazer')).toBeTruthy()
    expect(screen.getByText('Concluído')).toBeTruthy()
  })

  it('marca visualmente o que o PO corrigiu', async () => {
    mockApi({
      available: true,
      items: [card({ poStatus: 'completed', poReason: 'o agente concluiu e esqueceu de marcar' })]
    })
    render(panel())
    expect(await screen.findByText('PO corrigiu')).toBeTruthy()
  })

  it('cartão criado pelo PO é identificado como tal', async () => {
    mockApi({ available: true, items: [card({ origin: 'po', sourceId: null, sourceTitle: 'testar com 2 conversas' })] })
    render(panel())
    expect(await screen.findByText('PO acrescentou')).toBeTruthy()
  })

  it('o detalhe mostra o motivo do PO — é o que torna a correção auditável', async () => {
    mockApi({
      available: true,
      items: [card({ poStatus: 'completed', poReason: 'os arquivos foram escritos e o teste passou' })]
    })
    render(panel())
    fireEvent.click(await screen.findByText('add board table'))
    expect(await screen.findByText(/os arquivos foram escritos e o teste passou/)).toBeTruthy()
  })

  it('o detalhe explica POR QUE o cartão voltou para "a fazer" no fim do turno', async () => {
    mockApi({
      available: true,
      items: [
        card({
          sourceStatus: 'in_progress',
          poStatus: 'pending',
          poReason: 'o turno terminou sem concluir esta tarefa'
        })
      ]
    })
    render(panel())
    fireEvent.click(await screen.findByText('add board table'))
    expect(await screen.findByText(/marcou como a fazer: o turno terminou sem concluir esta tarefa/)).toBeTruthy()
  })

  it('cartão com trilha do PO é distinguível mesmo quando o PO não contradiz o agente', async () => {
    // A reabertura por cima de um cartão que o PO tinha aberto: os dois status
    // acabam iguais, então não é "correção" — mas o cartão tem motivo para ler.
    mockApi({
      available: true,
      items: [card({ poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa' })]
    })
    render(panel())
    expect(await screen.findByText('PO revisou')).toBeTruthy()
  })

  it('quadro vazio e quadro indisponível dizem coisas DIFERENTES', async () => {
    mockApi({ available: true, items: [] })
    const { unmount } = render(panel())
    expect(await screen.findByText(/Nenhuma tarefa ainda/)).toBeTruthy()
    unmount()

    mockApi({ available: false, items: [] })
    render(panel())
    expect(await screen.findByText(/banco de dados do app/)).toBeTruthy()
  })

  it('trocar para "Projeto inteiro" reconsulta sem filtrar por conversa', async () => {
    const api = mockApi({ available: true, items: [card()] })
    render(panel())
    await screen.findByText('add board table')
    expect(api.boardList).toHaveBeenCalledWith({ projectCwd: 'C:/proj', conversationId: 'conv-1' })

    fireEvent.click(screen.getByText('Projeto inteiro'))
    await waitFor(() =>
      expect(api.boardList).toHaveBeenCalledWith({ projectCwd: 'C:/proj', conversationId: undefined })
    )
  })

  it('a visão Lista agrupa por conversa de origem', async () => {
    mockApi({
      available: true,
      items: [card({ id: 'a' }), card({ id: 'b', conversationId: 'conv-2', sourceTitle: 'da outra conversa' })]
    })
    render(panel({ conversationTitles: { 'conv-1': 'Quadro de tarefas', 'conv-2': 'Ajustes do celular' } }))
    await screen.findByText('add board table')
    fireEvent.click(screen.getByText('Lista'))
    expect(await screen.findByText(/Quadro de tarefas/)).toBeTruthy()
    expect(screen.getByText(/Ajustes do celular/)).toBeTruthy()
  })

  it('dispensar um cartão chama a única escrita do usuário e recarrega', async () => {
    const api = mockApi({ available: true, items: [card()] })
    render(panel())
    fireEvent.click(await screen.findByText('add board table'))
    fireEvent.click(await screen.findByText('Dispensar cartão'))
    await waitFor(() => expect(api.boardDismiss).toHaveBeenCalledWith('bi-1', true))
  })
})
