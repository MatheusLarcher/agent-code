/** Configurações: o card de conexão muda por ambiente — "Filiais" no APK, "Conexão" no navegador. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { nav } from '../app/runtime'
import { resetApp, setApk, twoPcs } from '../app/testSupport'
import { Settings } from './Settings'

const cardTitles = (container: HTMLElement): string[] => Array.from(container.querySelectorAll('.cfg-card-title')).map((el) => el.textContent ?? '')

describe('Settings', () => {
  beforeEach(() => {
    resetApp()
    nav.set({ settingsOpen: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('no APK o card "Conexão" vira "Filiais"', () => {
    setApk(true)
    twoPcs()
    const { container } = render(<Settings />)
    const titles = cardTitles(container)
    expect(titles).toContain('Filiais')
    expect(titles).not.toContain('Conexão')
    expect(container.querySelectorAll('.cfg-filial')).toHaveLength(2)
  })

  it('no navegador continua o card "Conexão" de hoje', () => {
    const { container } = render(<Settings />)
    const titles = cardTitles(container)
    expect(titles).toContain('Conexão')
    expect(titles).not.toContain('Filiais')
    expect(container.querySelector('.cfg-filial')).toBeNull()
  })

  it('fechado, não renderiza nada', () => {
    nav.set({ settingsOpen: false })
    const { container } = render(<Settings />)
    expect(container.firstChild).toBeNull()
  })
})
