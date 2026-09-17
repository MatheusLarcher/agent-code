import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { BoardItem, ProjectBoard, TaskBoard, TaskBoardDetail, TaskBoardItem } from '@shared/ipc'
import type { CrewMember } from '../crew'
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

function taskItem(over: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: 'tk-1',
    title: 'Criar a tabela do quadro',
    goal: 'Adicionar board_items e o repositório correspondente.',
    status: 'running',
    acceptance: ['npm run typecheck passa'],
    ownerAgent: 'session:abc',
    writeScopeAllow: [],
    writeScopeDeny: [],
    attempts: 1,
    maxAttempts: 3,
    leaseExpiresAt: null,
    conversationId: 'conv-1',
    projectCwd: 'C:/proj',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliverables: null,
    boardItemId: null,
    ...over
  }
}

function crewMember(over: Partial<CrewMember> = {}): CrewMember {
  return {
    id: 'role:po',
    role: 'po',
    name: 'PO',
    kind: 'cuida do quadro',
    state: 'working',
    line: [{ kind: 'text', text: 'auditando o quadro desta conversa' }],
    startedAt: Date.now() - 5_000,
    group: 'observadores',
    ...over
  }
}

function mockApi(board: ProjectBoard, taskBoard?: TaskBoard, taskDetail?: TaskBoardDetail | null) {
  const api = {
    boardList: vi.fn().mockResolvedValue(board),
    boardDismiss: vi.fn().mockResolvedValue(null),
    boardMove: vi.fn().mockResolvedValue({ ok: true }),
    boardItemEvents: vi.fn().mockResolvedValue([]),
    onBoardChanged: vi.fn().mockReturnValue(() => undefined),
    tasksBoard: vi.fn().mockResolvedValue(taskBoard ?? { available: true, items: [] }),
    tasksDetail: vi.fn().mockResolvedValue(taskDetail ?? { steps: [], deliverables: [], events: [] })
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

/** Testing Library's `fireEvent` attaches unknown init properties straight onto
 *  the event object, which is how a fake `DataTransfer` reaches the handler in
 *  jsdom (it has no native drag-and-drop implementation). */
function dataTransferStub(): { setData: ReturnType<typeof vi.fn>; effectAllowed: string } {
  return { setData: vi.fn(), effectAllowed: '' }
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

  it('o botão de excluir no próprio cartão dispensa direto, sem abrir o detalhe', async () => {
    const api = mockApi({ available: true, items: [card()] })
    render(panel())
    await screen.findByText('add board table')
    fireEvent.click(screen.getByTitle('Excluir cartão'))
    await waitFor(() => expect(api.boardDismiss).toHaveBeenCalledWith('bi-1', true))
    // Não abriu o detalhe: o botão "Dispensar cartão" (só existe lá dentro) não aparece.
    expect(screen.queryByText('Dispensar cartão')).toBeNull()
  })

  it('o detalhe mostra metadados e busca a linha do tempo só ao abrir', async () => {
    const api = mockApi({ available: true, items: [card()] })
    api.boardItemEvents.mockResolvedValue([
      {
        id: 'bie-1',
        boardItemId: 'bi-1',
        at: '2026-09-14T12:00:00.000Z',
        kind: 'created',
        actor: 'agent',
        fromStatus: null,
        toStatus: 'pending',
        note: null
      },
      {
        id: 'bie-2',
        boardItemId: 'bi-1',
        at: '2026-09-14T13:00:00.000Z',
        kind: 'status_changed',
        actor: 'po',
        fromStatus: 'pending',
        toStatus: 'completed',
        note: 'o agente esqueceu de marcar'
      }
    ])
    render(panel())
    // Sem clicar em nada, a busca não pode ter disparado — timeline é custo
    // só de quem abriu o cartão.
    expect(api.boardItemEvents).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText('add board table'))
    await waitFor(() => expect(api.boardItemEvents).toHaveBeenCalledWith('bi-1'))
    expect(await screen.findByText(/mudou para conclu[íi]do/i)).toBeTruthy()
    expect(screen.getByText(/o agente esqueceu de marcar/)).toBeTruthy()
    expect(screen.getByText('Revisão')).toBeTruthy()
    expect(screen.getByText('Criado')).toBeTruthy()
  })

  it('o detalhe não quebra se a linha do tempo falhar ao carregar', async () => {
    const api = mockApi({ available: true, items: [card()] })
    api.boardItemEvents.mockRejectedValue(new Error('banco fora do ar'))
    render(panel())
    fireEvent.click(await screen.findByText('add board table'))
    expect(await screen.findByText(/Sem histórico registrado/)).toBeTruthy()
  })

  it('arrastar um cartão para "Fazendo" dispara boardMove com o status certo', async () => {
    const api = mockApi({
      available: true,
      items: [card({ id: 'a', sourceTitle: 'a fazer', sourceStatus: 'pending' })]
    })
    const { container } = render(panel())
    const cardBtn = (await screen.findByText('a fazer')).closest('button')!
    const doingColumn = container.querySelectorAll('.board-column')[1]

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(cardBtn, { dataTransfer })
    fireEvent.dragOver(doingColumn, { dataTransfer })
    fireEvent.drop(doingColumn, { dataTransfer })

    await waitFor(() => expect(api.boardMove).toHaveBeenCalledWith('a', 'in_progress'))
  })

  it('o cartão já arrastado para a coluna atual não chama boardMove de novo', async () => {
    const api = mockApi({
      available: true,
      items: [card({ id: 'a', sourceTitle: 'fazendo agora', sourceStatus: 'in_progress' })]
    })
    const { container } = render(panel())
    const cardBtn = (await screen.findByText('fazendo agora')).closest('button')!
    const doingColumn = container.querySelectorAll('.board-column')[1]

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(cardBtn, { dataTransfer })
    fireEvent.drop(doingColumn, { dataTransfer })

    expect(api.boardMove).not.toHaveBeenCalled()
  })

  it('boardMove recusado desfaz a posição do cartão e mostra a mensagem', async () => {
    const api = mockApi({
      available: true,
      items: [card({ id: 'a', sourceTitle: 'a fazer', sourceStatus: 'pending' })]
    })
    api.boardMove.mockResolvedValue({ ok: false, message: 'Abra esta conversa antes de mover pelo quadro.' })
    const { container } = render(panel())
    const cardBtn = (await screen.findByText('a fazer')).closest('button')!
    const doingColumn = container.querySelectorAll('.board-column')[1]

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(cardBtn, { dataTransfer })
    fireEvent.drop(doingColumn, { dataTransfer })

    expect(await screen.findByText(/Abra esta conversa antes de mover pelo quadro/)).toBeTruthy()
  })

  it('drag desabilitado em "Projeto inteiro" e na visão Lista', async () => {
    const api = mockApi({ available: true, items: [card()] })
    render(panel())
    const boardCard = (await screen.findByText('add board table')).closest('button')!
    expect(boardCard.draggable).toBe(true) // "Esta conversa" + Quadro: arrastável

    fireEvent.click(screen.getByText('Projeto inteiro'))
    await waitFor(() =>
      expect(api.boardList).toHaveBeenCalledWith({ projectCwd: 'C:/proj', conversationId: undefined })
    )
    const wholeProjectCard = (await screen.findByText('add board table')).closest('button')!
    expect(wholeProjectCard.draggable).toBe(false)

    fireEvent.click(screen.getByText('Esta conversa'))
    fireEvent.click(screen.getByText('Lista'))
    const listRow = (await screen.findByText('add board table')).closest('button')!
    expect(listRow.draggable).toBe(false)
    expect(api.boardMove).not.toHaveBeenCalled()
  })
})

