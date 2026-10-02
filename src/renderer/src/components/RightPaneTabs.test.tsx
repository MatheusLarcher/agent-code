import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightPaneTabs } from './RightPaneTabs'

afterEach(cleanup)

describe('RightPaneTabs', () => {
  it('mostra a aba Escritório e troca para ela', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <RightPaneTabs active="browser" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} />
    )
    const tab = screen.getByRole('tab', { name: /Escritório/ })
    expect(tab.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(tab)
    expect(onSelect).toHaveBeenCalledWith('office')
    rerender(
      <RightPaneTabs active="office" onSelect={onSelect} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} />
    )
    expect(screen.getByRole('tab', { name: /Escritório/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Navegador/ }).getAttribute('aria-selected')).toBe('false')
  })

  it('botão Escritório 3D só aparece com o handler e o chama', () => {
    const onOpen = vi.fn()
    const { rerender } = render(
      <RightPaneTabs active="browser" onSelect={vi.fn()} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} />
    )
    expect(screen.queryByRole('button', { name: /Escritório 3D/ })).toBeNull()
    rerender(
      <RightPaneTabs active="browser" onSelect={vi.fn()} onCollapse={vi.fn()} liveAgents={0} browserTabs={0} boardProgress={null} onOpenOffice3D={onOpen} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Escritório 3D/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    // A aba 2D continua única.
    expect(screen.getAllByRole('tab', { name: /Escritório/ })).toHaveLength(1)
  })
})
