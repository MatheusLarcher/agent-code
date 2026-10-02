import { StrictMode, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Conversation } from '../types'
import { ensureCentral, useCentralBoot, type CentralBootDeps } from './centralBoot'

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({ id, title: 't', cwd: 'C:\\p', model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1, ...extra }) as Conversation

function deps(loadByIds: CentralBootDeps['loadByIds']): CentralBootDeps & { added: Conversation[]; created: number } {
  const d = {
    convsRef: { current: [conv('c1')] },
    loadByIds: vi.fn(loadByIds),
    added: [] as Conversation[],
    created: 0,
    addLoaded: (c: Conversation) => d.added.push(c),
    create: () => {
      d.created++
      return conv('central', { cwd: '', mode: 'central' })
    }
  }
  return d
}

describe('ensureCentral', () => {
  it('já na tela: não lê nem cria', async () => {
    const d = deps(async () => [])
    d.convsRef.current = [...d.convsRef.current, conv('central')]
    expect((await ensureCentral(d))?.id).toBe('central')
    expect(d.loadByIds).not.toHaveBeenCalled()
    expect(d.created).toBe(0)
  })

  it('no banco: põe na tela e na ref na hora (senão o próximo salvamento a apagaria)', async () => {
    const stored = conv('central', { cwd: '', mode: 'central' })
    // O dublê devolve outras também: só a de id fixo conta.
    const d = deps(async () => [conv('c9'), stored])
    expect(await ensureCentral(d)).toBe(stored)
    expect(d.loadByIds).toHaveBeenCalledWith(['central'])
    expect(d.added).toEqual([stored])
    expect(d.convsRef.current[0]).toBe(stored)
    expect(d.created).toBe(0)
  })

  it('em lugar nenhum: cria uma', async () => {
    const d = deps(async () => [])
    expect((await ensureCentral(d))?.id).toBe('central')
    expect(d.created).toBe(1)
    expect(d.convsRef.current.some((c) => c.id === 'central')).toBe(true)
  })

  it('leitura que falha NÃO cria (gravaria uma Central vazia por cima da do banco)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = deps(async () => {
      throw new Error('STORAGE_OFFLINE')
    })
    expect(await ensureCentral(d)).toBeNull()
    expect(d.created).toBe(0)
    expect(d.added).toEqual([])
    warn.mockRestore()
  })

  it('chegou enquanto lia (feed de mudanças): usa a que chegou, sem criar nem duplicar', async () => {
    const arrived = conv('central', { cwd: '', mode: 'central' })
    const d = deps(async () => {
      d.convsRef.current = [arrived, ...d.convsRef.current]
      return []
    })
    expect(await ensureCentral(d)).toBe(arrived)
    expect(d.created).toBe(0)
    expect(d.added).toEqual([])
  })
})

describe('useCentralBoot', () => {
  it('StrictMode (efeito duplo) e gatilhos em paralelo: uma leitura e uma Central só', async () => {
    let release: (list: Conversation[]) => void = () => {}
    const d = deps(() => new Promise<Conversation[]>((resolve) => (release = resolve)))
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    const { result } = renderHook(() => useCentralBoot({ ...d, hydrated: true }), { wrapper })
    const again = result.current()
    await act(async () => release([]))
    await again
    await waitFor(() => expect(d.created).toBe(1))
    expect(d.loadByIds).toHaveBeenCalledTimes(1)
  })

  it('antes da hidratação não faz nada (a carga inicial ainda vai trocar a lista)', async () => {
    const d = deps(async () => [])
    const { result, rerender } = renderHook((p: { hydrated: boolean }) => useCentralBoot({ ...d, hydrated: p.hydrated }), {
      initialProps: { hydrated: false }
    })
    expect(await result.current()).toBeNull()
    expect(d.loadByIds).not.toHaveBeenCalled()
    rerender({ hydrated: true })
    await waitFor(() => expect(d.created).toBe(1))
  })
})
