import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

type Listener = (call: { path: string }) => void
const listeners = new Set<Listener>()
const unsubscribe = vi.fn()

vi.mock('../office3d/useOfficeCalls', () => ({
  onNewOfficeCall: (fn: Listener) => {
    listeners.add(fn)
    return () => {
      unsubscribe()
      listeners.delete(fn)
    }
  }
}))

import { usePreviewOfficeCalls } from './usePreviewOfficeCalls'

afterEach(() => {
  cleanup()
  listeners.clear()
  unsubscribe.mockClear()
})

const emit = (path: string): void => listeners.forEach((fn) => fn({ path }))

describe('usePreviewOfficeCalls', () => {
  it('chamado novo abre no Preview, trazendo para a frente só quando pedido', () => {
    const openInPreview = vi.fn(() => true)
    const open = { openInPreview }
    let reveal = true
    renderHook(() => usePreviewOfficeCalls(open, () => reveal))
    emit('C:\\proj\\aviso.html')
    expect(openInPreview).toHaveBeenLastCalledWith('C:\\proj\\aviso.html', { reveal: true })
    reveal = false
    emit('C:\\proj\\outro.html')
    expect(openInPreview).toHaveBeenLastCalledWith('C:\\proj\\outro.html', { reveal: false })
  })

  it('sai da escuta ao desmontar', () => {
    const { unmount } = renderHook(() => usePreviewOfficeCalls({ openInPreview: vi.fn(() => true) }, () => true))
    expect(listeners.size).toBe(1)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})
