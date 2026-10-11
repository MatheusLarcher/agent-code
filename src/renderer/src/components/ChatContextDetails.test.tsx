import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ContextTurnDetail } from '@shared/contextSnapshot'
import { ChatContextDetails } from './ChatContextDetails'
import type { UIMessage } from '../types'

const detail: ContextTurnDetail = {
  convId: 'a', turnId: 't1', pc: 'PC de teste', startedAt: 1700000000000,
  model: 'claude-opus-5-5', models: [], provider: 'claude', request: 'Pedido',
  blockCount: 1, totalBytes: 12, memoriesSent: [], complete: true,
  blocks: [{ kind: 'user-request', label: 'Pedido', source: 'prompt', hash: 'abc', bytes: 12, at: 1, text: 'Pedido real' }],
  usage: { detail: 'full', at: 1, totalTokens: 48000, maxTokens: 1000000, percentage: 4.8,
    categories: [{ name: 'Messages', kind: 'used', tokens: 40000 }],
    skills: [{ name: 'frontend-design', source: 'user', tokens: 125 }] }, secrets: []
}
let fail: boolean
beforeEach(() => {
  fail = false
  Object.assign(window, { api: {
    listContextTurns: vi.fn(async () => { if (fail) throw new Error('offline'); return [detail] }),
    readContextTurn: vi.fn(async () => detail),
    onContextTurnsChanged: vi.fn(() => () => undefined)
  } })
})
afterEach(cleanup)

describe('detalhes de contexto do chat', () => {
  it('mantém compactação após ajuste injected no turno original', async () => {
    const messages: UIMessage[] = [
      { kind: 'user', id: 'u1', text: 'Pedido' },
      { kind: 'assistant-text', id: 'a', text: 'parcial', final: false, turnIds: ['t1'] },
      { kind: 'user', id: 'ajuste', text: 'ajuste', injected: true },
      { kind: 'status', id: 'compact', text: 'Contexto compactado neste turno' }
    ]
    render(<ChatContextDetails convId="a" messages={messages} />)
    await screen.findByText('Contexto compactado neste turno')
    expect(screen.queryByText(/Compactação não registrada/)).toBeNull()
  })
  it('usa a janela medida do escritório e mostra as fontes reais', async () => {
    render(<ChatContextDetails convId="a" messages={[]} />)
    await screen.findByText('48.000 / 1.000.000 tokens')
    expect(screen.getByText('Registro completo')).toBeTruthy()
    expect(screen.getByText('Pedido real')).toBeTruthy()
    expect(screen.getByText(/frontend-design/)).toBeTruthy()
    expect(screen.getByText(/Compactação não registrada/)).toBeTruthy()
  })
  it('não inventa janela ou medição quando o SDK não informou', async () => {
    window.api.readContextTurn = vi.fn(async () => ({ ...detail, usage: null }))
    render(<ChatContextDetails convId="a" messages={[]} />)
    await screen.findByText(/Janela não informada/)
    expect(screen.getByText(/Estimativa dos blocos enviados/)).toBeTruthy()
    expect(screen.queryByText(/1.000.000 tokens/)).toBeNull()
  })
  it('trata falha com nova tentativa e diferencia histórico vazio', async () => {
    fail = true
    render(<ChatContextDetails convId="a" messages={[]} />)
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' })
    window.api.listContextTurns = vi.fn(async () => [])
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByText(/Nenhum contexto gravado/)).toBeTruthy())
  })
})
