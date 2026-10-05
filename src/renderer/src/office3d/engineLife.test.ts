import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type FeedSource, type RendererLike } from './engine'
import { layoutOffice } from './layout'
import { HEAD_RADIUS } from './rig'

const T0 = 14_916_667 * DEMO_LOOP_MS
const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })

function setup(first: OfficeFeed) {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const subs = new Set<(f: OfficeFeed) => void>()
  let feed = first
  const source: FeedSource = {
    getSnapshot: () => feed,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    }
  }
  let t = 0
  const queue: FrameRequestCallback[] = []
  const engine = new Office3DEngine(container, canvas, { onFocus: vi.fn(), onOpen: vi.fn() }, {
    createRenderer: renderer,
    raf: (cb) => queue.push(cb),
    caf: () => {},
    now: () => t,
    source
  })
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  const emit = (f: OfficeFeed): void => {
    feed = f
    for (const cb of subs) cb(f)
  }
  return { engine, flush, emit }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date'], now: T0 + 20_000 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Office3DEngine — vida dos agentes', () => {
  it('headWorldPosition: centro da cabeça no mundo (âncora dos balões); false para quem não está à vista', () => {
    const feed = demoFeed(Date.now())
    const { engine, flush } = setup(feed)
    flush(3)
    const c = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((x) => x.model.convId === 'demo-0-0')!
    const v = new Vector3()
    expect(engine.headWorldPosition(c.key, v)).toBe(true)
    // Sentado na cadeira dele: cabeça acima do tampo, sobre o assento.
    expect(v.y).toBeGreaterThan(1.2)
    expect(v.y).toBeLessThan(1.55)
    expect(Math.hypot(v.x - c.x, v.z - c.z)).toBeLessThan(0.5)
    expect(HEAD_RADIUS).toBeGreaterThan(0)
    expect(engine.headWorldPosition('ninguem', v)).toBe(false)
    // Com o monitor dele em foco, ele some de cena: sem balão.
    engine.focus(c.key)
    expect(engine.headWorldPosition(c.key, v)).toBe(false)
    engine.dispose()
  })

  it('feed novo vira eventos de events.ts: o pedido faz o agente pular e correr para a mesa', () => {
    const { engine, flush, emit } = setup(demoFeed(Date.now()))
    flush(2)
    // O 2º pedido do dev da sala 4 chega aos 28,4 s do loop (nas salas 0 e 2 esse pedido começa pela estante de Memórias).
    vi.setSystemTime(T0 + 28_900)
    emit(demoFeed(Date.now()))
    const b = engine.scene.crowd.brains.get('conv:demo-4-0')!
    expect(['alert', 'scared']).toContain(b.reaction)
    expect(b.rush || b.mode === 'work').toBe(true)
    flush(5)
    expect(b.mode).toBe('work')
    engine.dispose()
  })

  it('clique: o agente olha para a câmera e acena; ao voltar (Esc), acena de novo', () => {
    const feed = demoFeed(Date.now())
    const { engine, flush } = setup(feed)
    flush(2)
    const key = 'conv:demo-0-3'
    const b = engine.scene.crowd.brains.get(key)!
    engine.focus(key)
    expect([b.reaction, ...b.pending]).toContain('greet')
    flush(120)
    expect(b.reaction === 'greet' || b.pending.includes('greet')).toBe(false)
    engine.leaveFocus(true)
    expect([b.reaction, ...b.pending]).toContain('greet')
    engine.dispose()
  })

  it('setDemo encurta o tempo até o cochilo só enquanto a demo está ligada', () => {
    const { engine } = setup(demoFeed(Date.now()))
    const normal = engine.scene.crowd.sleepAfter
    engine.setDemo(true)
    expect(engine.scene.crowd.sleepAfter).toBeLessThan(normal / 10)
    engine.setDemo(false)
    expect(engine.scene.crowd.sleepAfter).toBe(normal)
    engine.dispose()
  })
})
