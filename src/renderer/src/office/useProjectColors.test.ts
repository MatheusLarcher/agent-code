import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ProjectColorMap } from '@shared/projectColor'
import { colorCwdsToRequest, useProjectColors } from './useProjectColors'

describe('useProjectColors: a cor de cada projeto vai ao feed do escritório', () => {
  it('pede só pastas de projeto absolutas e ainda não pedidas (sem Central, sandbox nem repetidas)', () => {
    const convs = [
      { id: 'a', cwd: 'C:\\proj\\alpha' },
      { id: 'b', cwd: 'C:\\proj\\alpha' },
      { id: 'central', cwd: 'C:\\x', mode: 'central' },
      { id: 'c', cwd: 'C:\\Users\\u\\sandbox\\2026-10-07_10-00_ab12' },
      { id: 'd', cwd: 'relativo' },
      { id: 'e', cwd: '' },
      { id: 'f', cwd: '/home/u/beta' }
    ]
    expect(colorCwdsToRequest(convs, new Set())).toEqual(['C:\\proj\\alpha', '/home/u/beta'])
    expect(colorCwdsToRequest(convs, new Set(['C:\\proj\\alpha']))).toEqual(['/home/u/beta'])
  })

  it('cada pasta é pedida uma vez; as cores válidas chegam juntas à store', async () => {
    vi.useFakeTimers()
    const api = vi.fn(async (cwds: string[]): Promise<ProjectColorMap> => Object.fromEntries(cwds.map((c) => [c, c.includes('beta') ? ({ hex: 'ruim' } as never) : { hex: '#3c9add', source: 'logo' }])))
    const store = { setProjectColors: vi.fn() }
    const convs = [{ id: 'a', cwd: 'C:\\proj\\alpha' }, { id: 'b', cwd: 'C:\\proj\\beta' }]
    const { rerender } = renderHook(({ list }) => useProjectColors(list, store, api), { initialProps: { list: convs } })
    rerender({ list: [...convs, { id: 'c', cwd: 'C:\\proj\\alpha' }] })
    expect(api).toHaveBeenCalledTimes(2)
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(50)
    })
    expect(store.setProjectColors).toHaveBeenCalledTimes(1)
    expect(store.setProjectColors.mock.calls[0][0]).toEqual({ 'C:\\proj\\alpha': { hex: '#3c9add', source: 'logo' } })
    vi.useRealTimers()
  })
})