describe('bolinha do executor por cartão', () => {
  it('só aparece no cartão que o boardItemId aponta de verdade', async () => {
    mockApi(
      {
        available: true,
        items: [
          card({ id: 'bi-1', sourceTitle: 'com executor' }),
          card({ id: 'bi-2', sourceTitle: 'sem executor' })
        ]
      },
      { available: true, items: [taskItem({ id: 'tk-1', boardItemId: 'bi-1' })] }
    )
    render(panel())
    await screen.findByText('com executor')
    await screen.findByText('sem executor')

    const cardWithDot = (await screen.findByText('com executor')).closest('button')!
    const cardWithoutDot = (await screen.findByText('sem executor')).closest('button')!
    await waitFor(() => expect(cardWithDot.querySelector('.board-agent-dot')).toBeTruthy())
    expect(cardWithoutDot.querySelector('.board-agent-dot')).toBeFalsy()
  })

  it('clicar na bolinha abre o balão com objetivo e aceite, sem abrir o detalhe do cartão', async () => {
    const api = mockApi(
      {
        available: true,
        items: [card({ id: 'bi-1', sourceTitle: 'com executor' })]
      },
      {
        available: true,
        items: [
          taskItem({
            id: 'tk-1',
            boardItemId: 'bi-1',
            goal: 'Adicionar board_items e o repositório correspondente.',
            acceptance: ['npm run typecheck passa'],
            conversationId: 'conv-9'
          })
        ]
      }
    )
    render(panel())
    const dot = await waitFor(() => {
      const el = document.querySelector('.board-agent-dot')
      if (!el) throw new Error('bolinha ainda não renderizou')
      return el
    })
    fireEvent.click(dot)

    expect(await screen.findByText(/Adicionar board_items e o repositório correspondente\./)).toBeTruthy()
    expect(screen.getByText('npm run typecheck passa')).toBeTruthy()
    // O clique não deve ter aberto o detalhe do cartão (que mostraria "Status").
    expect(screen.queryByText('Status')).toBeFalsy()

    await waitFor(() => expect(api.tasksDetail).toHaveBeenCalledWith('tk-1'))

    // Clicar de novo fecha.
    fireEvent.click(dot)
    await waitFor(() =>
      expect(screen.queryByText(/Adicionar board_items e o repositório correspondente\./)).toBeFalsy()
    )
  })

  it('"Abrir a conversa" do balão do executor usa a conversa da própria tarefa', async () => {
    const onOpenConversation = vi.fn()
    mockApi(
      { available: true, items: [card({ id: 'bi-1' })] },
      { available: true, items: [taskItem({ id: 'tk-1', boardItemId: 'bi-1', conversationId: 'conv-9' })] }
    )
    render(panel({ onOpenConversation }))
    const dot = await waitFor(() => {
      const el = document.querySelector('.board-agent-dot')
      if (!el) throw new Error('bolinha ainda não renderizou')
      return el
    })
    fireEvent.click(dot)
    fireEvent.click(await screen.findByText('Abrir a conversa'))
    expect(onOpenConversation).toHaveBeenCalledWith('conv-9')
  })
})

