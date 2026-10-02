import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RateLimitStatus } from '@shared/ipc'
import type { OfficeFeed } from '../office/adapter/feed'
import { agentPose } from './cameraRig'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { FOLLOW_GRACE_MS, Office3DEngine, type FeedSource, type RendererLike } from './engine'
import { OfficeScene } from './scene'
import { QUIP_TICK_MS, Speech } from './speech'

const T0 = 14_916_667 * DEMO_LOOP_MS

let resizeCb: (() => void) | null = null
class RO {
  constructor(cb: () => void) {
    resizeCb = cb
  }
  observe(): void {}
  disconnect(): void {}
}

function setup(first: OfficeFeed) {
  const container = document.createElement('div')
  const size = { w: 1600, h: 900 }
  Object.defineProperty(container, 'clientWidth', { get: () => size.w })
  Object.defineProperty(container, 'clientHeight', { get: () => size.h })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const subs = new Set<(f: OfficeFeed) => void>()
  const source: FeedSource = {
    getSnapshot: () => first,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    }
  }
  const sizes: Array<[number, number]> = []
  const r: RendererLike & { renders: number } = {
    renders: 0,
    setPixelRatio() {},
    setSize(w, h) {
      sizes.push([w, h])
    },
    render() {
      this.renders++
    },
    dispose() {}
  }
  let t = 0
  const queue: FrameRequestCallback[] = []
  const engine = new Office3DEngine(container, canvas, { onFocus: vi.fn(), onOpen: vi.fn() }, {
    createRenderer: () => r,
    raf: (cb) => queue.push(cb),
    caf: () => void queue.splice(0),
    now: () => t,
    source
  })
  return {
    engine,
    canvas,
    renderer: r,
    sizes,
    pending: (): number => queue.length,
    flush(n: number): void {
      for (let i = 0; i < n; i++) {
        t += 16
        for (const cb of queue.splice(0)) cb(t)
      }
    },
    /** Relógio do motor andando sem quadro (aba fechada, usuário parado). */
    wait(ms: number): void {
      t += ms
    },
    emit(f: OfficeFeed): void {
      for (const cb of subs) cb(f)
    },
    resize(w: number, h: number): void {
      size.w = w
      size.h = h
      resizeCb?.()
    }
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 + 20_000 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resizeCb = null
})

