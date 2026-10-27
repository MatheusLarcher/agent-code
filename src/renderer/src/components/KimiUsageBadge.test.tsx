import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { KimiUsageBadge, windowLabel } from './KimiUsageBadge'

afterEach(() => cleanup())

describe('KimiUsageBadge', () => {
  it('mostra assinatura e a janela detectada, sem saldo nem custo', () => {
    render(<KimiUsageBadge contextWindow={262_144} />)
    expect(screen.getByText('Kimi · assinatura · janela 256K')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/US\$|saldo/)
  })

  it('sem janela detectada: só "Kimi · assinatura"', () => {
    render(<KimiUsageBadge />)
    expect(screen.getByText('Kimi · assinatura')).toBeTruthy()
  })

  it('rótulo da janela', () => {
    expect(windowLabel(262_144)).toBe('256K')
    expect(windowLabel(1_048_576)).toBe('1M')
  })
})
