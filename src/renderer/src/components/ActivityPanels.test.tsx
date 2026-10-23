import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundTasksCard, InterruptQueueWarning } from './ActivityPanels'

describe('activity panels', () => {
  it('cada linha para só a sua tarefa; o botão espera a resposta e não dispara de novo', async () => {
    let finish: () => void = () => undefined
    const onStop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    render(
      <BackgroundTasksCard
        tasks={[
          { id: 'b1', type: 'local_bash', description: 'npm run dev' },
          { id: 'a2', type: 'local_agent', description: 'Revisar o login' }
        ]}
        onStop={onStop}
      />
    )
    const stopDev = screen.getByLabelText('Parar a tarefa npm run dev') as HTMLButtonElement
    expect(stopDev.getAttribute('data-tip')).toBe('Parar esta tarefa')
    fireEvent.click(stopDev)
    fireEvent.click(stopDev)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith('b1')
    expect(stopDev.disabled).toBe(true)
    expect((screen.getByLabelText('Parar a tarefa Revisar o login') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => finish())
    expect(stopDev.disabled).toBe(false)
  })

  it('sem onStop, nenhuma linha tem botão de parar', () => {
    render(<BackgroundTasksCard tasks={[{ id: 'b1', type: 'local_bash', description: 'npm run dev' }]} />)
    expect(screen.queryByLabelText('Parar a tarefa npm run dev')).toBeNull()
  })

  it('renders the full current background task snapshot and handles empty state', () => {
    const { rerender } = render(
      <BackgroundTasksCard tasks={[{ id: '1', type: 'bash', description: 'Servidor de preview' }]} />
    )
    expect(screen.getByText('Tarefas em segundo plano (1)')).toBeTruthy()
    expect(screen.getByText('Servidor de preview')).toBeTruthy()
    rerender(<BackgroundTasksCard tasks={[]} />)
    expect(screen.queryByLabelText('Tarefas em segundo plano')).toBeNull()
  })

  it('shows which messages will still run after Stop', () => {
    render(
      <InterruptQueueWarning
        messages={[{ messageId: 'uuid-1', text: 'publique o relatório quando terminar' }]}
      />
    )
    expect(screen.getByText('O Stop não cancelou tudo.')).toBeTruthy()
    expect(screen.getByText('publique o relatório quando terminar')).toBeTruthy()
  })
})
