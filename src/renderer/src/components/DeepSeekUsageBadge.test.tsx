import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepSeekBalance } from '@shared/ipc'
import { DEEPSEEK_UNAVAILABLE_WARNING, DeepSeekUsageBadge, fmtUsd, useDeepSeekBalance } from './DeepSeekUsageBadge'

const setApi = (deepseekBalance: () => Promise<DeepSeekBalance | null>) => {
  ;(window as unknown as { api: unknown }).api = { deepseekBalance: vi.fn(deepseekBalance) }
  return (window as unknown as { api: { deepseekBalance: ReturnType<typeof vi.fn> } }).api.deepseekBalance
}
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('DeepSeekUsageBadge', () => {
  it('mostra saldo e custo estimado da conversa', () => {
    render(<DeepSeekUsageBadge balance={{ available: true, totalUsd: 12.5 }} convCostUsd={0.0031} />)
    expect(screen.getByText('DeepSeek · saldo US$ 12,50 · conversa ~US$ 0,0031 (estimado)')).toBeTruthy()
  })

  it('sem leitura do saldo: traço, custo continua', () => {
    render(<DeepSeekUsageBadge balance={null} convCostUsd={1.2} />)
    expect(screen.getByText('DeepSeek · saldo — · conversa ~US$ 1,20 (estimado)')).toBeTruthy()
  })

  it('fmtUsd: 2 casas, 4 abaixo de um centavo', () => {
    expect(fmtUsd(0)).toBe('0,00')
    expect(fmtUsd(3)).toBe('3,00')
    expect(fmtUsd(0.00456)).toBe('0,0046')
  })
})

describe('useDeepSeekBalance', () => {
  it('lê ao abrir e de novo a cada fim de turno; inativo não lê', async () => {
    const fetchBalance = setApi(async () => ({ available: true, totalUsd: 4 }))
    const notify = vi.fn()
    const { result, rerender } = renderHook(({ on, key }) => useDeepSeekBalance(on, key, notify), {
      initialProps: { on: false, key: 'c1:0:0' }
    })
    expect(fetchBalance).not.toHaveBeenCalled()
    rerender({ on: true, key: 'c1:0:0' })
    await waitFor(() => expect(result.current).toEqual({ available: true, totalUsd: 4 }))
    rerender({ on: true, key: 'c1:120:0.001' })
    await waitFor(() => expect(fetchBalance).toHaveBeenCalledTimes(2))
    expect(notify).not.toHaveBeenCalled()
  })

  it('is_available=false avisa uma vez com toast de aviso', async () => {
    setApi(async () => ({ available: false, totalUsd: 0 }))
    const notify = vi.fn()
    const { rerender } = renderHook(({ key }) => useDeepSeekBalance(true, key, notify), { initialProps: { key: 'a' } })
    await waitFor(() => expect(notify).toHaveBeenCalledWith('aviso', DEEPSEEK_UNAVAILABLE_WARNING))
    await act(async () => rerender({ key: 'b' }))
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
