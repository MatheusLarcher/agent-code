// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClaudeAccountView, UsageWindow } from '@shared/claudeAccounts'
import type { Conversation } from '../types'
import { accountBank, type AccountFeed } from './accountBank'
import { panelSig, panelSubline } from './energyPanelPaint'
import { officePower } from './power'
import { SessionBattery } from './SessionBattery'

/**
 * O print do quadro de energia: a API de uso passou a mandar `five_hour: null`
 * (só os 7 dias). As 4 contas apareciam 100% e "janela de 5 h ainda sem uso" —
 * inclusive a em destaque com 1 agente trabalhando.
 */
const NOW = new Date(2026, 10, 25, 11, 30).getTime()
const WEEK = NOW + 3 * 86_400_000

function account(id: string, weekUsed: number, five?: UsageWindow): ClaudeAccountView {
  return {
    id,
    label: id,
    email: `${id}@x.dev`,
    plan: 'max',
    rateLimitTier: null,
    status: 'connected',
    isDefault: id === 'Pessoal',
    usage: { at: NOW - 30_000, windows: { ...(five ? { five_hour: five } : {}), seven_day: { utilization: weekUsed, resetsAt: WEEK } } }
  }
}

const conv = (id: string, accountId: string): Conversation => ({ id, model: 'claude-opus-4-5', claudeAccountId: accountId }) as unknown as Conversation

function printFeed(): AccountFeed {
  const accounts = [account('Pessoal', 38), account('Empresa', 39), account('Reserva', 40), account('Extra', 65)]
  return { claudeAccounts: accounts, conversations: [conv('1', 'Pessoal')], busyIds: new Set(['1']), activeId: '1' }
}

describe('quadro de energia sem a janela de 5 h na leitura (o print)', () => {
  it('banco: sem five_hour não é 100% — fica sem leitura de 5 h, com os 7 dias e a hora', () => {
    const bank = accountBank(printFeed(), NOW)
    expect(bank.map((b) => [b.id, b.pct, b.level, b.weekUsed])).toEqual([
      ['Pessoal', null, null, 38],
      ['Empresa', null, null, 39],
      ['Reserva', null, null, 40],
      ['Extra', null, null, 65]
    ])
    expect(bank[0].at).toBe(NOW - 30_000)
  })

  it('five_hour com número nulo (só o horário) também é sem leitura, não 0% usado', () => {
    const f = { ...printFeed(), claudeAccounts: [account('Pessoal', 38, { utilization: null, resetsAt: NOW + 3_600_000 })] }
    expect(accountBank(f, NOW)[0].pct).toBeNull()
  })

  it('conta com uso real de 5 h mostra o % real; janela zerada (0%) continua "ainda sem uso"', () => {
    const f = { ...printFeed(), claudeAccounts: [account('Pessoal', 38, { utilization: 62, resetsAt: NOW + 3_600_000 }), account('Reserva', 40, { utilization: 0, resetsAt: null })] }
    const [used, idle] = accountBank(f, NOW)
    expect([used.pct, used.level, used.resetsAt]).toEqual([38, 'economia', NOW + 3_600_000])
    expect([idle.pct, idle.resetsAt]).toEqual([100, null])
  })

  it('tela: a linha diz que a janela de 5 h está sem leitura e mantém agentes e 7 dias; doca com "—"', () => {
    const power = officePower(printFeed(), NOW)!
    render(<SessionBattery power={power} now={NOW} />)
    const pill = screen.getByTestId('o3d-session-battery')
    expect(pill.querySelector('.o3d-bank-pct')?.textContent).toBe('—')
    expect(pill.querySelector('button')?.title).toContain('sem leitura')
    for (const spare of screen.getAllByTestId('o3d-bank-spare')) {
      expect(spare.textContent?.startsWith('—')).toBe(true)
      expect(spare.title).toContain('janela de 5 h sem leitura')
    }
    fireEvent.click(screen.getByTestId('o3d-session-battery').querySelector('button')!)
    const rows = screen.getAllByTestId('o3d-bank-row')
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.textContent).not.toContain('100%')
      expect(row.textContent).not.toContain('ainda sem uso')
      expect(row.textContent).toContain('janela de 5 h sem leitura')
    }
    expect(rows[0].textContent).toContain('em destaque')
    expect(rows[0].textContent).toContain('1 agente trabalhando')
    expect(rows[0].textContent).toContain('7 dias: 38% usados')
    expect(rows[3].textContent).toContain('7 dias: 65% usados')
  })
})

describe('prédio e quadro da parede sem a janela de 5 h', () => {
  const withFeatured = (a: ClaudeAccountView): AccountFeed => ({ ...printFeed(), claudeAccounts: [a] })

  it('energia: five_hour null ou só com o horário → "sem leitura" (luz cheia, nunca 100% na tela)', () => {
    for (const f of [printFeed(), withFeatured(account('Pessoal', 38, { utilization: null, resetsAt: NOW + 3_600_000 }))]) {
      const p = officePower(f, NOW)!
      expect([p.accountId, p.unread, p.level]).toEqual(['Pessoal', true, 'cheia'])
      expect(panelSubline(p, NOW)).toBe('janela de 5 h sem leitura')
      expect(panelSig(p, [], NOW)).toContain('|—|')
    }
  })

  it('conta nunca lida → "ainda sem leitura"', () => {
    const p = officePower(withFeatured({ ...account('Pessoal', 0), usage: null }), NOW)!
    expect(p.unread).toBe(true)
    expect(panelSubline(p, NOW)).toBe('ainda sem leitura')
  })

  it('janela real em 0% → "janela de 5 h ainda sem uso"; uso real → o % real', () => {
    const idle = officePower(withFeatured(account('Pessoal', 38, { utilization: 0, resetsAt: null })), NOW)!
    expect([idle.unread, idle.pct]).toEqual([undefined, 100])
    expect(panelSubline(idle, NOW)).toBe('janela de 5 h ainda sem uso')
    const used = officePower(withFeatured(account('Pessoal', 38, { utilization: 62, resetsAt: NOW + 3_600_000 })), NOW)!
    expect([used.unread, used.pct, used.level]).toEqual([undefined, 38, 'economia'])
    expect(panelSubline(used, NOW)).toMatch(/^Modo economia · recarrega às /)
  })
})
