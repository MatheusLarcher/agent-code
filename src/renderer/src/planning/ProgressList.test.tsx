import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { ProgressList } from './ProgressList'
import { usePlanning } from './usePlanning'
import { CWD, SLUG, mockPlanningApi } from './planningTestUtils'

afterEach(cleanup)

/** A lista ligada ao hook de verdade: o clique tem que chegar ao IPC. */
function Wired({ onFocus }: { onFocus: (id: string) => void }): JSX.Element | null {
  const { plan, toggleEtapa } = usePlanning(CWD, SLUG)
  if (!plan) return null
  return <ProgressList etapas={plan.roteiro.etapas} onToggle={(id) => void toggleEtapa(id)} onFocus={onFocus} />
}

function renderWired(onFocus = vi.fn()) {
  const mock = mockPlanningApi()
  render(
    <UiProvider>
      <Wired onFocus={onFocus} />
    </UiProvider>
  )
  return { ...mock, onFocus }
}

describe('ProgressList', () => {
  it('lista as etapas na ordem com o contador concluídas/total', async () => {
    renderWired()
    expect(await screen.findByText('Levantar requisitos')).toBeTruthy()
    const titles = [...document.querySelectorAll('.pl-step-title')].map((el) => el.textContent)
    expect(titles).toEqual(['Levantar requisitos', 'Desenhar a solução', 'Entregar'])
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('1/3')
  })

  it('clicar na marca muda o status e chama planningSaveRoteiro', async () => {
    const { api } = renderWired()
    const check = await screen.findByRole('button', { name: /Desenhar a solução: Pendente/ })
    fireEvent.click(check)
    await waitFor(() => expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(1))
    const req = (api.planningSaveRoteiro.mock.calls[0] as unknown as [{ projectCwd: string; slug: string; roteiro: { etapas: { id: string; status: string }[] } }])[0]
    expect(req.projectCwd).toBe(CWD)
    expect(req.slug).toBe(SLUG)
    expect(req.roteiro.etapas.find((e) => e.id === 'desenho')?.status).toBe('em_andamento')
    // O clique responde na hora (otimista), sem esperar recarregar.
    expect(await screen.findByRole('button', { name: /Desenhar a solução: Em andamento/ })).toBeTruthy()
  })

  it('concluir uma etapa atualiza o contador', async () => {
    renderWired()
    fireEvent.click(await screen.findByRole('button', { name: /Entregar: Em andamento/ }))
    await waitFor(() => expect(screen.getByTestId('pl-progress-count').textContent).toBe('2/3'))
  })

  it('clicar no nome pede para centralizar o canvas na etapa', async () => {
    const { onFocus, api } = renderWired()
    fireEvent.click(await screen.findByText('Entregar'))
    expect(onFocus).toHaveBeenCalledWith('entrega')
    expect(api.planningSaveRoteiro).not.toHaveBeenCalled()
  })

  it('roteiro vazio mostra 0/0 e uma orientação', () => {
    render(<ProgressList etapas={[]} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('0/0')
    expect(screen.getByText(/Nenhuma etapa ainda/)).toBeTruthy()
  })
})

describe('ProgressList — recolhido', () => {
  const etapas = [
    { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida' as const },
    { id: 'desenho', titulo: 'Desenhar a solução', status: 'em_andamento' as const },
    { id: 'entrega', titulo: 'Entregar', status: 'pendente' as const }
  ]

  it('o botão de recolher só aparece com onToggleCollapsed', () => {
    const onToggleCollapsed = vi.fn()
    const { rerender } = render(<ProgressList etapas={etapas} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Recolher o roteiro' })).toBeNull()
    rerender(<ProgressList etapas={etapas} onToggle={vi.fn()} onFocus={vi.fn()} onToggleCollapsed={onToggleCollapsed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recolher o roteiro' }))
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1)
  })

  it('trilho: contador, uma marca por etapa (clicar centraliza) e o botão de expandir', () => {
    const onFocus = vi.fn()
    const onToggleCollapsed = vi.fn()
    render(
      <ProgressList etapas={etapas} onToggle={vi.fn()} onFocus={onFocus} collapsed onToggleCollapsed={onToggleCollapsed} />
    )
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('1/3')
    expect(document.querySelector('.pl-step-title')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Desenhar a solução: Em andamento/ }))
    expect(onFocus).toHaveBeenCalledWith('desenho')
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar o roteiro' }))
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1)
  })
})
