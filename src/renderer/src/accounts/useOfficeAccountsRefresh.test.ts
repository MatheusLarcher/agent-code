// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OFFICE_ACCOUNTS_REFRESH_MS, useOfficeAccountsRefresh } from './useOfficeAccountsRefresh'

describe('useOfficeAccountsRefresh', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function setup(): { usage: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn<() => void>> } {
    vi.useFakeTimers()
    const usage = vi.fn(() => Promise.resolve([]))
    ;(window as unknown as { api: unknown }).api = { claudeAccountsUsage: usage }
    return { usage, refresh: vi.fn<() => void>() }
  }

  it('fora do escritório não consulta nada', () => {
    const { usage, refresh } = setup()
    renderHook(() => useOfficeAccountsRefresh(false, refresh))
    vi.advanceTimersByTime(OFFICE_ACCOUNTS_REFRESH_MS * 3)
    expect(usage).not.toHaveBeenCalled()
  })

  it('no escritório: lê ao entrar (sem forçar) e a cada 5 min; relê a lista depois de cada leitura', async () => {
    const { usage, refresh } = setup()
    const { unmount } = renderHook(() => useOfficeAccountsRefresh(true, refresh))
    expect(usage).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledWith(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFICE_ACCOUNTS_REFRESH_MS)
    expect(usage).toHaveBeenCalledTimes(2)
    unmount()
    await vi.advanceTimersByTimeAsync(OFFICE_ACCOUNTS_REFRESH_MS * 2)
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('janela escondida: não lê', () => {
    const { usage, refresh } = setup()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useOfficeAccountsRefresh(true, refresh))
    vi.advanceTimersByTime(OFFICE_ACCOUNTS_REFRESH_MS * 2)
    expect(usage).not.toHaveBeenCalled()
  })
})
