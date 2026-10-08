import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Object3D } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type FeedSource, type RendererLike } from './engine'
import { WARMUP_LIMIT_MS } from './engineGpuWarmup'

class RO {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const feed = (): OfficeFeed => demoFeed(14_916_667 * DEMO_LOOP_MS)
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const program = (ready: boolean) => ({ isReady: () => ready, getUniforms: vi.fn<() => unknown>() })
type Program = ReturnType<typeof program>

/** Motor com um renderer falso cujo compileAsync só resolve quando o teste manda (`finish`; `hold` volta a segurar). */
function setup(initial: OfficeFeed | null, hang = false, programs: Program[] = []) {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  let push: (f: OfficeFeed) => void = () => undefined
  const source: FeedSource = { getSnapshot: () => initial, subscribe: (cb) => ((push = cb), () => undefined) }
  const waiting: Array<() => void> = []
  const gate = { open: false }
  const compiled: Object3D[] = []
  const renderer: RendererLike & { renders: number; uploads: number } = {
    renders: 0,
    uploads: 0,
    info: { render: { calls: 0, triangles: 0 }, programs },
    setPixelRatio() {},
    setSize() {},
    render() {
      this.renders++
    },
    dispose() {},
    initTexture() {
      this.uploads++
    },
    compileAsync(scene) {
      compiled.push(scene)
      if (gate.open) return Promise.resolve()
      return new Promise<void>((resolve) => void (hang || waiting.push(resolve)))
    }
  }
  const frames: FrameRequestCallback[] = []
  const engine = new Office3DEngine(container, canvas, { onFocus: vi.fn(), onOpen: vi.fn() }, {
    createRenderer: () => renderer,
    raf: (cb) => frames.push(cb),
    caf: () => void frames.splice(0),
    now: () => 0,
    source,
    browser: null,
    board: null
  })
  const finish = (): void => {
    gate.open = true
    waiting.splice(0).forEach((resolve) => resolve())
  }
  const hold = (): void => void (gate.open = false)
  return { engine, renderer, frames, compiled, finish, hold, push: (f: OfficeFeed) => push(f) }
}

describe('Escritório 3D — shaders compilados antes do 1º quadro', () => {
  it('com compileAsync, nenhum quadro desenha até a compilação terminar; depois, o laço segue', async () => {
    const { engine, renderer, frames, compiled, finish } = setup(feed())
    // Peça por peça da cena (cada compile numa fatia), com as luzes da cena inteira.
    expect(compiled.length).toBeGreaterThan(1)
    expect(compiled.every((piece) => piece.parent === engine.scene.scene)).toBe(true)
    expect(frames).toHaveLength(0)
    engine.requestRender()
    expect(frames).toHaveLength(0)
    finish()
    for (let i = 0; i < 20 && !frames.length; i++) await settle()
    expect(frames.length).toBeGreaterThan(0)
    frames.shift()?.(0)
    expect(renderer.renders).toBe(1)
    engine.dispose()
  })

  it('o 1º uso de cada programa pronto (as posições dos uniforms) sai antes do 1º quadro; o que não ficou pronto fica para o quadro', async () => {
    const ready = [program(true), program(true)]
    const linking = program(false)
    const { engine, frames, finish } = setup(feed(), false, [...ready, linking])
    expect(ready[0].getUniforms).not.toHaveBeenCalled()
    finish()
    for (let i = 0; i < 20 && !frames.length; i++) await settle()
    expect(frames.length).toBeGreaterThan(0)
    for (const p of ready) expect(p.getUniforms).toHaveBeenCalledTimes(1)
    expect(linking.getUniforms).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('a sala que entra depois (projeto novo) compila antes de o quadro desenhá-la', async () => {
    const { engine, renderer, frames, compiled, finish, hold, push } = setup(null)
    finish()
    for (let i = 0; i < 20 && !frames.length; i++) await settle()
    const before = compiled.length
    hold()
    push(feed())
    expect(compiled.length).toBeGreaterThan(before)
    // O quadro que já estava pedido não desenha enquanto a sala compila.
    frames.splice(0).forEach((frame) => frame(0))
    expect(renderer.renders).toBe(0)
    finish()
    for (let i = 0; i < 20 && !frames.length; i++) await settle()
    frames.splice(0).forEach((frame) => frame(0))
    expect(renderer.renders).toBe(1)
    engine.dispose()
  })

  it('compilação que não termina (contexto perdido) solta os quadros depois de WARMUP_LIMIT_MS', async () => {
    vi.useFakeTimers()
    const { engine, frames } = setup(feed(), true)
    await vi.advanceTimersByTimeAsync(WARMUP_LIMIT_MS - 100)
    expect(frames).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(frames.length).toBeGreaterThan(0)
    engine.dispose()
  })
})

describe('Escritório 3D — pré-carregado com a aba fechada', () => {
  it('compila, sobe as texturas e desenha um quadro invisível; abrir a aba remede o palco e só desenha', async () => {
    const { engine, renderer, frames, finish } = setup(feed())
    engine.pause()
    finish()
    for (let i = 0; i < 200 && renderer.renders === 0; i++) await settle()
    expect(renderer.renders).toBe(1)
    expect(frames).toHaveLength(0)
    const resize = vi.spyOn(renderer, 'setSize')
    engine.resume()
    expect(resize).toHaveBeenCalledWith(1600, 900, false)
    frames.splice(0).forEach((frame) => frame(0))
    expect(renderer.renders).toBe(2)
    engine.dispose()
  })

  it('a aba abriu antes de a compilação terminar: nada de pré-carga, o quadro desenha direto', async () => {
    const { engine, renderer, frames, finish } = setup(feed())
    engine.pause()
    engine.resume()
    finish()
    for (let i = 0; i < 20 && !frames.length; i++) await settle()
    expect(renderer.uploads).toBe(0)
    expect(renderer.renders).toBe(0)
    frames.splice(0).forEach((frame) => frame(0))
    expect(renderer.renders).toBe(1)
    engine.dispose()
  })
})
