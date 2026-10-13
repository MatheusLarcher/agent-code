import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { BOARD_AUTHORIZE_MESSAGE, BOARD_PO_AWAITING_REASON, BOARD_TURN_END_REASON, type BoardItem, type ProjectBoard } from '@shared/ipc'
import { BoardPanel } from './BoardPanel'
import type { BoardCardReplyHandler } from './BoardCardReply'

/**
 * A resposta pelo cartão "Aguardando você": o controle que o PO escolheu
 * ("Pode fazer" ou o campo), fora do <button> do cartão, mandando para a
 * conversa dona do cartão — uma vez só até o cartão mudar.
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
    sourceTitle: 'publicar a versão',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    // O fim de turno rebaixou: é o que acende o selo "Aguardando você".
    poStatus: 'pending',
    poReason: BOARD_TURN_END_REASON.result,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-10-11T12:00:00.000Z',
    updatedAt: '2026-10-11T12:00:00.000Z',
    poUserAction: 'Autorizar o deploy na VPS',
    poReplyKind: 'authorize',
    ...over
  }
}

function mockApi(board: ProjectBoard) {
  const listeners: (() => void)[] = []
  const api = {
    boardList: vi.fn().mockResolvedValue(board),
    boardDismiss: vi.fn().mockResolvedValue(null),
    boardMove: vi.fn().mockResolvedValue({ ok: true }),
    boardItemEvents: vi.fn().mockResolvedValue([]),
    onBoardChanged: vi.fn((cb: () => void) => {
      listeners.push(cb)
      return () => undefined
    }),
    tasksBoard: vi.fn().mockResolvedValue({ available: true, items: [] }),
    tasksDetail: vi.fn().mockResolvedValue({ steps: [], deliverables: [], events: [] })
  }
  ;(window as unknown as { api: unknown }).api = api
  return { api, changed: () => listeners.forEach((cb) => cb()) }
}

function panel(onCardReply?: BoardCardReplyHandler): JSX.Element {
  return (
    <BoardPanel
      projectCwd="C:/proj"
      conversationId="conv-1"
      conversationTitles={{ 'conv-1': 'Quadro de tarefas', 'conv-2': 'Outra' }}
      busy={false}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
      onCardReply={onCardReply}
    />
  )
}

describe('BoardPanel — resposta pelo cartão "Aguardando você"', () => {
  it('"Pode fazer" manda a autorização para a conversa dona do cartão, sem abrir o detalhe', async () => {
    mockApi({ available: true, items: [card({ conversationId: 'conv-2' })] })
    const reply = vi.fn<BoardCardReplyHandler>().mockResolvedValue('sent')
    const { container } = render(panel(reply))

    const btn = await screen.findByRole('button', { name: 'Pode fazer' })
    // Irmão do <button> do cartão, nunca dentro dele.
    expect(btn.closest('.board-card')).toBeNull()
    expect(btn.closest('.board-card-wrap')).not.toBeNull()
    fireEvent.click(btn)

    await waitFor(() => expect(reply).toHaveBeenCalledWith('conv-2', BOARD_AUTHORIZE_MESSAGE))
    expect(await screen.findByRole('button', { name: 'Enviado' })).toHaveProperty('disabled', true)
    expect(container.querySelector('.board-detail')).toBeNull()
  })

  it('o campo envia o texto com Enter; Shift+Enter não envia; vazio não envia', async () => {
    mockApi({ available: true, items: [card({ poReplyKind: 'answer', poUserAction: 'Qual porta usar?' })] })
    const reply = vi.fn<BoardCardReplyHandler>().mockResolvedValue('sent')
    render(panel(reply))

    const input = await screen.findByPlaceholderText('Qual porta usar?')
    const send = screen.getByRole('button', { name: 'Enviar' })
    expect(send).toHaveProperty('disabled', true)

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(send)
    expect(reply).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'use a 8080' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(reply).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(reply).toHaveBeenCalledWith('conv-1', 'use a 8080'))
    expect(await screen.findByRole('button', { name: 'Enviado' })).toHaveProperty('disabled', true)
  })

  it('o botão Enviar também envia; placeholder padrão sem a ação do PO', async () => {
    // Sem a ação, quem acende o selo é a autorização pendente.
    mockApi({
      available: true,
      items: [card({ poReplyKind: 'answer', poUserAction: null, poReason: BOARD_PO_AWAITING_REASON })]
    })
    const reply = vi.fn<BoardCardReplyHandler>().mockResolvedValue('sent')
    render(panel(reply))

    const input = await screen.findByPlaceholderText('Responder ao agente…')
    fireEvent.change(input, { target: { value: 'sim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(reply).toHaveBeenCalledWith('conv-1', 'sim'))
  })

  it('sem controle: fim de turno sem ação ("Parado"), ou cartão que não espera você', async () => {
    mockApi({
      available: true,
      items: [
        card({ id: 'a', sourceTitle: 'sem ação', poUserAction: null, poReplyKind: null }),
        card({ id: 'b', sourceTitle: 'andando', poStatus: null, poReason: null })
      ]
    })
    render(panel(vi.fn<BoardCardReplyHandler>()))
    await screen.findByText('andando')
    expect(screen.getByText('Parado')).toBeTruthy()
    expect(screen.queryByText('Aguardando você')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pode fazer' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('o selo aceso sempre tem controle: sem poReplyKind, o tipo vem da ação', async () => {
    mockApi({
      available: true,
      items: [
        card({ id: 'a', sourceTitle: 'autorizar', poReplyKind: null }),
        card({ id: 'b', sourceTitle: 'testar', poReplyKind: null, poUserAction: 'Testar no celular' })
      ]
    })
    render(panel(vi.fn<BoardCardReplyHandler>()))
    expect(await screen.findByRole('button', { name: 'Pode fazer' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Testar no celular')).toBeTruthy()
    expect(screen.getAllByText('Aguardando você')).toHaveLength(2)
  })

  it('duplo clique manda uma vez só; "Enviado" some quando o cartão muda', async () => {
    const { api, changed } = mockApi({ available: true, items: [card()] })
    let resolve: (v: 'sent') => void = () => undefined
    const reply = vi.fn<BoardCardReplyHandler>(() => new Promise((r) => (resolve = r)))
    render(panel(reply))

    const btn = await screen.findByRole('button', { name: 'Pode fazer' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await act(async () => resolve('sent'))
    fireEvent.click(await screen.findByRole('button', { name: 'Enviado' }))
    expect(reply).toHaveBeenCalledTimes(1)

    // O cartão mudou (nova revisão) e ainda espera você: o controle volta.
    api.boardList.mockResolvedValue({ available: true, items: [card({ revision: 2, updatedAt: '2026-10-11T12:05:00.000Z' })] })
    await act(async () => changed())
    expect(await screen.findByRole('button', { name: 'Pode fazer' })).toHaveProperty('disabled', false)
  })

  it('conversa do cartão não encontrada: erro curto no cartão', async () => {
    mockApi({ available: true, items: [card()] })
    const reply = vi.fn<BoardCardReplyHandler>().mockResolvedValue('missing')
    render(panel(reply))

    fireEvent.click(await screen.findByRole('button', { name: 'Pode fazer' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/conversa deste cartão/)
    expect(screen.getByRole('button', { name: 'Pode fazer' })).toHaveProperty('disabled', false)
  })

  it('na visão Lista o controle aparece embaixo da linha, fora do <button> dela', async () => {
    mockApi({ available: true, items: [card()] })
    const reply = vi.fn<BoardCardReplyHandler>().mockResolvedValue('sent')
    render(panel(reply))
    await screen.findByRole('button', { name: 'Pode fazer' })
    fireEvent.click(screen.getByText('Lista'))

    const btn = screen.getByRole('button', { name: 'Pode fazer' })
    expect(btn.closest('.board-row')).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => expect(reply).toHaveBeenCalledWith('conv-1', BOARD_AUTHORIZE_MESSAGE))
  })
})
