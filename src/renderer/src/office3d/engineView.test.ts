import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type RendererLike } from './engine'
import { FAR_PIXEL_SCALE } from './lod'
import { OfficeScene } from './scene'
import { FAR_KINDS, MAX_BUBBLES, QUIP_TICK_MS } from './speech'

const T0 = 14_916_667 * DEMO_LOOP_MS

function stubRenderer() {
  const r = {
    ratio: 0,
    renders: 0,
    shadowMap: { autoUpdate: false, needsUpdate: false },
    shadowRequests: 0,
    setPixelRatio(v: number) {
      r.ratio = v
    },
    setSize() {},
    render() {
      r.renders++
      if (r.shadowMap.needsUpdate) r.shadowRequests++
      r.shadowMap.needsUpdate = false
    },
    dispose() {}
  }
  return r satisfies RendererLike
}

function setup(now = T0 + 30_000) {
  vi.setSystemTime(now)
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const feed = demoFeed(now)
  const renderer = stubRenderer()
  let t = 0
  const queue: FrameRequestCallback[] = []
  const onFocus = vi.fn()
  const engine = new Office3DEngine(container, canvas, { onFocus, onOpen: vi.fn() }, {
    createRenderer: () => renderer,
    raf: (cb) => queue.push(cb),
    caf: () => {},
    now: () => t,
    source: { getSnapshot: () => feed, subscribe: () => () => {} }
  })
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  const visible = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.qb')].filter((el) => !el.hidden && el.style.opacity === '')
  return { engine, flush, renderer, container, onFocus, visible, pending: () => queue.length }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Office3DEngine — falas no palco', () => {
  it(`balões dos agentes aparecem com o feed (no máximo ${MAX_BUBBLES}) e clicar num balão foca o agente`, () => {
    const { engine, flush, container, onFocus, visible } = setup()
    flush(3)
    expect(container.querySelector('.qb-layer')).not.toBeNull()
    const shown = visible()
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThanOrEqual(MAX_BUBBLES)
    const key = shown[0].dataset.key!
    shown[0].click()
    expect(engine.focused).toBe(key)
    expect(onFocus).toHaveBeenCalledWith(key, true)
    // Em foco, o agente sai de cena (a tela do monitor abre): o balão dele some.
    flush(30)
    expect(visible().some((el) => el.dataset.key === key)).toBe(false)
    engine.dispose()
  })

  it('onFocus diz quem fechou a tela: Esc, clique no vazio, roda e WASD são o usuário; flyToAgent é o motor', () => {
    const { engine, flush, container, onFocus } = setup()
    flush(3)
    const canvas = container.querySelector('canvas')!
    const open = (): void => {
      engine.focus('conv:demo-0-2')
      expect(onFocus).toHaveBeenLastCalledWith('conv:demo-0-2', true)
    }
    open()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(onFocus).toHaveBeenLastCalledWith(null, true)
    open()
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(null)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 })
    expect(onFocus).toHaveBeenLastCalledWith(null, true)
    open()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }))
    expect(onFocus).toHaveBeenLastCalledWith(null, true)
    open()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', cancelable: true }))
    flush(1)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }))
    expect(onFocus).toHaveBeenLastCalledWith(null, true)
    open()
    expect(engine.flyToAgent('conv:demo-1-0')).toBe(true)
    expect(engine.focused).toBeNull()
    expect(onFocus).toHaveBeenLastCalledWith(null, false)
    engine.dispose()
  })

  it('o balão acompanha o agente que anda', () => {
    const { engine, flush, visible } = setup()
    flush(3)
    const el = visible()[0]
    const b = engine.scene.crowd.brains.get(el.dataset.key!)!
    const x0 = Number(/translate3d\((-?[\d.]+)px/.exec(el.style.transform)![1])
    b.x += 1.5
    flush(1)
    const x1 = Number(/translate3d\((-?[\d.]+)px/.exec(el.style.transform)![1])
    expect(x1).toBeGreaterThan(x0 + 5)
    engine.dispose()
  })

  it('zoom LONGE: só permissão e erro aparecem, como ícone compacto; resolução e sombra voltam ao aproximar', () => {
    // Aos 40 s do loop o "azarado" de 4 salas está com erro da API.
    const { engine, flush, container, renderer, visible } = setup(T0 + 40_000)
    flush(3)
    expect(visible().some((el) => !FAR_KINDS.has(el.dataset.kind as never))).toBe(true)
    const building = { ...engine.rig.pose }
    engine.rig.zoom(1e5)
    engine.requestRender()
    flush(3)
    expect(engine.stats.lod).toBe(2)
    expect(renderer.ratio).toBeCloseTo(FAR_PIXEL_SCALE)
    expect(container.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(true)
    expect(visible().length).toBeGreaterThan(0)
    expect(visible().every((el) => FAR_KINDS.has(el.dataset.kind as never))).toBe(true)
    expect(engine.scene.castsShadows).toBe(false)
    const before = renderer.shadowRequests
    flush(20)
    expect(renderer.shadowRequests).toBe(before)

    engine.rig.pose = building
    engine.requestRender()
    flush(2)
    expect(engine.stats.lod).toBe(1)
    expect(renderer.ratio).toBe(1)
    expect(engine.scene.castsShadows).toBe(true)
    expect(renderer.shadowRequests).toBeGreaterThan(before)
    expect(container.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(false)
    engine.dispose()
  })
})

describe('Office3DEngine — render sob demanda com culling', () => {
  it('câmera longe do prédio: agentes animando fora da tela não seguram o laço; voltar a olhar acorda', () => {
    const { engine, flush, pending, renderer } = setup()
    flush(3)
    expect(pending()).toBe(1)
    const building = { ...engine.rig.pose }
    engine.rig.pose = { ...building, tx: building.tx + 400, tz: building.tz + 400, distance: 10 }
    engine.requestRender()
    flush(5)
    expect(engine.stats.rooms).toBe(0)
    expect(pending()).toBe(0)
    const renders = renderer.renders
    flush(10)
    expect(renderer.renders).toBe(renders)
    engine.rig.pose = building
    engine.requestRender()
    flush(3)
    expect(engine.stats.rooms).toBe(engine.stats.roomsTotal)
    expect(pending()).toBe(1)
    engine.dispose()
  })

  it('o tique das falas (~4×/s) e o do relógio de parede só existem enquanto o motor vive', () => {
    const { engine } = setup()
    const base = vi.getTimerCount()
    expect(base).toBeGreaterThanOrEqual(2)
    vi.advanceTimersByTime(QUIP_TICK_MS * 4)
    engine.dispose()
    expect(vi.getTimerCount()).toBe(base - 2)
  })
})
