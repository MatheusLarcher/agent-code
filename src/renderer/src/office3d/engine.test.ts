import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticFeed } from '../components/office/devFeed'
import { deriveOfficeModel } from '../office/adapter/model'
import { framePose, monitorPose } from './cameraRig'
import { Office3DEngine, type EngineOptions, type RendererLike } from './engine'
import { buildingBounds, layoutOffice, monitorPosition } from './layout'
import { focusView } from './screenAnchor'

let resizeCb: (() => void) | null = null
class RO {
  constructor(cb: () => void) {
    resizeCb = cb
  }
  observe(): void {}
  disconnect(): void {}
}

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })

function setup(width: number, height: number) {
  const container = document.createElement('div')
  const size = { width, height }
  Object.defineProperty(container, 'clientWidth', { get: () => size.width })
  Object.defineProperty(container, 'clientHeight', { get: () => size.height })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const feed = syntheticFeed()
  let t = 0
  const queue: FrameRequestCallback[] = []
  const opts: EngineOptions = {
    createRenderer: renderer,
    raf: (cb) => queue.push(cb),
    caf: () => {},
    now: () => t,
    source: { getSnapshot: () => feed, subscribe: () => () => {} }
  }
  const engine = new Office3DEngine(container, canvas, { onFocus: vi.fn(), onOpen: vi.fn() }, opts)
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  const resize = (w: number, h: number): void => {
    size.width = w
    size.height = h
    resizeCb?.()
  }
  const layout = layoutOffice(deriveOfficeModel(feed, Date.now()))
  return { engine, flush, resize, layout, canvas }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

afterEach(() => {
  vi.restoreAllMocks()
  resizeCb = null
})

describe('Office3DEngine — enquadramento', () => {
  it('câmera inicial enquadra o escritório inteiro (até o alto da parede do fundo) e acompanha o resize até o usuário mexer', () => {
    const { engine, resize, layout, canvas } = setup(1600, 900)
    const box = { ...buildingBounds(layout.rooms)!, height: 2.8 }
    expect(engine.rig.pose).toEqual(framePose(box, { fovDeg: 50, aspect: 1600 / 900 }))
    resize(400, 1000)
    const narrow = framePose(box, { fovDeg: 50, aspect: 0.4 })
    expect(engine.rig.pose).toEqual(narrow)
    // Depois da roda, o resize não mexe mais na câmera.
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
    const mine = { ...engine.rig.pose }
    resize(1600, 900)
    expect(engine.rig.pose).toEqual(mine)
    engine.dispose()
  })

  it('tela aberta: resize reenquadra o monitor com o novo aspect', () => {
    const { engine, flush, resize, layout } = setup(1600, 900)
    const target = layout.characters.find((c) => c.deskIndex !== null && c.model.active)!
    const desk = layout.rooms.find((r) => r.id === target.screenDesk!.roomId)!.desks[target.screenDesk!.index]
    engine.focus(target.key)
    flush(40)
    expect(engine.rig.pose.distance).toBeCloseTo(monitorPose(monitorPosition(desk), focusView(50, 1600, 900)).distance)
    resize(280, 700)
    const narrow = monitorPose(monitorPosition(desk), focusView(50, 280, 700))
    expect(engine.rig.pose).toEqual(narrow)
    // No meio do voo, o resize troca o destino sem reiniciar o tween.
    engine.leaveFocus(true)
    engine.focus(target.key)
    flush(5)
    resize(1600, 900)
    flush(40)
    expect(engine.rig.pose.distance).toBeCloseTo(monitorPose(monitorPosition(desk), focusView(50, 1600, 900)).distance)
    engine.dispose()
  })
})
