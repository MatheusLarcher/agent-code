// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BankAccount } from './accountBank'
import type { OfficePower } from './power'
import { flowSeconds, SessionBattery, SWAP_MS } from './SessionBattery'

const NOW = new Date(2026, 9, 6, 21, 0).getTime()

const acc = (id: string, name: string, pct: number | null, o: Partial<BankAccount> = {}): BankAccount => ({
  id,
  name,
  email: `${id}@x.dev`,
  pct,
  level: pct === null ? null : pct < 1 ? 'apagao' : pct < 20 ? 'alerta' : pct < 50 ? 'economia' : 'cheia',
  resetsAt: NOW + 2 * 3_600_000 + 40 * 60_000,
  weekUsed: 34,
  busy: 0,
  at: NOW - 30_000,
  ...o
})

const BANK = [acc('p', 'Pessoal', 72, { busy: 3 }), acc('e', 'Empresa', 18, { at: NOW - 4 * 60_000, busy: 1 }), acc('r', 'Reserva', 100, { resetsAt: null, busy: 0, at: NOW - 12 * 60_000 })]

function power(o: Partial<OfficePower> = {}): OfficePower {
  return { pct: 72, level: 'cheia', resetsAt: NOW + 2 * 3_600_000 + 40 * 60_000, drainPerMin: 0.8, rejected: false, samples: [], accountId: 'p', bank: BANK, ...o }
}

describe('SessionBattery — o banco de baterias', () => {
  afterEach(() => vi.useRealTimers())

  it('tomada: a conta em destaque com as 10 células, a %, o nome e a recarga; cheia sem o nível; o cabo corre com agente nela', () => {
    render(<SessionBattery power={power()} now={NOW} />)
    const b = screen.getByTestId('o3d-session-battery')
    expect(b.textContent).toContain('72%')
    expect(b.textContent).toContain('Pessoal')
    expect(b.textContent).toContain('recarrega às 23:40')
    expect(b.textContent).not.toContain('Energia cheia')
    expect(b.querySelectorAll('.o3d-bank-cell b.on')).toHaveLength(7)
    expect(b.classList.contains('flowing')).toBe(true)
    const btn = screen.getByTestId('o3d-session-battery').querySelector('button')!
    expect(btn.title).toBe('Energia do escritório: 72% restantes da janela de 5 h da conta Pessoal (28% usados).')
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('doca: as outras conectadas com a %, o ponto de "em uso" e a ordem do usuário', () => {
    render(<SessionBattery power={power()} now={NOW} />)
    expect(screen.getByRole('group', { name: 'Outras contas conectadas' })).toBeTruthy()
    const spares = screen.getAllByTestId('o3d-bank-spare')
    expect(spares.map((s) => s.textContent)).toEqual(['18%Empresa', '100%Reserva'])
    expect(spares[0].classList.contains('busy')).toBe(true)
    expect(spares[1].classList.contains('busy')).toBe(false)
  })

  it('economia, bateria fraca e apagão (o cabo apaga no apagão)', () => {
    const { rerender } = render(<SessionBattery power={power({ pct: 42, level: 'economia' })} now={NOW} />)
    expect(screen.getByTestId('o3d-session-battery').textContent).toContain('Modo economia')
    rerender(<SessionBattery power={power({ pct: 9, level: 'alerta' })} now={NOW} />)
    expect(screen.getByTestId('o3d-session-battery').textContent).toContain('Bateria fraca')
    rerender(<SessionBattery power={power({ pct: 0, level: 'apagao', rejected: true })} now={NOW} />)
    const b = screen.getByTestId('o3d-session-battery')
    expect(b.textContent).toContain('Apagão — recarrega às 23:40')
    expect(b.dataset.level).toBe('apagao')
    expect(b.classList.contains('flowing')).toBe(false)
  })

  it('quadro de energia: abre no clique (e no hover), uma linha por conta; Esc e clique fora fecham', () => {
    render(<SessionBattery power={power()} now={NOW} />)
    const btn = screen.getByTestId('o3d-session-battery').querySelector('button')!
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const rows = screen.getAllByTestId('o3d-bank-row')
    expect(rows.map((r) => r.querySelector('.o3d-bank-row-name')!.firstChild!.textContent)).toEqual(['Pessoal', 'Empresa', 'Reserva'])
    expect(rows[0].textContent).toContain('em destaque')
    expect(rows[0].textContent).toContain('3 agentes trabalhando')
    expect(rows[1].textContent).toContain('em uso')
    expect(rows[1].textContent).toContain('atualizado há 4 min')
    expect(rows[2].textContent).toContain('parada')
    expect(rows[2].textContent).toContain('janela de 5 h ainda sem uso')
    expect(rows[2].textContent).toContain('7 dias: 34% usados')
    expect(screen.getByRole('dialog', { name: 'Quadro de energia' }).textContent).toContain('As contas paradas são relidas a cada 5 min, sem gastar limite.')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Quadro de energia' })).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('o3d-session-battery'))
    expect(screen.getByRole('dialog', { name: 'Quadro de energia' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Quadro de energia' })).toBeNull()
  })

  it('uma conta só: sem doca; conta sem leitura: pilha tracejada e "—"', () => {
    const { rerender } = render(<SessionBattery power={power({ bank: [BANK[0]] })} now={NOW} />)
    expect(screen.queryByRole('group', { name: 'Outras contas conectadas' })).toBeNull()
    rerender(<SessionBattery power={power({ bank: [BANK[0], acc('n', 'Nova', null, { at: null })] })} now={NOW} />)
    const spare = screen.getByTestId('o3d-bank-spare')
    expect(spare.classList.contains('none')).toBe(true)
    expect(spare.textContent).toBe('—Nova')
  })

  it('troca de conta em destaque: a animação de troca roda e acaba', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SessionBattery power={power()} now={NOW} />)
    const b = (): HTMLElement => screen.getByTestId('o3d-session-battery')
    expect(b().classList.contains('swap')).toBe(false)
    rerender(<SessionBattery power={power({ accountId: 'r', pct: 100 })} now={NOW} />)
    expect(b().classList.contains('swap')).toBe(true)
    expect(b().textContent).toContain('Reserva')
    expect(screen.getAllByTestId('o3d-bank-spare').map((s) => s.textContent)).toEqual(['72%Pessoal', '18%Empresa'])
    act(() => void vi.advanceTimersByTime(SWAP_MS + 10))
    expect(b().classList.contains('swap')).toBe(false)
  })

  it('o pulso do cabo acelera com o consumo', () => {
    expect(flowSeconds(0, 1)).toBeGreaterThan(flowSeconds(2, 1))
    expect(flowSeconds(100, 9)).toBe(0.45)
  })
})