describe('Office3DEngine — aba fechada (pause/resume)', () => {
  it('pausado: sem RAF, sem tique, sem feed aplicado nem resize; WASD e Esc não agem nem são consumidos', () => {
    const s = setup(demoFeed(Date.now()))
    s.flush(3)
    const timers = vi.getTimerCount()
    s.engine.pause()
    expect(s.engine.isPaused).toBe(true)
    expect(s.engine.running).toBe(false)
    expect(s.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(timers - 1)
    const feedBefore = s.engine.currentFeed
    const renders = s.renderer.renders
    const sync = vi.spyOn(OfficeScene.prototype, 'sync')
    s.emit(demoFeed(Date.now() + 5_000))
    s.resize(800, 600)
    vi.advanceTimersByTime(5_000)
    s.flush(5)
    expect(sync).not.toHaveBeenCalled()
    expect(s.engine.currentFeed).toBe(feedBefore)
    expect(s.renderer.renders).toBe(renders)
    expect(s.sizes.at(-1)).toEqual([1600, 900])
    for (const key of ['w', 'Escape']) {
      const ev = new KeyboardEvent('keydown', { key, cancelable: true })
      window.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
    }
    expect(s.pending()).toBe(0)
    s.engine.pause() // idempotente
    expect(vi.getTimerCount()).toBe(timers - 1)
    s.engine.dispose()
  })

  it('volta na hora com a mesma câmera, remede o palco e aplica o último feed sem os eventos do intervalo (dt ~0)', () => {
    const s = setup(demoFeed(Date.now()))
    s.flush(3)
    // O usuário afasta a câmera: a pose dele é a que tem de voltar.
    s.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, cancelable: true }))
    s.flush(2)
    const pose = { ...s.engine.rig.pose }
    s.engine.pause()
    const later = demoFeed(Date.now() + 24_500)
    s.emit(demoFeed(Date.now() + 10_000))
    s.emit(later)
    s.resize(1200, 700)
    s.wait(60_000)
    const feed = vi.spyOn(Speech.prototype, 'feed')
    const animate = vi.spyOn(OfficeScene.prototype, 'animate')
    const timers = vi.getTimerCount()
    s.engine.resume()
    expect(s.engine.isPaused).toBe(false)
    expect(vi.getTimerCount()).toBe(timers + 1)
    // Só o último feed, uma vez, sem eventos: nada do intervalo é "revivido".
    expect(feed).toHaveBeenCalledTimes(1)
    expect(feed.mock.calls[0][1]).toEqual([])
    expect(s.engine.currentFeed).toBe(later)
    expect(s.sizes.at(-1)).toEqual([1200, 700])
    expect(s.pending()).toBe(1)
    s.flush(1)
    const dt = animate.mock.calls[0][1] ?? 0
    expect(dt).toBeLessThanOrEqual(0.017)
    expect(s.engine.rig.pose).toEqual(pose)
    s.engine.resume() // idempotente
    expect(vi.getTimerCount()).toBe(timers + 1)
    s.engine.dispose()
  })

  it('volta da pausa com o apagão no intervalo: a energia muda de nível com o evento null (sem cascata nem "Acabou a luz!")', () => {
    const limits = (extra: Partial<RateLimitStatus>): OfficeFeed['usageLimits'] => ({
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.3, resetsAt: Date.now() + 3_600_000, ...extra } as RateLimitStatus
    })
    const s = setup({ ...demoFeed(Date.now()), usageLimits: limits({}) })
    s.flush(2)
    expect(s.engine.officePower?.level).toBe('cheia')
    s.engine.pause()
    s.emit({ ...demoFeed(Date.now() + 5_000), usageLimits: limits({ status: 'rejected', utilization: 1 }) })
    const setPower = vi.spyOn(OfficeScene.prototype, 'setPower')
    const feed = vi.spyOn(Speech.prototype, 'feed')
    const tick = vi.spyOn(Speech.prototype, 'tick')
    s.engine.resume()
    expect(s.engine.officePower?.level).toBe('apagao')
    expect(setPower).toHaveBeenCalledTimes(1)
    expect(setPower.mock.calls[0][0]).toMatchObject({ level: 'apagao' })
    expect(setPower.mock.calls[0][1]).toBeNull()
    expect(feed.mock.calls[0][3]).toMatchObject({ level: 'apagao', event: null })
    // Os tiques seguintes também não trazem o evento de volta.
    vi.advanceTimersByTime(3 * QUIP_TICK_MS)
    expect(tick).toHaveBeenCalled()
    expect(tick.mock.calls.every(([, power]) => (power?.event ?? null) === null)).toBe(true)
    s.engine.dispose()
  })

  it('volta da pausa SEM feed novo, depois do reset da janela: reaplica o último feed e a luz volta sem o evento', () => {
    const resetsAt = Date.now() + 60_000
    const five = { rateLimitType: 'five_hour', status: 'rejected', utilization: 1, resetsAt } as RateLimitStatus
    const s = setup({ ...demoFeed(Date.now()), usageLimits: { five_hour: five } })
    s.flush(2)
    expect(s.engine.officePower?.level).toBe('apagao')
    s.engine.pause()
    vi.setSystemTime(resetsAt + 1_000) // o reset passou com a aba fechada; nenhum feed chegou
    const setPower = vi.spyOn(OfficeScene.prototype, 'setPower')
    const feed = vi.spyOn(Speech.prototype, 'feed')
    s.engine.resume()
    expect(s.engine.officePower).toMatchObject({ level: 'cheia', pct: 100 })
    expect(setPower.mock.calls[0][0]).toMatchObject({ level: 'cheia' })
    expect(setPower.mock.calls[0][1]).toBeNull()
    expect(feed).toHaveBeenCalledTimes(1)
    expect(feed.mock.calls[0][1]).toEqual([])
    expect(feed.mock.calls[0][3]).toMatchObject({ level: 'cheia', event: null })
    s.engine.dispose()
  })

  it('pausar e voltar 5×: o tique e o laço nunca duplicam; dispose limpa tudo', () => {
    const s = setup(demoFeed(Date.now()))
    s.flush(2)
    const timers = vi.getTimerCount()
    for (let i = 0; i < 5; i++) {
      s.engine.pause()
      s.engine.resume()
      expect(s.pending()).toBe(1)
      expect(vi.getTimerCount()).toBe(timers)
    }
    s.engine.pause()
    s.engine.dispose()
    expect(vi.getTimerCount()).toBe(0)
    s.engine.resume() // morto: não volta
    expect(s.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Office3DEngine — voar até o agente', () => {
  it('flyToAgent: até a mesa (ou onde ele está) sem abrir a tela; quem não está no escritório devolve false', () => {
    const s = setup(demoFeed(Date.now()))
    s.flush(2)
    const key = 'conv:demo-0-1'
    const b = s.engine.scene.crowd.brains.get(key)!
    expect(b.desk).toBeTruthy()
    expect(s.engine.flyToAgent(key, 'desk')).toBe(true)
    s.flush(40)
    expect(s.engine.rig.pose).toEqual(agentPose(b.desk!))
    expect(s.engine.focused).toBeNull()
    // Com a tela de outro agente aberta, o voo fecha a tela.
    s.engine.focus('conv:demo-0-2')
    expect(s.engine.focused).toBe('conv:demo-0-2')
    expect(s.engine.flyToAgent(key)).toBe(true)
    expect(s.engine.focused).toBeNull()
    expect(s.engine.flyToAgent('conv:ninguem')).toBe(false)
    s.engine.dispose()
  })

  it(`follow: a conversa escolhida fora do 3D leva a câmera, salvo se o usuário mexeu nela há menos de ${FOLLOW_GRACE_MS} ms`, () => {
    const s = setup(demoFeed(Date.now()))
    s.flush(2)
    const fly = vi.spyOn(s.engine, 'flyToAgent')
    expect(s.engine.follow('demo-1-0')).toBe(true)
    expect(fly).toHaveBeenLastCalledWith('conv:demo-1-0')
    s.flush(40)
    // O usuário gira a câmera (roda): a seleção logo depois não a leva embora.
    s.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }))
    s.flush(1)
    const mine = { ...s.engine.rig.pose }
    expect(s.engine.follow('demo-2-0')).toBe(false)
    s.flush(40)
    expect(s.engine.rig.pose).toEqual(mine)
    s.wait(FOLLOW_GRACE_MS)
    expect(s.engine.follow('demo-2-0')).toBe(true)
    expect(s.engine.follow('nao-existe')).toBe(false)
    s.engine.dispose()
  })

  it('follow de conversa que ainda não estava no escritório: voa quando o próximo feed a traz (uma vez só)', () => {
    const first = demoFeed(Date.now())
    const s = setup(first)
    s.flush(2)
    const fly = vi.spyOn(s.engine, 'flyToAgent')
    // A conversa antiga entra no escritório quando vira a ativa — no feed seguinte à escolha.
    const old = { ...first.conversations[0], id: 'antiga', updatedAt: Date.now() - 48 * 3_600_000 }
    const withOld = { ...first, conversations: [...first.conversations, old] }
    expect(s.engine.follow('antiga')).toBe(false)
    s.emit({ ...withOld, activeId: 'antiga' })
    expect(fly).toHaveBeenLastCalledWith('conv:antiga')
    expect(fly.mock.results.at(-1)?.value).toBe(true)
    // Feed seguinte: não voa de novo.
    const calls = fly.mock.calls.length
    s.emit({ ...withOld, activeId: 'antiga' })
    expect(fly.mock.calls.length).toBe(calls)
    s.engine.dispose()
  })
})
