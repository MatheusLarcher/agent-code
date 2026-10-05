import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { OpenedPlanningDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { ProgressList } from './ProgressList'
import { ESTIMATIVA_INVALIDA_MSG, usePlanning } from './usePlanning'
import { CWD, SLUG, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(cleanup)

/** A lista ligada ao hook de verdade: o clique tem que chegar ao IPC. */
function Wired({ onFocus }: { onFocus: (id: string) => void }): JSX.Element | null {
  const { plan, toggleEtapa, setEstimativa } = usePlanning(CWD, SLUG)
  if (!plan) return null
  return (
    <ProgressList
      etapas={plan.roteiro.etapas}
      onToggle={(id) => void toggleEtapa(id)}
      onFocus={onFocus}
      onEstimate={(id, minutos) => void setEstimativa(id, minutos)}
    />
  )
}

function renderWired(onFocus = vi.fn(), plan?: OpenedPlanningDto) {
  const mock = mockPlanningApi(plan)
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

describe('ProgressList — estimativa', () => {
  const etapas = [
    { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida' as const, estimativa: 30 },
    { id: 'desenho', titulo: 'Desenhar a solução', status: 'em_andamento' as const, estimativa: 90 },
    { id: 'entrega', titulo: 'Entregar', status: 'pendente' as const }
  ]
  const texts = (sel: string): (string | null)[] => [...document.querySelectorAll(sel)].map((el) => el.textContent)

  it('lista: a estimativa formatada (ou "—") em cada etapa e o total com as sem estimativa no contador', () => {
    render(<ProgressList etapas={etapas} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(texts('.pl-step .pl-est')).toEqual(['30 min', '1 h 30 min', '—'])
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('1/3')
    expect(screen.getByTestId('pl-progress-estimate').textContent).toBe('Total: 2 h · 1 sem estimativa')
    // Sem onEstimate a estimativa só aparece: nada de botão de editar.
    expect(screen.queryByRole('button', { name: /^Estimativa de/ })).toBeNull()
  })

  it('contador: todas estimadas não fala de "sem estimativa"; nenhuma estimada diz isso', () => {
    const { rerender } = render(<ProgressList etapas={etapas.slice(0, 2)} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(screen.getByTestId('pl-progress-estimate').textContent).toBe('Total: 2 h')
    rerender(<ProgressList etapas={etapas.slice(2)} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(screen.getByTestId('pl-progress-estimate').textContent).toBe('Nenhuma etapa estimada')
    rerender(<ProgressList etapas={[]} onToggle={vi.fn()} onFocus={vi.fn()} />)
    expect(screen.queryByTestId('pl-progress-estimate')).toBeNull()
  })

  it('trilho: a estimativa embaixo de cada marca e o total embaixo do contador', () => {
    render(<ProgressList etapas={etapas} onToggle={vi.fn()} onFocus={vi.fn()} onEstimate={vi.fn()} collapsed />)
    expect(texts('.pl-rail-est')).toEqual(['30 min', '1 h 30 min', '—'])
    const total = screen.getByTestId('pl-rail-estimate')
    expect(total.textContent).toBe('2 h')
    expect(total.getAttribute('title')).toContain('1 sem estimativa')
    expect(screen.getByRole('button', { name: /Entregar: Pendente\. Estimativa: nenhuma/ })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull() // no trilho não se edita
  })

  it('editar: Enter grava via planningSaveRoteiro com o expectedRev e o contador acompanha', async () => {
    const { api } = renderWired()
    fireEvent.click(await screen.findByRole('button', { name: 'Estimativa de Desenhar a solução: nenhuma. Editar' }))
    const input = screen.getByRole('textbox', { name: 'Estimativa de Desenhar a solução, em minutos' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: ' 45 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(1))
    const req = (api.planningSaveRoteiro.mock.calls[0] as unknown as [{ expectedRev: number; roteiro: { etapas: { id: string; estimativa?: number }[] } }])[0]
    expect(req.expectedRev).toBe(3)
    expect(req.roteiro.etapas.map((e) => e.estimativa ?? null)).toEqual([null, 45, null])
    expect(texts('.pl-step .pl-est')).toEqual(['—', '45 min', '—'])
    expect(screen.getByTestId('pl-progress-estimate').textContent).toBe('Total: 45 min · 2 sem estimativa')
    // Quem editou pelo teclado continua na mesma etapa.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Estimativa de Desenhar a solução: 45 min. Editar' }))
  })

  it('editar: sair do campo grava; Esc cancela; vazio remove', async () => {
    const plan = makePlan()
    plan.roteiro.etapas[0] = { ...plan.roteiro.etapas[0], estimativa: 30 }
    const { api } = renderWired(vi.fn(), plan)
    const open = async (name: RegExp) => {
      fireEvent.click(await screen.findByRole('button', { name }))
      return screen.getByRole('textbox')
    }
    let input = await open(/^Estimativa de Entregar/)
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(api.planningSaveRoteiro).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Estimativa de Entregar: nenhuma. Editar' }))

    input = await open(/^Estimativa de Entregar/)
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.blur(input)
    await waitFor(() => expect(texts('.pl-step .pl-est')).toEqual(['30 min', '—', '2 h']))
    // Pelo blur o foco não volta para a estimativa: fica onde o usuário clicou.
    expect(document.activeElement?.classList.contains('pl-est')).toBe(false)

    input = await open(/^Estimativa de Levantar requisitos: 30 min/)
    expect((input as HTMLInputElement).value).toBe('30')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2))
    const req = (api.planningSaveRoteiro.mock.calls[1] as unknown as [{ roteiro: { etapas: object[] } }])[0]
    expect('estimativa' in req.roteiro.etapas[0]).toBe(false)
    await waitFor(() => expect(texts('.pl-step .pl-est')).toEqual(['—', '—', '2 h']))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Estimativa de Levantar requisitos: nenhuma. Editar' }))
  })

  it('editar: valor fora de 1..10000 ou não inteiro é recusado com toast "aviso" e não grava', async () => {
    const { api } = renderWired()
    for (const value of ['0', '10001', '1,5', 'abc']) {
      fireEvent.click(await screen.findByRole('button', { name: /^Estimativa de Entregar/ }))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    const toasts = await screen.findAllByText(ESTIMATIVA_INVALIDA_MSG)
    expect(toasts).toHaveLength(4)
    expect(toasts[0].closest('.toast')?.classList.contains('aviso')).toBe(true)
    expect(api.planningSaveRoteiro).not.toHaveBeenCalled()
    expect(texts('.pl-step .pl-est')).toEqual(['—', '—', '—'])
  })
})
