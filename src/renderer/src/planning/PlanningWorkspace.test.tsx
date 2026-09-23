import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { PlanningWorkspace } from './PlanningWorkspace'
import { CWD, SLUG, mockPlanningApi, stubResizeObserver } from './planningTestUtils'

beforeAll(stubResizeObserver)
afterEach(cleanup)

function renderWorkspace(managerModel: string | null) {
  return render(
    <UiProvider>
      <PlanningWorkspace
        projectCwd={CWD}
        slug={SLUG}
        chat={<div data-testid="chat-slot">chat do Agent Manager</div>}
        managerModel={managerModel}
        headerActions={<button type="button">Enviar para implementação</button>}
      />
    </UiProvider>
  )
}

describe('PlanningWorkspace', () => {
  it('monta a PlanningScreen do plano com o chat recebido no painel flutuante do Agent Manager', async () => {
    const { api } = mockPlanningApi()
    const { container } = renderWorkspace('claude-sonnet-5')
    expect(await screen.findByRole('heading', { name: 'Plano de teste' })).toBeTruthy()
    expect(api.planningOpen).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG })
    // O chat é o elemento recebido, dentro do painel flutuante da tela.
    const chat = screen.getByTestId('chat-slot')
    expect(chat.closest('.pl-chat-float')).toBe(screen.getByRole('region', { name: 'Agent Manager' }))
    // Ocupa o lugar do workspace normal.
    expect(container.querySelector('.workspace.planning-workspace .planning')).toBeTruthy()
  })

  it('mostra o modelo que o main anunciou para o Agent Manager e mantém as ações do cabeçalho', async () => {
    mockPlanningApi()
    renderWorkspace('claude-sonnet-5')
    await screen.findByRole('heading', { name: 'Plano de teste' })
    expect(screen.getByText('Modelo do Agent Manager')).toBeTruthy()
    expect(screen.getByTestId('pl-manager-model').textContent).toBe('Sonnet 5')
    expect(screen.getByRole('button', { name: 'Enviar para implementação' })).toBeTruthy()
  })

  it('antes de a sessão subir, não finge um modelo', async () => {
    mockPlanningApi()
    renderWorkspace(null)
    await screen.findByRole('heading', { name: 'Plano de teste' })
    expect(screen.getByTestId('pl-manager-model').textContent).toBe('definido ao iniciar')
  })
})
