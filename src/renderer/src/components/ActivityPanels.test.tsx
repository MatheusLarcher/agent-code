import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BackgroundTasksCard, InterruptQueueWarning } from './ActivityPanels'

describe('activity panels', () => {
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
