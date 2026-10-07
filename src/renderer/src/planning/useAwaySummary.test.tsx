import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { BoardItem } from '@shared/ipc'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { item } from '../office3d/board/boardTestKit'
import { loadVisits } from './awayVisits'
import { useAwaySummaries, type AwayApi } from './useAwaySummary'

/**
 * A volta ao projeto: a última visita anda enquanto a conversa (e o quadro) está
 * à vista com a janela em foco; voltar depois de 30 min ou mais com mudança no
 * banco abre a faixa; sem mudança ou antes de 30 min, nada.
 */

const MIN = 60_000
const CWD = 'C:/GitHub/loja'
let now = Date.UTC(2026, 9, 6, 9, 0)
let items: BoardItem[] = []
let envios: HandoffEnvio[] = []

function fakeApi(available = true) {
  return {
    boardList: vi.fn(async () => ({ available, items })),
    handoffList: vi.fn(async () => (available ? { ok: true as const, envios } : { ok: false as const, message: 'sem banco' }))
  }
}

function mount(api: ReturnType<typeof fakeApi>, cwd: string | null = CWD) {
  return renderHook(({ dir }) => useAwaySummaries(dir, api as unknown as AwayApi, () => now), { initialProps: { dir: cwd as string | null } })
}

/** Fica `min` minutos longe do projeto (outra conversa à vista) e volta. */
function awayAndBack(view: ReturnType<typeof mount>, min: number): void {
  view.rerender({ dir: null })
  now += min * MIN
  view.rerender({ dir: CWD })
}

beforeEach(() => {
  localStorage.clear()
  now = Date.UTC(2026, 9, 6, 9, 0)
  items = []
  envios = []
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAwaySummaries', () => {
  it('a primeira visita só grava; voltar depois de 31 min com um cartão concluído abre a faixa', async () => {
    const api = fakeApi()
    const view = mount(api)
    expect(view.result.current.current).toBeNull()
    expect(Object.values(loadVisits())).toEqual([now])
    expect(api.boardList).not.toHaveBeenCalled()

    items = [item('c1', { sourceStatus: 'completed', updatedAt: new Date(now + 10 * MIN).toISOString() })]
    awayAndBack(view, 31)
    await waitFor(() => expect(view.result.current.current?.counts.concluida).toBe(1))
    expect(api.boardList).toHaveBeenCalledWith({ projectCwd: CWD })
    expect(view.result.current.current?.awayMs).toBe(31 * MIN)
  })

  it('menos de 30 min fora: nada, e o banco nem é lido', async () => {
    const api = fakeApi()
    const view = mount(api)
    items = [item('c1', { sourceStatus: 'completed', updatedAt: new Date(now + 5 * MIN).toISOString() })]
    awayAndBack(view, 10)
    await act(async () => undefined)
    expect(view.result.current.current).toBeNull()
    expect(api.boardList).not.toHaveBeenCalled()
  })

  it('mais de 30 min fora sem mudança: nada', async () => {
    const api = fakeApi()
    const view = mount(api)
    items = [item('c1', { sourceStatus: 'completed', updatedAt: new Date(now - 60 * MIN).toISOString() })]
    awayAndBack(view, 45)
    await waitFor(() => expect(api.handoffList).toHaveBeenCalled())
    await act(async () => undefined)
    expect(view.result.current.current).toBeNull()
  })

  it('o F5 mantém a faixa até o "ok"; depois do "ok", ela não volta', async () => {
    const api = fakeApi()
    const view = mount(api)
    items = [item('c1', { sourceStatus: 'completed', updatedAt: new Date(now + 10 * MIN).toISOString() })]
    awayAndBack(view, 40)
    await waitFor(() => expect(view.result.current.current).not.toBeNull())
    view.unmount()

    const again = mount(api)
    expect(again.result.current.current?.counts.concluida).toBe(1)
    act(() => again.result.current.dismiss(again.result.current.current!.projectKey))
    expect(again.result.current.current).toBeNull()
    again.unmount()
    expect(mount(api).result.current.current).toBeNull()
  })

  it('janela sem foco não é visita: a última visita fica onde estava', () => {
    const api = fakeApi()
    const view = mount(api)
    const first = Object.values(loadVisits())[0]
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    now += 20 * MIN
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    now += 20 * MIN
    view.rerender({ dir: CWD })
    // Saiu no blur (20 min depois), e o tempo sem foco não andou a visita.
    expect(Object.values(loadVisits())).toEqual([first + 20 * MIN])
  })

  it('banco indisponível: nada aparece e a visita fica para o próximo tique tentar de novo', async () => {
    const api = fakeApi(false)
    const view = mount(api)
    const first = Object.values(loadVisits())[0]
    items = [item('c1', { sourceStatus: 'completed', updatedAt: new Date(now + 10 * MIN).toISOString() })]
    view.rerender({ dir: null })
    now += 60 * MIN
    view.rerender({ dir: CWD })
    await waitFor(() => expect(api.boardList).toHaveBeenCalled())
    await act(async () => undefined)
    expect(view.result.current.current).toBeNull()
    expect(Object.values(loadVisits())).toEqual([first])
  })
})
