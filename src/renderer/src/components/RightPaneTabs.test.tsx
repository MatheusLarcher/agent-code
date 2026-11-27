import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightPaneTabs } from './RightPaneTabs'

afterEach(cleanup)

describe('RightPaneTabs', () => {
  it('três abas: Quadro, Scrum Master e Preview (o navegador antigo virou janela do Chrome)', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<RightPaneTabs active="board" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} boardProgress={null} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Quadro', 'Scrum Master', 'Preview'])
    expect(screen.queryByRole('tab', { name: /Navegador/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /Escritório/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /Quadro/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: /Scrum Master/ }))
    expect(onSelect).toHaveBeenCalledWith('scrum')
    rerender(<RightPaneTabs active="scrum" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} boardProgress={null} />)
    expect(screen.getByRole('tab', { name: /Scrum Master/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Quadro/ }).getAttribute('aria-selected')).toBe('false')

    fireEvent.click(screen.getByRole('tab', { name: /Preview/ }))
    expect(onSelect).toHaveBeenCalledWith('preview')
  })

  it('o progresso e o "espera você" ficam na aba Quadro, com a dica do app (sem title nativo)', () => {
    const { container } = render(
      <RightPaneTabs active="board" onSelect={vi.fn()} onCollapse={vi.fn()} liveAgents={2} boardProgress={{ done: 3, total: 7, awaiting: 1 }} />
    )
    const board = screen.getByRole('tab', { name: /Quadro/ })
    expect(board.className).toContain('live')
    expect(board.textContent).toBe('Quadro3/71')
    expect(container.querySelector('.pane-tab-count.awaiting')?.getAttribute('data-tip')).toBe('1 cartão espera você')
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('recolher o painel chama onCollapse', () => {
    const onCollapse = vi.fn()
    render(<RightPaneTabs active="scrum" onSelect={vi.fn()} onCollapse={onCollapse} liveAgents={0} boardProgress={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recolher painel' }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })
})