describe('bolinhas de po/vigia/crítico/memória no cabeçalho de coluna', () => {
  it('mostra a bolinha do papel ativo no cabeçalho, nunca dentro de um cartão', async () => {
    mockApi({ available: true, items: [card({ sourceStatus: 'in_progress' })] })
    const { container } = render(panel({ crew: [crewMember({ state: 'working' })] }))
    await screen.findByText('add board table')

    const doingColumnHead = container.querySelectorAll('.board-column-head')[1]
    expect(doingColumnHead.querySelector('.board-agent-dot')).toBeTruthy()

    const cardBtn = (await screen.findByText('add board table')).closest('button')!
    expect(cardBtn.querySelector('.board-agent-dot')).toBeFalsy()
  })

  it('não mostra bolinha de papel parado ("idle") — só quem está ativo', async () => {
    mockApi({ available: true, items: [card()] })
    const { container } = render(panel({ crew: [crewMember({ state: 'idle' })] }))
    await screen.findByText('add board table')
    expect(container.querySelector('.board-agent-dots .board-agent-dot')).toBeFalsy()
  })

  it('não mostra bolinha de crew em "Projeto inteiro" (o elenco é de uma conversa só)', async () => {
    mockApi({ available: true, items: [card()] })
    render(panel({ crew: [crewMember({ state: 'working' })] }))
    await screen.findByText('add board table')
    fireEvent.click(screen.getByText('Projeto inteiro'))
    await waitFor(() => expect(document.querySelector('.board-agent-dots .board-agent-dot')).toBeFalsy())
  })

  it('clicar na bolinha do papel abre um balão simples com o estado, sem goal/aceite', async () => {
    mockApi({ available: true, items: [card()] })
    const { container } = render(
      panel({ crew: [crewMember({ state: 'working', line: [{ kind: 'text', text: 'auditando o quadro' }] })] })
    )
    await screen.findByText('add board table')
    const dot = container.querySelector('.board-agent-dots .board-agent-dot')!
    fireEvent.click(dot)
    expect(await screen.findByText('auditando o quadro')).toBeTruthy()
    expect(screen.queryByText('Objetivo')).toBeFalsy()
  })
})

describe('Mapa do projeto (ProjectGraph) a partir do Quadro', () => {
  it('sem `project`, o botão "Mapa" nem aparece', async () => {
    mockApi({ available: true, items: [card()] })
    render(panel())
    await screen.findByText('add board table')
    expect(screen.queryByText('Mapa')).toBeFalsy()
  })

  it('clicar em "Mapa" abre o ProjectGraph num overlay, e o × fecha', async () => {
    mockApi({ available: true, items: [card()] })
    render(
      panel({
        project: {
          entries: [],
          touches: [],
          turns: [],
          missing: [],
          truncated: false,
          steps: [],
          name: 'agent-code'
        }
      })
    )
    await screen.findByText('add board table')
    expect(screen.queryByText('Lendo os arquivos do projeto…')).toBeFalsy()

    fireEvent.click(screen.getByText('Mapa'))
    expect(await screen.findByText('Mapa do projeto')).toBeTruthy()
    expect(screen.getByText('Lendo os arquivos do projeto…')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Fechar'))
    await waitFor(() => expect(screen.queryByText('Mapa do projeto')).toBeFalsy())
  })
})
