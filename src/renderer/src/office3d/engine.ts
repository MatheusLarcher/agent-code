/**
 * Motor do escritório 3D: renderer + câmera + entrada + laço sob demanda.
 *
 * O laço RAF só roda enquanto há motivo — tecla de movimento segurada, tween,
 * personagem À VISTA animando (agente acordado na sala conta: ele vagueia) ou
 * algo marcou a cena como suja (feed, arrasto, roda, resize, balão novo). Se só
 * sobra animação de baixa prioridade (personagens no LOD longe), o laço cai
 * para ~30 quadros/s. Documento oculto não agenda quadro; voltar a ficar
 * visível agenda. `dispose()` desfaz tudo: RAF, tique das falas,
 * ResizeObserver, listeners, balões, cena e renderer.
 *
 * Desempenho: quando a câmera muda, a cena refaz o culling por sala e o LOD
 * pela distância (scene.updateView); o nível global (quality.ts) ajusta o
 * pixelRatio, a névoa e a sombra do sol, e o shadow map só é refeito quando
 * algo que projeta sombra mudou. Nada aloca por quadro no caminho quente
 * (câmera, voo, culling, balões, tela do foco). `stats` alimenta o HUD de DEV.
 *
 * A cada feed: retrato de events.ts (snapshotOf) e o que mudou desde o
 * anterior (diffEvents) vão para a cena (cérebros) e para as falas
 * (speech.ts); um tique de QUIP_TICK_MS deixa as falas andarem sem feed.
 * `headWorldPosition(key, out)` dá o centro da cabeça de um personagem (âncora
 * dos balões). Clicar num balão foca o agente, como clicar nele.
 */
import { Matrix4, PCFShadowMap, PerspectiveCamera, Vector3, WebGLRenderer, type Camera, type Scene } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { cameraPosition, CameraRig, framePose, monitorPose, type CameraPose, type ViewSize } from './cameraRig'
import { diffEvents, snapshotOf, type OfficeSnapshot } from './events'
import { clampDt, dragModeFor, isClick, isTypingTarget, MoveKeys, moveDelta, type DragMode } from './input'
import { buildingBounds, EMPTY_LAYOUT, layoutOffice, monitorPosition, type Office3DLayout } from './layout'
import { LOW_RATE_MS } from './lod'
import { Quality, type EngineStats } from './quality'
import { OfficeScene } from './scene'
import { ScreenAnchor } from './screenAnchor'
import { QUIP_TICK_MS, Speech } from './speech'

export type { EngineStats } from './quality'

export interface RendererLike {
  setPixelRatio(ratio: number): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  render(scene: Scene, camera: Camera): void
  dispose(): void
  /** WebGLRenderer real: anisotropia máxima para placas e telas nítidas. */
  capabilities?: { getMaxAnisotropy(): number }
  /** WebGLRenderer real: shadow map refeito só quando o motor pede (autoUpdate desligado). */
  shadowMap?: { autoUpdate: boolean; needsUpdate: boolean }
  /** WebGLRenderer real: contadores do último quadro (HUD de desempenho). */
  info?: { render: { calls: number; triangles: number } }
}

/** Renderer padrão: antialias e sombras suaves (só a luz principal projeta), refeitas sob demanda. */
export function createDefaultRenderer(canvas: HTMLCanvasElement): RendererLike {
  const r = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  r.shadowMap.enabled = true
  r.shadowMap.type = PCFShadowMap
  r.shadowMap.autoUpdate = false
  r.shadowMap.needsUpdate = true
  return r
}

export interface FeedSource {
  getSnapshot(): OfficeFeed | null
  subscribe(cb: (feed: OfficeFeed) => void): () => void
}

export interface EngineOptions {
  createRenderer?: (canvas: HTMLCanvasElement) => RendererLike
  raf?: (cb: FrameRequestCallback) => number
  caf?: (id: number) => void
  now?: () => number
  source?: FeedSource
}

export interface EngineCallbacks {
  /** Personagem enquadrado (tela aberta) ou null ao voltar. */
  onFocus(key: string | null): void
  /** Duplo clique no personagem. */
  onOpen(convId: string): void
}

export const MAX_PIXEL_RATIO = 2
/** Altura até onde vai o conteúdo das salas (placas, indicador de permissão). */
const BUILDING_HEIGHT = 1.8

