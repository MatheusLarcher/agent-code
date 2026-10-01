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
})
