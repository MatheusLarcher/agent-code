import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightPaneTabs } from './RightPaneTabs'

afterEach(cleanup)

describe('RightPaneTabs', () => {
  it('só Navegador e Quadro: o Escritório saiu do painel da direita (é aba da área principal)', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <RightPaneTabs active="browser" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} />
    )
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Navegador', 'Quadro'])
    expect(screen.queryByRole('tab', { name: /Escritório/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Escritório 3D/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Quadro/ }))
    expect(onSelect).toHaveBeenCalledWith('board')
    rerender(<RightPaneTabs active="board" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} />)
    expect(screen.getByRole('tab', { name: /Quadro/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Navegador/ }).getAttribute('aria-selected')).toBe('false')
  })
})
