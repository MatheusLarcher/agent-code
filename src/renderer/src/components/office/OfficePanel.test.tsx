import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { PermissionRequest } from '@shared/ipc'
import { conv, feed } from '../../office/adapter/testFeed'
import { officeStore } from '../../office/officeStore'
import { UiProvider } from '../../ui/UiProvider'
import { OfficePanel } from './OfficePanel'
import { getOfficeRuntime, resetOfficeRuntime } from './officeRuntime'
import { OfficeView, type OfficeViewCallbacks } from './officeView'

function fakeRaf() {
  let next = 1
  const pending = new Map<number, FrameRequestCallback>()
  return {
    pending,
    raf: vi.fn((cb: FrameRequestCallback) => {
      const id = next++
      pending.set(id, cb)
      return id
    }),
    caf: vi.fn((id: number) => void pending.delete(id)),
    tick(time: number) {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(time)
    }
  }
}

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Toda chamada a window.api fica registrada: nada de aprovar pelo escritório. */
const apiCalls: string[] = []

beforeEach(() => {
  resetOfficeRuntime()
  officeStore.setOverride(null)
  apiCalls.length = 0
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: (_t, k) => (...args: unknown[]) => void apiCalls.push(`${String(k)}(${args.length})`) }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OfficePanel: laço', () => {
  it('ativo agenda um rAF; desmontar cancela e não sobra nenhum', () => {
    const f = fakeRaf()
    const { unmount } = render(
      <UiProvider>
        <OfficePanel active onOpenConversation={vi.fn()} onFocusRequest={vi.fn()} viewOptions={{ raf: f.raf, caf: f.caf }} />
      </UiProvider>
    )
    expect(f.pending.size).toBe(1)
    act(() => f.tick(16))
    expect(f.pending.size).toBe(1)
    unmount()
    expect(f.pending.size).toBe(0)
    f.tick(32)
    expect(f.raf).toHaveBeenCalledTimes(2)
  })

  it('aba inativa: nenhum requestAnimationFrame agendado', () => {
    const f = fakeRaf()
    render(
      <UiProvider>
        <OfficePanel active={false} onOpenConversation={vi.fn()} onFocusRequest={vi.fn()} viewOptions={{ raf: f.raf, caf: f.caf }} />
      </UiProvider>
    )
    expect(f.raf).not.toHaveBeenCalled()
    expect(f.pending.size).toBe(0)
  })

  it('documento escondido para o laço; visível de novo, volta', () => {
    const f = fakeRaf()
    render(
      <UiProvider>
        <OfficePanel active onOpenConversation={vi.fn()} onFocusRequest={vi.fn()} viewOptions={{ raf: f.raf, caf: f.caf }} />
      </UiProvider>
    )
    expect(f.pending.size).toBe(1)
    act(() => setVisibility('hidden'))
    expect(f.pending.size).toBe(0)
    act(() => setVisibility('visible'))
    expect(f.pending.size).toBe(1)
  })
})

describe('OfficeView: interações', () => {
  function setup(): { cb: OfficeViewCallbacks; view: OfficeView; f: ReturnType<typeof fakeRaf> } {
    const perm = { id: 'p1', toolName: 'Bash', input: {} } as unknown as PermissionRequest
    officeStore.publish(
      feed({
        conversations: [conv('a', { updatedAt: Date.now() }), conv('b', { updatedAt: Date.now() })],
        activeId: 'a',
        permissions: { b: perm }
      })
    )
    const f = fakeRaf()
    const cb: OfficeViewCallbacks = {
      onHover: vi.fn(),
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onFocusRequest: vi.fn(),
      onLevel: vi.fn()
    }
    const view = new OfficeView(document.createElement('canvas'), null, getOfficeRuntime(), cb, { raf: f.raf, caf: f.caf, dpr: () => 1 })
    return { cb, view, f }
  }

  it('clique no balão de permissão chama onFocusRequest e nenhuma API', () => {
    const { cb, view } = setup()
    const rt = getOfficeRuntime()
    const id = rt.director.idOf('conv:b')!
    const ch = rt.state.getCharacter(id)!
    expect(ch.bubble).toBe('permissao')
    view.clickAt({ x: ch.x, y: ch.y - 16 })
    expect(cb.onFocusRequest).toHaveBeenCalledWith('b')
    expect(cb.onSelect).not.toHaveBeenCalled()
    expect(apiCalls).toEqual([])
    view.dispose()
  })

  it('clique no personagem seleciona e segue; duplo clique abre a conversa', () => {
    const { cb, view } = setup()
    const rt = getOfficeRuntime()
    const id = rt.director.idOf('conv:a')!
    const ch = rt.state.getCharacter(id)!
    view.clickAt({ x: ch.x, y: ch.y - 4 })
    expect(cb.onSelect).toHaveBeenCalledWith(id)
    expect(rt.state.selectedAgentId).toBe(id)
    expect(rt.state.cameraFollowId).toBe(id)
    view.openAt({ x: ch.x, y: ch.y - 4 })
    expect(cb.onOpen).toHaveBeenCalledWith('a', undefined)
    expect(apiCalls).toEqual([])
    view.dispose()
  })

  it('níveis de zoom percorrem prédio → tela e voltam', () => {
    const { cb, view } = setup()
    view.setLevel('predio')
    view.zoomStep(1)
    view.zoomStep(1)
    view.zoomStep(1)
    view.zoomStep(1)
    expect(view.currentLevel).toBe('tela')
    view.zoomStep(-1)
    expect(view.currentLevel).toBe('mesa')
    expect(cb.onLevel).toHaveBeenLastCalledWith('mesa')
    view.dispose()
  })
})
