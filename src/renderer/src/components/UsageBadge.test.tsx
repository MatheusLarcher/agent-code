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

  it('mostra a sessão de 5h com % e dica de reset', () => {
    const fiveHour: RateLimitStatus = {
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.42,
      resetsAt: Date.now() + 90 * 60_000 // daqui a 90min
    }
    const { getByText, container } = render(<UsageBadge limits={{ five_hour: fiveHour }} />)
    expect(getByText('Sessão 5h')).toBeTruthy()
    expect(getByText('42%')).toBeTruthy()
    // Horário de reset visível DO LADO da pílula, sem precisar de hover.
    // 90min arredonda pra "2h" (Math.round(90/60) = 2) — mesma regra do fmtResetsAt.
    const resetEl = container.querySelector('.usage-reset')
    expect(resetEl?.textContent).toBe('reseta em 2h')
    const pill = container.querySelector('.usage-pill')
    const title = pill?.getAttribute('title') ?? ''
    expect(title).toContain('reseta em')
    // O hover explica o CONCEITO (conta, não conversa; soma todos os apps),
    // não só o número — era essa a lacuna que o usuário apontou.
    expect(title).toMatch(/conta anthropic/i)
    expect(title).toMatch(/claude desktop/i)
  })

  it('sem resetsAt (ainda não informado): não mostra a dica de horário', () => {
    const limits: Record<string, RateLimitStatus> = {
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5 }
    }
    const { container } = render(<UsageBadge limits={limits} />)
    expect(container.querySelector('.usage-reset')).toBeNull()
  })

  it('mostra vários limites juntos, na ordem esperada (5h antes de semana)', () => {
    const limits: Record<string, RateLimitStatus> = {
      seven_day: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.1 },
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.9 }
    }
    const { container } = render(<UsageBadge limits={limits} />)
    const caps = Array.from(container.querySelectorAll('.ctx-bar-cap')).map((el) => el.textContent)
    expect(caps).toEqual(['Sessão 5h', 'Semana'])
  })

  it('utilization alta (≥95%) ou status "rejected" fica no nível crítico (mesma linguagem visual da barra de contexto)', () => {
    const limits: Record<string, RateLimitStatus> = {
      five_hour: { rateLimitType: 'five_hour', status: 'rejected', utilization: 1 }
    }
    const { container } = render(<UsageBadge limits={limits} />)
    expect(container.querySelector('.usage-pill.crit')).toBeTruthy()
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
    const providers = Array.from(container.querySelectorAll('.usage-provider')).map((el) => el.textContent)
    expect(providers).toEqual(['Claude', 'GPT'])
    const caps = Array.from(container.querySelectorAll('.ctx-bar-cap')).map((el) => el.textContent)
    expect(caps).toEqual(['Sessão 5h', 'Sessão 5h', 'Semana'])

    rerender(
      <UsageBadge
        limits={{ five_hour: claude, gpt_primary: gpt }}
        providers={{ claude: false, gpt: true }}
      />
    )
    expect(Array.from(container.querySelectorAll('.usage-provider')).map((el) => el.textContent)).toEqual(['GPT'])
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
