import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { LlmCall, TokenUsageHistory } from '@shared/ipc'
import { TokenUsagePanel } from './TokenUsagePanel'
import { emptyUsageMap, reduceUsage, type UsageMap } from '../tokenUsageTree'

function persistedCall(over: Partial<LlmCall>): LlmCall {
  return {
    id: 'call-1',
    convId: 'c1',
    turnId: 't1',
    nodeId: 'root-1',
    parentNodeId: null,
    subagentType: null,
    taskDescription: null,
    seq: 0,
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    inputPreview: 'oi',
    outputPreview: 'olá',
    createdAt: new Date(1_700_000_000_000).toISOString(),
    ...over
  }
}

function liveCall(over: Record<string, unknown>): UsageMap {
  return reduceUsage(emptyUsageMap, {
    kind: 'llm-call',
    node_id: 'root-1',
    parent_node_id: null,
    seq: 0,
    model: 'claude-sonnet-5',
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    inputPreview: 'live-in',
    outputPreview: 'live-out',
    createdAt: 1,
    ...over
  } as never)
}

let getHistory: ReturnType<typeof vi.fn>

beforeEach(() => {
  getHistory = vi.fn(async (): Promise<TokenUsageHistory> => ({ calls: [], totals: [] }))
  ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: getHistory }
})
afterEach(cleanup)

describe('TokenUsagePanel', () => {
  it('sem conversa ativa, mostra o estado vazio dedicado', () => {
    render(<TokenUsagePanel convId={null} liveMap={emptyUsageMap} />)
    expect(screen.getByText('Nenhuma conversa selecionada.')).toBeTruthy()
  })

  it('renderiza o cabeçalho com o total agregado a partir de `totals`', async () => {
    getHistory = vi.fn(async (): Promise<TokenUsageHistory> => ({
      calls: [persistedCall({})],
      totals: [
        {
          convId: 'c1',
          day: '2026-09-19',
          model: 'claude-sonnet-5',
          subagentType: null,
          sumInput: 100,
          sumOutput: 50,
          sumCacheRead: 0,
          sumCacheWrite: 0,
          sumCost: null,
          callCount: 1
        }
      ]
    }))
    ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: getHistory }

    render(<TokenUsagePanel convId="c1" liveMap={emptyUsageMap} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('c1'))
    const header = (await screen.findByText('Consumo de tokens')).closest('.token-usage-header')
    expect(header).toBeTruthy()
    expect(header?.textContent).toContain('↓100')
    expect(header?.textContent).toContain('↑50')
  })

  it('monta a árvore com nó pai + filho a partir de eventos ao vivo', async () => {
    let map = liveCall({ node_id: 'root-1', parent_node_id: null, subagentType: undefined })
    map = reduceUsage(map, {
      kind: 'llm-call',
      node_id: 'sub-1',
      parent_node_id: 'root-1',
      seq: 0,
      model: 'claude-fable-5-1',
      tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
      inputPreview: 'sub-in',
      outputPreview: 'sub-out',
      subagentType: 'pesquisador',
      createdAt: 2
    } as never)

    render(<TokenUsagePanel convId="c1" liveMap={map} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalled())
    expect(await screen.findByText(/principal/)).toBeTruthy()
    expect(screen.getByText(/pesquisador/)).toBeTruthy()
  })

  it('clicar num nó mostra a lista de chamadas diretas dele', async () => {
    const map = liveCall({})
    render(<TokenUsagePanel convId="c1" liveMap={map} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalled())
    const nodeButton = await screen.findByText(/principal/)
    fireEvent.click(nodeButton)
    expect(await screen.findByText(/Chamadas — principal/)).toBeTruthy()
    expect(screen.getByText('claude-sonnet-5')).toBeTruthy()
  })

  it('clicar numa chamada mostra o preview de entrada/saída', async () => {
    const map = liveCall({})
    render(<TokenUsagePanel convId="c1" liveMap={map} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalled())
    fireEvent.click(await screen.findByText(/principal/))
    fireEvent.click(await screen.findByText('claude-sonnet-5'))
    expect(await screen.findByText('live-in')).toBeTruthy()
    expect(screen.getByText('live-out')).toBeTruthy()
  })

  it('ao trocar de convId, busca o histórico de novo e repovoa', async () => {
    const historyForC2: TokenUsageHistory = {
      calls: [persistedCall({ id: 'call-2', convId: 'c2', nodeId: 'root-2' })],
      totals: []
    }
    getHistory = vi.fn(async (convId: string): Promise<TokenUsageHistory> =>
      convId === 'c2' ? historyForC2 : { calls: [], totals: [] }
    )
    ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: getHistory }

    const { rerender } = render(<TokenUsagePanel convId="c1" liveMap={emptyUsageMap} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('c1'))
    expect(screen.getByText('Nenhuma chamada ao modelo ainda.')).toBeTruthy()

    rerender(<TokenUsagePanel convId="c2" liveMap={emptyUsageMap} />)
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('c2'))
    expect(await screen.findByText(/principal/)).toBeTruthy()
  })
})
