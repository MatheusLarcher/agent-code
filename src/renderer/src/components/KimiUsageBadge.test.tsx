import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { KimiUsageBadge, windowLabel } from './KimiUsageBadge'

afterEach(() => cleanup())

const none = async (): Promise<null> => null

describe('KimiUsageBadge', () => {
  it('sem leitura do uso: assinatura e a janela detectada, sem saldo nem custo', async () => {
    render(<KimiUsageBadge contextWindow={262_144} load={none} />)
    expect(await screen.findByText('Kimi · assinatura · janela 256K')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/US\$|saldo/)
  })

  it('sem janela detectada: só "Kimi · assinatura"', async () => {
    render(<KimiUsageBadge load={none} />)
    expect(await screen.findByText('Kimi · assinatura')).toBeTruthy()
  })

  it('com uso: anel duplo com 5h e mês', async () => {
    const load = async () => ({ session: { usedRatio: 0.42, resetsAt: Date.now() + 3 * 3_600_000 }, month: { usedRatio: 0.9 } })
    render(<KimiUsageBadge load={load} />)
    const ring = await screen.findByRole('img', { name: 'Kimi: Sessão 5h 42%, Mês 90%' })
    expect(ring.className).toContain('warn')
    expect(document.body.textContent).toMatch(/reseta em 3h/)
  })

  it('rótulo da janela', () => {
    expect(windowLabel(262_144)).toBe('256K')
    expect(windowLabel(1_048_576)).toBe('1M')
  })
})
