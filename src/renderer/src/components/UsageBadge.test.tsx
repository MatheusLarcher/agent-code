import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { UsageBadge } from './UsageBadge'
import type { RateLimitStatus } from '@shared/ipc'

afterEach(cleanup)

describe('UsageBadge — uso da conta (5h/semana), separado da conversa', () => {
  it('sem nenhum evento ainda (ex.: conta por API key): não renderiza nada', () => {
    const { container } = render(<UsageBadge limits={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('barra fechada é só o anel; o hover traz % e reset de cada janela', () => {
    const fiveHour: RateLimitStatus = {
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.42,
      resetsAt: Date.now() + 90 * 60_000 // daqui a 90min
    }
    const { container } = render(<UsageBadge limits={{ five_hour: fiveHour }} />)
    expect(container.querySelector('.usage-pill')).toBeNull()
    const ring = container.querySelector('.usage-ring')
    expect(ring?.getAttribute('aria-label')).toBe('Claude: Sessão 5h 42%')
    // 90min arredonda pra "2h" (Math.round(90/60) = 2) — mesma regra do fmtResetsAt.
    expect(container.querySelector('.usage-ring-tip')?.textContent).toContain('42%reseta em 2h')
  })

  it('anel externo = sessão 5h, interno = semana', () => {
    const limits: Record<string, RateLimitStatus> = {
      seven_day: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.1 },
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.9 }
    }
    const { container } = render(<UsageBadge limits={limits} />)
    const arcs = Array.from(container.querySelectorAll('.usage-ring-arc'))
    expect(arcs.map((a) => [a.getAttribute('r'), a.getAttribute('stroke-dasharray')])).toEqual([
      ['12', '90 100'],
      ['8', '10 100']
    ])
    const rows = Array.from(container.querySelectorAll('.usage-ring-row span')).map((el) => el.textContent)
    expect(rows).toEqual(['Sessão 5h', 'Semana'])
  })

  it('utilization alta (≥95%) ou status "rejected" fica no nível crítico', () => {
    const limits: Record<string, RateLimitStatus> = {
      five_hour: { rateLimitType: 'five_hour', status: 'rejected', utilization: 1 }
    }
    const { container } = render(<UsageBadge limits={limits} />)
    expect(container.querySelector('.usage-ring.crit .usage-ring-arc.crit')).toBeTruthy()
  })

  it('no painel aberto, a pílula explica o conceito e mostra o reset', () => {
    const limits: Record<string, RateLimitStatus> = {
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5, resetsAt: Date.now() + 90 * 60_000 }
    }
    const { container, getByLabelText } = render(<UsageBadge limits={limits} />)
    fireEvent.click(getByLabelText('Detalhar consumo'))
    expect(container.querySelector('.usage-popover .usage-reset')?.textContent).toBe('reseta em 2h')
    const title = container.querySelector('.usage-popover .usage-pill')?.getAttribute('title') ?? ''
    expect(title).toMatch(/conta anthropic/i)
    expect(title).toMatch(/claude desktop/i)
  })
})

describe('UsageBadge — Claude e GPT lado a lado', () => {
  const claude: RateLimitStatus = { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.3 }
  const gpt: RateLimitStatus = { rateLimitType: 'gpt_primary', status: 'allowed', utilization: 0.6, windowMinutes: 300 }
  const gptWeek: RateLimitStatus = { rateLimitType: 'gpt_secondary', status: 'allowed', utilization: 0.1, windowMinutes: 10080 }

  it('agrupa por assinatura, rotula a janela GPT pelo tamanho real e só mostra as marcadas', () => {
    const { container, rerender } = render(
      <UsageBadge limits={{ five_hour: claude, gpt_primary: gpt, gpt_secondary: gptWeek }} />
    )
    const rings = () => Array.from(container.querySelectorAll('.usage-ring')).map((el) => el.getAttribute('aria-label'))
    expect(rings()).toEqual(['Claude: Sessão 5h 30%', 'GPT: Sessão 5h 60%, Semana 10%'])

    rerender(
      <UsageBadge
        limits={{ five_hour: claude, gpt_primary: gpt }}
        providers={{ claude: false, gpt: true }}
      />
    )
    expect(rings()).toEqual(['GPT: Sessão 5h 60%'])
  })

  it('o chevron abre o painel com as duas assinaturas e o toggle "mostrar na barra"', () => {
    const onChange = vi.fn()
    const { container, getByLabelText } = render(
      <UsageBadge limits={{ five_hour: claude }} providers={{ claude: true, gpt: true }} onProvidersChange={onChange} />
    )
    expect(container.querySelector('.usage-popover')).toBeNull()
    fireEvent.click(getByLabelText('Detalhar consumo'))
    const pop = container.querySelector('.usage-popover')
    expect(pop).toBeTruthy()
    // GPT sem dados ainda aparece como seção vazia, não some.
    expect(pop?.textContent).toMatch(/Sem dados ainda/)
    const boxes = pop!.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    fireEvent.click(boxes[1])
    expect(onChange).toHaveBeenCalledWith({ claude: true, gpt: false })
  })
})
