import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AwaySummaryStrip } from './AwaySummaryStrip'
import type { AwaySummary } from './awaySummary'

const summary: AwaySummary = {
  projectKey: 'c:/proj',
  projectCwd: 'C:/proj',
  since: Date.UTC(2026, 9, 6, 9, 0),
  awayMs: 2 * 60 * 60_000,
  counts: { concluida: 3, espera: 1, falhou: 1 },
  entries: [
    { kind: 'concluida', cardId: 'c1', conversationId: 'conv-1', title: 'Tela de login', detail: null, at: 3 },
    { kind: 'concluida', cardId: 'c2', conversationId: 'conv-1', title: 'API', detail: null, at: 2 },
    { kind: 'concluida', cardId: 'c3', conversationId: 'conv-2', title: 'Testes', detail: null, at: 1 },
    { kind: 'espera', cardId: 'p1', conversationId: 'conv-1', title: 'Commitar', detail: 'Aguardando você', at: 2 },
    { kind: 'falhou', cardId: null, conversationId: 'conv-3', title: 'Prompt 2 de 3 — Checkout', detail: 'o agente caiu', at: 1 }
  ]
}

describe('AwaySummaryStrip', () => {
  it('a faixa: o texto, a lista ao clicar, o clique no item e o "ok"', () => {
    const onOpen = vi.fn()
    const onDismiss = vi.fn()
    render(<AwaySummaryStrip summary={summary} onOpen={onOpen} onDismiss={onDismiss} />)
    expect(screen.getByText('Desde que você saiu (há 2 h): 3 concluídas · 1 espera você · 1 falhou')).toBeTruthy()
    expect(screen.queryByText('Tela de login')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Desde que você saiu/ }))
    fireEvent.click(screen.getByText('Commitar'))
    expect(onOpen).toHaveBeenCalledWith(summary.entries[3])
    expect(screen.getByText('o agente caiu').closest('button')?.getAttribute('title')).toBe('Abrir a conversa')

    fireEvent.click(screen.getByRole('button', { name: 'ok' }))
    expect(onDismiss).toHaveBeenCalledWith('c:/proj')
  })

  it('sem resumo, nada aparece', () => {
    const { container } = render(<AwaySummaryStrip summary={null} onOpen={vi.fn()} onDismiss={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