export class Office3DEngine {
  readonly scene: OfficeScene
  readonly camera = new PerspectiveCamera(50, 1, 0.05, 250)
  readonly rig = new CameraRig({ tx: 6, ty: 0, tz: 5, yaw: 0, pitch: 0.9, distance: 16 })
  private readonly renderer: RendererLike
  private readonly quality: Quality
  private readonly speech: Speech
  private readonly anchor = new ScreenAnchor()
  private readonly keys = new MoveKeys()
  private readonly raf: (cb: FrameRequestCallback) => number
  private readonly caf: (id: number) => void
  private readonly now: () => number
  private readonly cleanups: Array<() => void> = []
  private layout: Office3DLayout = EMPTY_LAYOUT
  private feed: OfficeFeed | null = null
  /** Último retrato de events.ts (base do diff); null antes do 1º feed. */
  private snapshot: OfficeSnapshot | null = null
  /** Rascunhos reaproveitados a cada quadro (nada aloca no laço). */
  private readonly camPos = { x: 0, y: 0, z: 0 }
  private readonly wasd = { dx: 0, dz: 0 }
  private readonly lastView = new Matrix4()
  private readonly lastProj = new Matrix4()
  private readonly headOf = (key: string, out: Vector3): boolean => this.scene.headWorldPosition(key, out)
  private rafId = 0
  private lastFrame = 0
  /** Só sobrou animação de baixa prioridade: o próximo quadro espera LOW_RATE_MS. */
  private lowRate = false
  private tick: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Enquanto o usuário não mexe na câmera, ela segue enquadrando o prédio inteiro. */
  private autoFrame = true
  private width = 1
  private height = 1
  private drag: { mode: DragMode; button: number; x0: number; y0: number; x: number; y: number } | null = null
  private focusedKey: string | null = null
  private returnPose: CameraPose | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: EngineCallbacks,
    opts: EngineOptions = {}
  ) {
    this.raf = opts.raf ?? ((f) => requestAnimationFrame(f))
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id))
    this.now = opts.now ?? (() => performance.now())
    this.renderer = (opts.createRenderer ?? createDefaultRenderer)(canvas)
    this.quality = new Quality(this.renderer, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    this.scene = new OfficeScene(Math.min(8, this.renderer.capabilities?.getMaxAnisotropy() ?? 1))
    this.scene.onDirty = () => this.requestRender()
    this.speech = new Speech(container, (key) => this.focus(key))
    this.bindInput()
    this.observeSize()
    const source = opts.source ?? officeStore
    const snap = source.getSnapshot()
    if (snap) this.applyFeed(snap)
    this.cleanups.push(source.subscribe((f) => this.applyFeed(f)))
    this.tick = setInterval(this.tickQuips, QUIP_TICK_MS)
    this.requestRender()
  }

  private listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void
  private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void
  private listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void
  private listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    const h = fn as EventListener
    target.addEventListener(type, h, opts)
    this.cleanups.push(() => target.removeEventListener(type, h, opts))
  }

  private bindInput(): void {
    const c = this.canvas
    this.listen(c, 'contextmenu', (e) => e.preventDefault())
    this.listen(c, 'pointerdown', (e) => {
      const mode = dragModeFor(e.button)
      if (!mode) return
      if (e.button === 1) e.preventDefault()
      this.drag = { mode, button: e.button, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY }
    })
    this.listen(window, 'pointermove', (e) => {
      const d = this.drag
      if (!d) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      if (isClick(e.clientX - d.x0, e.clientY - d.y0)) return
      this.leaveFocus(false)
      this.autoFrame = false
      if (d.mode === 'orbit') this.rig.orbit(dx, dy)
      else this.rig.pan(dx, dy)
      this.requestRender()
    })
    this.listen(window, 'pointerup', (e) => {
      const d = this.drag
      this.drag = null
      if (!d || d.button !== 0 || !isClick(e.clientX - d.x0, e.clientY - d.y0)) return
      const key = this.pickAt(e.clientX, e.clientY)
      if (key) this.focus(key)
      else this.leaveFocus(true)
    })
    this.listen(c, 'dblclick', (e) => {
      const key = this.pickAt(e.clientX, e.clientY)
      const conv = key ? this.scene.character(key)?.model.convId : undefined
      if (conv) this.cb.onOpen(conv)
    })
    this.listen(
      c,
      'wheel',
      (e) => {
        e.preventDefault()
        this.leaveFocus(false)
        this.autoFrame = false
        this.rig.zoom(e.deltaY)
        this.requestRender()
      },
      { passive: false }
    )
    this.listen(window, 'keydown', (e) => {
      if (e.key === 'Escape' && this.focusedKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        this.leaveFocus(true)
        return
      }
      if (this.keys.down(e)) {
        e.preventDefault()
        this.requestRender()
      }
    })
    this.listen(window, 'keyup', (e) => this.keys.up(e))
    this.listen(window, 'blur', () => this.keys.clear())
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.cancelFrame()
      else this.requestRender()
    })
  }

  private observeSize(): void {
    const resize = (): void => {
      this.width = Math.max(1, this.container.clientWidth)
      this.height = Math.max(1, this.container.clientHeight)
      this.renderer.setSize(this.width, this.height, false)
      this.camera.aspect = this.width / this.height
      this.camera.updateProjectionMatrix()
      // Reenquadra com o novo aspect: a tela aberta ou, se ninguém mexeu, o prédio.
      if (this.focusedKey) {
        const to = this.focusPose(this.focusedKey)
        if (to) this.rig.retarget(to)
      } else if (this.autoFrame) {
        this.frameBuilding()
      }
      this.requestRender()
    }
    resize()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(resize)
      ro.observe(this.container)
      this.cleanups.push(() => ro.disconnect())
    } else {
      this.listen(window, 'resize', resize)
    }
  }

  private applyFeed(feed: OfficeFeed): void {
    this.feed = feed
    const wallNow = Date.now()
    const model = deriveOfficeModel(feed, wallNow)
    this.layout = layoutOffice(model, this.layout)
    const snapshot = snapshotOf(feed, model, wallNow)
    const events = diffEvents(this.snapshot, snapshot, wallNow)
    this.snapshot = snapshot
    this.scene.sync(this.layout, feed, { snapshot, events, wallNow, t: this.now() / 1000 })
    this.speech.feed(snapshot, events, wallNow)
    if (this.autoFrame && !this.focusedKey) this.frameBuilding()
    if (this.focusedKey && !this.scene.character(this.focusedKey)) this.leaveFocus(true)
    else if (this.focusedKey) this.focusPose(this.focusedKey) // a mesa pode ter andado: a tela acompanha
    this.requestRender()
  }

  /** Falas andam com o relógio mesmo sem feed (TTL, ociosos): balão novo pede um quadro. */
  private readonly tickQuips = (): void => {
    if (!this.disposed && !document.hidden && this.speech.tick(Date.now())) this.requestRender()
  }

  private get view(): ViewSize {
    return { fovDeg: this.camera.fov, aspect: this.width / this.height }
  }

  /** Enquadra todas as salas no palco atual. */
  private frameBuilding(): void {
    const b = buildingBounds(this.layout.rooms)
    if (b) this.rig.pose = framePose({ ...b, height: BUILDING_HEIGHT }, this.view)
  }

  /** Pose que enquadra a tela do personagem (o monitor dele ou do pai); a tela HTML mira o mesmo monitor. */
  private focusPose(key: string): CameraPose | null {
    const c = this.scene.character(key)
    if (!c) return null
    const desk = c.screenDesk ? this.scene.room(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
    const m = desk ? monitorPosition(desk) : null
    this.anchor.aim(m)
    if (m) return monitorPose(m, this.view)
    return { tx: c.x, ty: 1, tz: c.z, yaw: 0, pitch: 0.3, distance: 2.6 }
  }

  get currentFeed(): OfficeFeed | null {
    return this.feed
  }

  /** Números do HUD de desempenho (DEV). */
  get stats(): EngineStats {
    return this.quality.stats
  }

  private pickAt(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect()
    const w = rect.width || this.width
    const h = rect.height || this.height
    const x = ((clientX - rect.left) / w) * 2 - 1
    const y = -((clientY - rect.top) / h) * 2 + 1
    this.syncCamera()
    return this.scene.pick(x, y, this.camera)
  }

  /** Voa até o monitor do personagem e abre a tela (ele olha para a câmera e acena). */
  focus(key: string): void {
    const to = this.focusPose(key)
    if (!to) return
    if (!this.focusedKey) this.returnPose = { ...this.rig.pose }
    this.autoFrame = false
    this.rig.flyTo(to, this.now())
    this.focusedKey = key
    this.scene.setFocus(key)
    this.scene.greet(key)
    this.cb.onFocus(key)
    this.requestRender()
  }

  /** Fecha a tela; com `back`, volta à câmera de antes do foco (e o agente dá tchau). */
  leaveFocus(back: boolean): void {
    const key = this.focusedKey
    if (!key) return
    this.focusedKey = null
    this.scene.setFocus(null)
    if (back && this.returnPose) {
      this.rig.flyTo(this.returnPose, this.now())
      this.scene.greet(key)
    }
    this.returnPose = null
    this.cb.onFocus(null)
    this.requestRender()
  }

  /** Centro da cabeça do personagem `key` no mundo, em `out`; false se ele não está à vista. */
  headWorldPosition(key: string, out: Vector3): boolean {
    return this.scene.headWorldPosition(key, out)
  }

  /** Modo demonstração (Ctrl+Alt+Shift+D): só acelera o relógio do cochilo. */
  setDemo(on: boolean): void {
    this.scene.setDemo(on)
    this.requestRender()
  }

  get focused(): string | null {
    return this.focusedKey
  }

  setScreenElement(el: HTMLElement | null): void {
    this.anchor.setElement(el)
    this.requestRender()
  }

  get running(): boolean {
    return this.rafId !== 0
  }

  requestRender(): void {
    this.lowRate = false
    if (this.disposed || this.rafId || document.hidden) return
    this.lastFrame = this.now()
    this.quality.restart(this.lastFrame)
    this.rafId = this.raf(this.frame)
  }

  private cancelFrame(): void {
    if (this.rafId) this.caf(this.rafId)
    this.rafId = 0
  }

  private readonly frame = (): void => {
    this.rafId = 0
    if (this.disposed || document.hidden) return
    const now = this.now()
    // Só animação de baixa prioridade (LOD longe): ~30 quadros/s.
    if (this.lowRate && now - this.lastFrame < LOW_RATE_MS - 2) {
      this.rafId = this.raf(this.frame)
      return
    }
    const dt = clampDt((now - this.lastFrame) / 1000)
    this.lastFrame = now
    const { dx, dz } = moveDelta(this.keys, this.rig.pose.yaw, dt, this.wasd)
    if (dx !== 0 || dz !== 0) {
      this.leaveFocus(false)
      this.autoFrame = false
      this.rig.move(dx, dz)
    }
    const tweening = this.rig.step(now)
    this.syncCamera()
    const moved = this.cameraMoved()
    if (moved || this.scene.viewDirty) this.quality.apply(this.scene, this.scene.updateView(this.camera, this.quality.level), this.rig.pose.distance)
    const animating = this.scene.animate(now / 1000, dt, this.camera.position)
    this.quality.shadows(this.scene)
    this.renderer.render(this.scene.scene, this.camera)
    this.quality.measure(now)
    if (this.focusedKey) this.anchor.place(this.camera, this.width, this.height)
    this.speech.place(this.camera, this.width, this.height, this.quality.level === 2, this.headOf)
    const full = this.keys.moving || tweening || this.scene.rate === 2
    this.lowRate = !full
    if ((full || animating) && !this.rafId) this.rafId = this.raf(this.frame)
  }

  private syncCamera(): void {
    const p = cameraPosition(this.rig.pose, this.camPos)
    this.camera.position.set(p.x, p.y, p.z)
    this.camera.lookAt(this.rig.pose.tx, this.rig.pose.ty, this.rig.pose.tz)
    this.camera.updateMatrixWorld()
  }

  /** A câmera mudou desde o último culling/LOD? (compara as matrizes, sem alocar) */
  private cameraMoved(): boolean {
    const c = this.camera
    if (c.matrixWorld.equals(this.lastView) && c.projectionMatrix.equals(this.lastProj)) return false
    this.lastView.copy(c.matrixWorld)
    this.lastProj.copy(c.projectionMatrix)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    if (this.tick !== null) clearInterval(this.tick)
    this.tick = null
    for (const off of this.cleanups.splice(0)) off()
    this.keys.clear()
    this.drag = null
    this.anchor.setElement(null)
    this.speech.dispose()
    this.scene.dispose()
    this.renderer.dispose()
  }
}
