import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Mesh, MeshLambertMaterial, type Scene } from 'three'
import { syntheticFeed } from '../components/office/devFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { DEMO_TICK_MS } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import type { EngineOptions, FeedSource, RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace } from './Office3DWorkspace'
import { OfficeScene } from './scene'

const disconnects: number[] = []
class RO {
  observe(): void {}
  disconnect(): void {
    disconnects.push(1)
  }
}

function fakeRenderer(): RendererLike & { renders: number; disposed: boolean; ratio: number } {
  return {
    renders: 0,
    disposed: false,
    ratio: 0,
    setPixelRatio(r) {
      this.ratio = r
    },
    setSize() {},
    render() {
      this.renders++
    },
    dispose() {
      this.disposed = true
    }
  }
}

function source(feed: OfficeFeed | null): FeedSource & { subs: number; emit(f: OfficeFeed): void } {
  const subs = new Set<(f: OfficeFeed) => void>()
  return {
    getSnapshot: () => feed,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    get subs() {
      return subs.size
    },
    emit(f) {
      for (const cb of subs) cb(f)
    }
  }
}

/** RAF manual: os quadros só rodam quando o teste manda. */
function manualRaf(): { opts: Pick<EngineOptions, 'raf' | 'caf' | 'now'>; flush(n?: number): void; pending(): number; cancelled: number[] } {
  let t = 0
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  return {
    opts: {
      raf: (cb) => (queue.set(next, cb), next++),
      caf: (id) => {
        cancelled.push(id)
        queue.delete(id)
      },
      now: () => t
    },
    flush(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 16
        const batch = [...queue.entries()]
        queue.clear()
        for (const [, cb] of batch) cb(t)
      }
    },
    pending: () => queue.size,
    cancelled
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  disconnects.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Office3DWorkspace', () => {
  it('monta, desmonta e remonta sem erro, limpando RAF, listeners, observer e renderer', () => {
    const renderers: Array<ReturnType<typeof fakeRenderer>> = []
    const src = source(syntheticFeed())
    const raf = manualRaf()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const opts: EngineOptions = { ...raf.opts, source: src, createRenderer: () => (renderers.push(fakeRenderer()), renderers[renderers.length - 1]) }
    const props = { chat: <div>chat</div>, onOpenConversation: vi.fn(), onOpenFile: vi.fn(), onClose: vi.fn(), engineOptions: opts }

    const first = render(<Office3DWorkspace {...props} />)
    expect(screen.getByText('chat')).toBeTruthy()
    expect(renderers[0].ratio).toBeLessThanOrEqual(2)
    expect(raf.pending()).toBe(1)
    act(() => raf.flush())
    expect(renderers[0].renders).toBe(1)
    // Motor + bateria da sessão na barra; a camada dos balões dentro do palco.
    expect(src.subs).toBe(2)
    expect(screen.getByTestId('office3d-stage').querySelectorAll('.qb-layer')).toHaveLength(1)
    const stage = screen.getByTestId('office3d-stage')
    first.unmount()
    expect(renderers[0].disposed).toBe(true)
    expect(src.subs).toBe(0)
    expect(disconnects).toHaveLength(1)
    expect(stage.querySelector('.qb-layer')).toBeNull()
    expect(document.querySelector('.qb-layer')).toBeNull()
    // Cada listener de window adicionado pelo motor saiu.
    const engineTypes = new Set(['pointermove', 'pointerup', 'keydown', 'keyup', 'blur'])
    const ours = add.mock.calls.filter(([t]) => engineTypes.has(t as string))
    // + o keydown do atalho de DEV (feed de demonstração), também removido.
    expect(ours.length).toBe(engineTypes.size + (import.meta.env.DEV ? 1 : 0))
    for (const [type, fn] of ours) expect(remove.mock.calls.some(([t, f]) => t === type && f === fn)).toBe(true)

    render(<Office3DWorkspace {...props} />)
    expect(renderers).toHaveLength(2)
    act(() => raf.flush())
    expect(renderers[1].renders).toBeGreaterThan(0)
    expect(document.querySelectorAll('.qb-layer')).toHaveLength(1)
  })

  it('Ctrl+Alt+Shift+P abre e fecha o HUD de desempenho com os números do renderer (DEV)', () => {
    if (!import.meta.env.DEV) return
    const r = { ...fakeRenderer(), info: { render: { calls: 321, triangles: 45_678 } } }
    const raf = manualRaf()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(syntheticFeed()), createRenderer: () => r }}
      />
    )
    act(() => raf.flush())
    expect(screen.queryByTestId('o3d-perf')).toBeNull()
    const press = (): void => {
      act(() => void fireEvent.keyDown(window, { key: 'P', ctrlKey: true, altKey: true, shiftKey: true }))
    }
    press()
    const hud = screen.getByTestId('o3d-perf')
    expect(hud.textContent).toContain('321 draw calls')
    expect(hud.textContent).toContain('45.7k triângulos')
    expect(hud.textContent).toMatch(/salas \d+\/\d+ · LOD (perto|médio|longe) · pixelRatio \d\.\d\d/)
    expect(hud.textContent).toContain('fps')
    press()
    expect(screen.queryByTestId('o3d-perf')).toBeNull()
  })

  it('desmontar com quadro pendente cancela o RAF', () => {
    const raf = manualRaf()
    const view = render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(null), createRenderer: fakeRenderer }}
      />
    )
    expect(raf.pending()).toBe(1)
    view.unmount()
    expect(raf.cancelled).toHaveLength(1)
    expect(raf.pending()).toBe(0)
  })

  it('cena parada não fica renderizando; WASD acorda o laço e o soltar deixa parar', () => {
    const r = fakeRenderer()
    const raf = manualRaf()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(null), createRenderer: () => r }}
      />
    )
    act(() => raf.flush(3))
    expect(r.renders).toBe(1)
    expect(raf.pending()).toBe(0)
    fireEvent.keyDown(window, { key: 'w' })
    act(() => raf.flush(3))
    expect(r.renders).toBe(4)
    fireEvent.keyUp(window, { key: 'w' })
    act(() => raf.flush(3))
    expect(raf.pending()).toBe(0)
    // Tecla dentro de um campo de texto não move.
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    fireEvent.keyDown(ta, { key: 'w' })
    expect(raf.pending()).toBe(0)
    ta.remove()
  })

  it('clique no agente voa até o monitor e abre a tela; Esc volta; duplo clique abre a conversa', () => {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.deskIndex !== null && c.model.active)!
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const raf = manualRaf()
    const onOpen = vi.fn()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={onOpen}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(feed), createRenderer: fakeRenderer }}
      />
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    // Tween de ~400 ms; a âncora acompanha o monitor projetado.
    act(() => raf.flush(30))
    const anchor = screen.getByTestId('office-screen').parentElement as HTMLElement
    expect(anchor.className).toContain('o3d-screen-anchor')
    expect(anchor.style.width).toMatch(/px$/)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('office-screen')).toBeNull()

    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 50 })
    expect(onOpen).toHaveBeenCalledWith(target.model.convId)

    // Clique no vazio com a tela aberta fecha a tela.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    pick.mockReturnValue(null)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 })
    expect(screen.queryByTestId('office-screen')).toBeNull()
  })

  it('Ctrl+Alt+Shift+D liga o tique da demo; desligar e desmontar limpam intervalo e override (DEV)', () => {
    if (!import.meta.env.DEV) return
    const start = 14_916_667 * DEMO_LOOP_MS
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: start })
    try {
      const press = (): void => {
        act(() => void fireEvent.keyDown(window, { key: 'D', ctrlKey: true, altKey: true, shiftKey: true }))
      }
      const view = render(
        <Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} onClose={vi.fn()} engineOptions={{ ...manualRaf().opts, source: source(null), createRenderer: fakeRenderer }} />
      )
      // A bateria da sessão já tem o intervalo dela; a demo soma exatamente um.
      const base = vi.getTimerCount()
      press()
      expect(officeStore.overridden).toBe(true)
      expect(vi.getTimerCount()).toBe(base + 1)
      const first = officeStore.getSnapshot()
      // Cada tique republica demoFeed(Date.now()): um quadro novo, no relógio do tique.
      act(() => void vi.advanceTimersByTime(DEMO_TICK_MS))
      const second = officeStore.getSnapshot()
      expect(second).not.toBe(first)
      expect(second?.usageLimits?.five_hour?.updatedAt).toBe(start + DEMO_TICK_MS)
      act(() => void vi.advanceTimersByTime(3 * DEMO_TICK_MS))
      expect(officeStore.getSnapshot()?.usageLimits?.five_hour?.updatedAt).toBe(start + 4 * DEMO_TICK_MS)
      // Desligar: some o override e o intervalo.
      press()
      expect(officeStore.overridden).toBe(false)
      expect(vi.getTimerCount()).toBe(base)
      // Ligada de novo, o unmount também limpa tudo.
      press()
      expect(vi.getTimerCount()).toBe(base + 1)
      view.unmount()
      expect(officeStore.overridden).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      officeStore.setOverride(null)
    }
  })

  it('botão Sair do 3D chama onClose', () => {
    const onClose = vi.fn()
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} onClose={onClose} engineOptions={{ ...manualRaf().opts, source: source(null), createRenderer: fakeRenderer }} />)
    fireEvent.click(screen.getByRole('button', { name: /Sair do 3D/ }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('OfficeScene', () => {
  function meshes(scene: Scene): Mesh[] {
    const out: Mesh[] = []
    scene.traverse((o) => {
      if (o instanceof Mesh) out.push(o)
    })
    return out
  }

  it('acende o monitor do agente ativo, mostra o indicador de permissão e libera tudo no dispose', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const feed = syntheticFeed()
    const layout = layoutOffice(deriveOfficeModel(feed, Date.now()))
    const s = new OfficeScene()
    s.sync(layout)
    const lit = meshes(s.scene).filter((m) => m.userData.screen === 'on')
    const activeOwners = layout.characters.filter((c) => c.deskIndex !== null && c.model.active).length
    expect(activeOwners).toBeGreaterThan(0)
    expect(lit).toHaveLength(activeOwners)
    const perm = layout.characters.filter((c) => c.model.bubble === 'permissao')
    expect(perm.length).toBeGreaterThan(0)
    expect(s.animate(1)).toBe(true)

    const geoms = new Set(meshes(s.scene).map((m) => m.geometry))
    const disposed = new Set<unknown>()
    for (const g of geoms) g.addEventListener('dispose', () => disposed.add(g))
    s.dispose()
    expect(disposed.size).toBe(geoms.size)
    expect(s.scene.children).toHaveLength(0)
  })

  it('sync sem os agentes remove personagens e apaga os monitores', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const feed = syntheticFeed()
    const full = layoutOffice(deriveOfficeModel(feed, Date.now()))
    const s = new OfficeScene()
    s.sync(full)
    const empty = layoutOffice({ rooms: deriveOfficeModel(feed, Date.now()).rooms, characters: [] }, full)
    s.sync(empty)
    expect(s.character(full.characters[0].key)).toBeUndefined()
    expect(meshes(s.scene).some((m) => m.userData.screen === 'on')).toBe(false)
    expect(meshes(s.scene).some((m) => m.userData.screen === 'saver')).toBe(false)
    expect(s.animate(1)).toBe(false)
    s.dispose()
  })
})
