// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ClaudeAccountView, UsageWindow } from '@shared/claudeAccounts'
import { AccountsUsageBadge } from './AccountsUsageBadge'

/**
 * O print da barra do topo: a API de uso passou a mandar `five_hour: null` (só os
 * 7 dias). A janela de 5 h sem número não pode virar 0% usado / 100% livre.
 */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = Date.now()
const WEEK = NOW + 3 * 86_400_000

function account(id: string, weekUsed: number, five?: UsageWindow): ClaudeAccountView {
  return {
    id,
    label: id,
    email: `${id}@x.dev`,
    plan: 'max',
    rateLimitTier: null,
    status: 'expired', // não consulta ao abrir: o painel mostra a leitura guardada
    isDefault: id === 'Pessoal',
    usage: { at: NOW - 30_000, windows: { ...(five ? { five_hour: five } : {}), seven_day: { utilization: weekUsed, resetsAt: WEEK } } }
  }
}

function open(accounts: ClaudeAccountView[]) {
  Object.assign(window, { api: { claudeAccountsUsage: vi.fn() } })
  const utils = render(
    <AccountsUsageBadge
      accounts={accounts}
      activeAccountId="Pessoal"
      canUseInConversation
      gptLimits={[]}
      shownInBar={{}}
      onShownInBarChange={vi.fn()}
      onUseAccount={vi.fn()}
      onRelogin={vi.fn()}
      onManage={vi.fn()}
    />
  )
  const ring = utils.container.querySelector('.usage-ring')
  fireEvent.click(screen.getByLabelText('Detalhar consumo'))
  const sections = [...utils.container.querySelectorAll('.usage-popover-section')].slice(0, accounts.length)
  return { ring, sections }
}

describe('barra do topo sem a janela de 5 h na leitura (o print)', () => {
  it('five_hour ausente ou só com o horário → "—" e "sem leitura"; os 7 dias continuam', () => {
    const { ring, sections } = open([
      account('Pessoal', 38),
      account('Negócios', 39),
      account('Tecnologia', 40, { utilization: null, resetsAt: NOW + 3_600_000 }),
      account('DEV', 65)
    ])
    expect(ring?.getAttribute('aria-label')).toBe('Claude · Pessoal · janela de 5 h sem leitura: Semana 38%')
    expect(ring?.textContent).not.toContain('100%')
    expect(ring?.textContent).not.toContain('Sessão 5h')
    sections.forEach((s, i) => {
      const five = s.querySelector('[aria-label="Sessão 5h: janela de 5 h sem leitura"]')
      expect(five?.querySelector('.ctx-bar-val')?.textContent).toBe('—')
      expect(five?.getAttribute('title')).toBe('Sessão 5h: janela de 5 h sem leitura.')
      expect(s.textContent).not.toContain('100%')
      expect(s.textContent).not.toMatch(/Sessão 5h\d/)
      expect(s.textContent).toContain(`Semana${[38, 39, 40, 65][i]}%`)
    })
  })

  it('uso real de 5 h mostra o % real', () => {
    const { ring, sections } = open([account('Pessoal', 38, { utilization: 62, resetsAt: NOW + 3_600_000 })])
    expect(ring?.getAttribute('aria-label')).toBe('Claude · Pessoal: Sessão 5h 62%, Semana 38%')
    expect(sections[0].textContent).toContain('Sessão 5h62%')
    expect(sections[0].textContent).not.toContain('—')
  })

  it('janela de 5 h realmente em 0% → 0% usado (100% livre), não "sem leitura"', () => {
    const { ring, sections } = open([account('Pessoal', 38, { utilization: 0, resetsAt: null })])
    expect(ring?.getAttribute('aria-label')).toBe('Claude · Pessoal: Sessão 5h 0%, Semana 38%')
    expect(sections[0].textContent).toContain('Sessão 5h0%')
    expect(sections[0].textContent).not.toContain('sem leitura')
    expect(sections[0].querySelector('.ctx-bar-fill')?.getAttribute('style')).toContain('width: 0%')
  })
})
