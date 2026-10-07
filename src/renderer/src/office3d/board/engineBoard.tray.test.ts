import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { demoFeed } from '../demoFeed'
import { DEMO_LOOP_MS } from '../demoTimeline'
import { Office3DEngine, type RendererLike } from '../engine'
import { QUEUE_TRAY } from '../officePlan'
import { OfficeScene } from '../scene'
import { fakeBoardApi, item, settle } from './boardTestKit'
import { DEMO_TRAY_RELEASE_MS } from './demoTray'
import { TRAY_KEY } from './queueTray'

/** Começo de um laço da demo: a fila falsa do agent-code ainda tem os 5 prompts antes de DEMO_TRAY_RELEASE_MS. */
const T0 = 14_916_667 * DEMO_LOOP_MS

function renderer(): RendererLike {
  return { setPixelRatio() {}, setSize() {}, render() {}, dispose() {}, shadowMap: { autoUpdate: false, needsUpdate: false } }
}

async function setup() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) })
  const feed = demoFeed(Date.now())
  const fake = fakeBoardApi({ available: true, items: [item('a', { conversationId: 'demo-0-0' })] })
  const queue: FrameRequestCallback[] = []
  let t = 0
  const engine = new Office3DEngine(
    container,
    canvas,
    { onFocus: vi.fn(), onOpen: vi.fn() },
    { createRenderer: renderer, raf: (cb) => queue.push(cb), caf: () => {}, now: () => t, source: { getSnapshot: () => feed, subscribe: () => () => {} }, board: fake.api, browser: null }
  )
  await settle()
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  return { engine, canvas, container, flush }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0 + DEMO_TRAY_RELEASE_MS - 30_000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('a bandeja da fila no motor', () => {
  it('fica à esquerda do quadro, desenha a fila do projeto da parede e mostra a dica no hover', async () => {
    const s = await setup()
    const tray = s.engine.scene.boards.tray!
    expect(tray).not.toBeNull()
    const world = tray.root.getWorldPosition(tray.root.position.clone())
    expect([world.x, world.z]).toEqual([QUEUE_TRAY.x, QUEUE_TRAY.z])
    // A demonstração: a fila falsa do agent-code (5 prompts → 4 folhas e "+1") com ele na parede.
    s.engine.setDemo(true)
    s.engine.filter.set('c:/demo/agent-code')
    // A leitura da fila (setTimeout de verdade) e o tique do quadro (o intervalo do motor, falso).
    for (let i = 0; i < 6 && tray.visibleSheets === 0; i++) {
      await settle()
      vi.advanceTimersByTime(300)
      s.flush(2)
    }
    expect(s.engine.scene.boards.shown).toBe('c:/demo/agent-code')
    expect(tray.visibleSheets).toBe(4)
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(TRAY_KEY)
    fireEvent.pointerMove(s.canvas, { clientX: 400, clientY: 300 })
    s.flush(2)
    const tip = s.container.querySelector<HTMLElement>('.o3d-board-tip')!
    expect(tip.hidden).toBe(false)
    expect(tip.textContent).toBe('5 prompts na fila — o próximo vai para "Demo 1.2" (Plano da demonstração)')
    expect(tip.classList.contains('o3d-board-tip-wrap')).toBe(true)
    s.engine.dispose()
    expect(s.engine.scene.boards.tray).toBeNull()
  })
})
