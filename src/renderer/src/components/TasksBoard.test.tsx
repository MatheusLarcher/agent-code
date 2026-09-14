import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { TaskBoard, TaskBoardDetail, TaskBoardItem } from '@shared/ipc'
import { TasksBoard, describeLease } from './TasksBoard'

afterEach(cleanup)

function item(over: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: 'tsk-1',
    title: 'Painel de tarefas',
    goal: 'Expor a fila',
    status: 'pending',
    acceptance: [],
    ownerAgent: null,
    writeScopeAllow: [],
    writeScopeDeny: [],
    attempts: 0,
    maxAttempts: 3,
    leaseExpiresAt: null,
    conversationId: null,
    projectCwd: 'C:/proj',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliverables: null,
    ...over
  }
}

const emptyDetail: TaskBoardDetail = { steps: [], deliverables: [], events: [] }

function mockApi(board: TaskBoard, detail: TaskBoardDetail | null = emptyDetail): {
  tasksBoard: ReturnType<typeof vi.fn>
  tasksDetail: ReturnType<typeof vi.fn>
} {
  const api = {
    tasksBoard: vi.fn().mockResolvedValue(board),
    tasksDetail: vi.fn().mockResolvedValue(detail)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('TasksBoard', () => {
  it('sem repositório autoritativo, explica em vez de mostrar fila vazia', async () => {
    mockApi({ available: false, items: [] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    expect(await screen.findByText(/desligado/)).toBeTruthy()
    expect(screen.queryByText(/Nenhuma tarefa registrada/)).toBeNull()
  })

  it('banco ligado e fila vazia explica quando o registro é usado', async () => {
    mockApi({ available: true, items: [] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    expect(await screen.findByText(/Nenhuma tarefa registrada/)).toBeTruthy()
  })

  it('agrupa por estado e põe quem espera uma pessoa antes da fila', async () => {
    mockApi({
      available: true,
      items: [
        item({ id: 'r', title: 'em revisão', status: 'review', deliverables: 2 }),
        item({ id: 'p', title: 'na fila', status: 'pending' })
      ]
    })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await screen.findByText('em revisão')
    const titles = document.querySelectorAll('.agents-section-title')
    expect(titles[0].textContent).toContain('Esperando o crítico')
    expect(screen.getByText('2 evidências')).toBeTruthy()
  })

  it('review sem entregável é marcado como sem evidência', async () => {
    mockApi({
      available: true,
      items: [item({ status: 'review', deliverables: 0 })]
    })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    expect(await screen.findByText('sem evidência')).toBeTruthy()
  })

  it('tarefa na fila não é acusada de "sem evidência" (não contada ≠ zero)', async () => {
    mockApi({ available: true, items: [item({ status: 'pending', deliverables: null })] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await screen.findByText('Painel de tarefas')
    expect(screen.queryByText('sem evidência')).toBeNull()
  })

  it('busca o detalhe só ao expandir, e uma vez só', async () => {
    const api = mockApi({ available: true, items: [item({ acceptance: ['passa no typecheck'] })] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await screen.findByText('Painel de tarefas')
    expect(api.tasksDetail).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Painel de tarefas'))
    await waitFor(() => expect(api.tasksDetail).toHaveBeenCalledTimes(1))
    expect(screen.getByText('passa no typecheck')).toBeTruthy()

    fireEvent.click(screen.getByText('Painel de tarefas'))
    fireEvent.click(screen.getByText('Painel de tarefas'))
    await waitFor(() => expect(api.tasksDetail).toHaveBeenCalledTimes(1))
  })

  it('detalhe que volta null não vira loop de busca', async () => {
    // O main devolve `null` quando a consulta falha. Usar a ausência de
    // resultado como guarda faria o efeito disparar a cada render.
    const api = mockApi({ available: true, items: [item()] }, null)
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await screen.findByText('Painel de tarefas')
    fireEvent.click(screen.getByText('Painel de tarefas'))
    await waitFor(() => expect(api.tasksDetail).toHaveBeenCalledTimes(1))

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.tasksDetail).toHaveBeenCalledTimes(1)
  })

  it('o filtro "só este projeto" manda (e tira) o cwd na consulta', async () => {
    const api = mockApi({ available: true, items: [] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await waitFor(() =>
      expect(api.tasksBoard).toHaveBeenCalledWith({ projectCwd: 'C:/proj', includeFinished: true })
    )
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(api.tasksBoard).toHaveBeenCalledWith({ includeFinished: true }))
  })

  it('sem projeto aberto, não afirma um recorte que não aplicou', async () => {
    const api = mockApi({ available: true, items: [] })
    render(<TasksBoard projectCwd="" busy={false} onOpenConversation={vi.fn()} />)

    await waitFor(() => expect(api.tasksBoard).toHaveBeenCalledWith({ includeFinished: true }))
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(false)
  })

  it('desligar um chip esconde aquele estado sem recarregar', async () => {
    const api = mockApi({ available: true, items: [item({ status: 'pending' })] })
    render(<TasksBoard projectCwd="C:/proj" busy={false} onOpenConversation={vi.fn()} />)

    await screen.findByText('Painel de tarefas')
    const calls = api.tasksBoard.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Na fila/ }))
    await waitFor(() => expect(screen.queryByText('Painel de tarefas')).toBeNull())
    expect(api.tasksBoard.mock.calls.length).toBe(calls)
  })
})

describe('describeLease', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z')

  it('nunca reivindicada não mostra lease nenhum', () => {
    expect(describeLease(item({ leaseExpiresAt: null }), now)).toBeNull()
  })

  it('lease no futuro conta quanto falta', () => {
    const lease = describeLease(
      item({ status: 'running', leaseExpiresAt: '2026-09-11T12:12:00.000Z' }),
      now
    )
    expect(lease).toEqual({ text: 'expira em 12min', stale: false })
  })

  it('em review, expirado é handoff normal — não é aviso', () => {
    // O repositório solta o lease EXPIRANDO a data; sem olhar o estado, isso
    // pareceria um executor morto em toda tarefa entregue.
    const lease = describeLease(
      item({ status: 'review', leaseExpiresAt: '2026-09-11T11:54:00.000Z' }),
      now
    )
    expect(lease).toEqual({ text: 'lease solto', stale: false })
  })

  it('em execução, expirado é a anomalia que merece aviso', () => {
    const lease = describeLease(
      item({ status: 'running', leaseExpiresAt: '2026-09-11T11:54:00.000Z' }),
      now
    )
    expect(lease?.stale).toBe(true)
    expect(lease?.text).toBe('lease expirado há 6min')
  })

  it('data ilegível não vira "NaN" na tela', () => {
    expect(describeLease(item({ leaseExpiresAt: 'nao-e-data' }), now)).toBeNull()
  })
})
