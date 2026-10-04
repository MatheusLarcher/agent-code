/**
 * Motor do escritório 3D: renderer + câmera + entrada + laço sob demanda.
 *
 * O laço RAF só roda enquanto há motivo — tecla de movimento, tween, personagem À VISTA animando
 * ou cena suja (feed, arrasto, roda, resize, balão novo, quadro do navegador); animação de LOD
 * longe cai para ~30 quadros/s; documento oculto não agenda quadro. `dispose()` desfaz tudo.
 *
 * Aba fechada (`pause()`): sem RAF, tique, feed aplicado (o último fica guardado), resize nem
 * quadro do navegador. `resume()` remede o palco e reaplica o último feed SEM os eventos do
 * intervalo, nem o da energia.
 *
 * Desempenho: culling/LOD por zona (scene.updateView); quality.ts ajusta pixelRatio, névoa e sombra.
 *
 * A cada feed: retrato de events.ts e o diff vão para a cena e as falas (speech.ts); um tique de
 * QUIP_TICK_MS anda sem feed as falas, a energia, a TV e o hover atrasado. Ponteiro em
 * pointerInput.ts: clique foca o agente (ou a TV: `onProjector`), duplo clique abre a conversa,
 * hover vai a `onHover`. `onFocus` diz se foi o usuário (`byUser`). `flyToAgent`/`follow` voam
 * sem abrir a tela (`follow` respeita FOLLOW_GRACE_MS). Kanban = o Quadro real (`board`).
 * Filtro de projeto do HUD: `setProjectFilter`, `filter.current`/`filter.onChange` e `onProjects`. */
import { PerspectiveCamera, Vector3 } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel, principalKey } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { EngineBoard } from './board/engineBoard'
import { appBrowserApi } from './browserFrames'
import { agentPose, CameraRig, framePose, monitorPose, type CameraPose } from './cameraRig'
import { CameraSync } from './cameraSync'
import { EngineFilter } from './engineFilter'
import { EnginePower } from './enginePower'
import { createDefaultRenderer, listener, PROJECTOR_KEY, type EngineCallbacks, type EngineOptions, type RendererLike } from './engineTypes'
import { diffEvents, snapshotOf, type OfficeSnapshot } from './events'
import { clampDt, isTypingTarget, MoveKeys, moveDelta } from './input'
import { buildingBounds, EMPTY_LAYOUT, layoutOffice, monitorPosition, type Office3DLayout } from './layout'
import { LOW_RATE_MS } from './lod'
import { bindKeys, PointerInput } from './pointerInput'
import type { OfficePower } from './power'
import { Quality, type EngineStats } from './quality'
import { OfficeScene } from './scene'
import { focusView, PreviewAnchor, ScreenAnchor } from './screenAnchor'
import { QUIP_TICK_MS, Speech } from './speech'

export type { EngineStats } from './quality'
export { createDefaultRenderer, type EngineCallbacks, type EngineOptions, type FeedSource, type RendererLike } from './engineTypes'

export const MAX_PIXEL_RATIO = 2
/** Altura até onde vai o conteúdo do escritório (o alto da parede do fundo). */
const BUILDING_HEIGHT = 2.8
/** A conversa escolhida fora do 3D não leva a câmera se o usuário mexeu nela há menos disto (ms). */
export const FOLLOW_GRACE_MS = 2000

export class Office3DEngine {
  readonly scene: OfficeScene
  readonly camera = new PerspectiveCamera(50, 1, 0.05, 250)
  readonly rig = new CameraRig({ tx: 6, ty: 0, tz: 5, yaw: 0, pitch: 0.9, distance: 16 })
  private readonly camSync = new CameraSync(this.camera, this.rig)
  private readonly renderer: RendererLike
  private readonly quality: Quality
  private readonly speech: Speech
  private readonly power: EnginePower
  /** O Quadro real nas salas: dados, clique, arrasto, dica e `open(id)` (board/engineBoard.ts). */
  readonly board: EngineBoard
  /** Filtro de projeto (engineFilter.ts): a escolha salva, o filtro em vigor e a lista do HUD. */
  readonly filter: EngineFilter
  private readonly anchor = new ScreenAnchor()
  /** A prévia do hover, acima do monitor do agente. */
  private readonly preview = new PreviewAnchor()
  private readonly pointer: PointerInput
  private readonly keys = new MoveKeys()
  private readonly raf: (cb: FrameRequestCallback) => number
  private readonly caf: (id: number) => void
  private readonly now: () => number
  private readonly cleanups: Array<() => void> = []
  private readonly listen = listener(this.cleanups)
  private layout: Office3DLayout = EMPTY_LAYOUT
  private feed: OfficeFeed | null = null
  /** Último retrato de events.ts (base do diff); null antes do 1º feed. */
  private snapshot: OfficeSnapshot | null = null
  /** Rascunho reaproveitado a cada quadro (nada aloca no laço). */
  private readonly wasd = { dx: 0, dz: 0 }
  private readonly headOf = (key: string, out: Vector3): boolean => this.scene.headWorldPosition(key, out)
  private rafId = 0
  private lastFrame = 0
  /** Só sobrou animação de baixa prioridade: o próximo quadro espera LOW_RATE_MS. */
  private lowRate = false
  private tick: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Aba fechada: nada roda; o feed que chegar fica em `pending` e o resize em `sizeStale`. */
  private paused = false
  private pending: OfficeFeed | null = null
  private sizeStale = false
  /** Último gesto do usuário na câmera (relógio do motor, ms) e o `follow` que espera o agente chegar. */
  private userCamAt = -Infinity
  private followNext: string | null = null
  /** Enquanto o usuário não mexe na câmera, ela segue enquadrando o prédio inteiro. */
  private autoFrame = true
  private width = 1
  private height = 1
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
    this.power = new EnginePower(this.scene, (p) => this.cb.onPower?.(p))
    this.filter = new EngineFilter((id) => this.scene.setProjectFilter(id, this.paused || document.hidden), (list, id) => this.cb.onProjects?.(list, id))
    this.speech = new Speech(container, (key) => this.bubbleClick(key))
    // Quadro do navegador: é da conversa ativa; com a aba fechada fica só guardado.
    this.scene.projectors.connect(opts.browser === undefined ? appBrowserApi() : opts.browser, () => this.feed?.activeId ?? null, () => this.paused)
    this.board = new EngineBoard(this.scene, container, this.camera, this.listen, opts.board, cb, () => this.requestRender())
    this.filter.onChange((id) => this.board.setFilter(id))
    this.board.attach((key, quip) => this.speech.say(key, quip) && this.requestRender(), () => this.feed && !this.paused && this.applyFeed(this.feed))
    this.pointer = this.board.bind(this.bindPointer())
    this.bindInput()
    this.observeSize()
    const source = opts.source ?? officeStore
    const snap = source.getSnapshot()
    if (snap) this.applyFeed(snap)
    this.cleanups.push(source.subscribe((f) => this.applyFeed(f)))
    this.tick = setInterval(this.tickQuips, QUIP_TICK_MS)
    this.requestRender()
  }

  /** Ponteiro (pointerInput.ts): girar/arrastar, clique, duplo clique, roda e hover. */
  private bindPointer(): PointerInput {
    const camera = (): void => {
      this.leaveFocus(false, true)
      this.userMoved()
      this.requestRender()
    }
    return new PointerInput(this.canvas, this.listen, this.board.wrap({
      pick: (x, y) => {
        this.camSync.sync()
        return this.scene.pick(x, y, this.camera)
      },
      drag: (mode, dx, dy) => {
        if (mode === 'orbit') this.rig.orbit(dx, dy)
        else this.rig.pan(dx, dy)
        camera()
      },
      click: (key) => {
        this.userCamAt = this.now()
        if (key?.startsWith(PROJECTOR_KEY)) return this.cb.onProjector?.(key.slice(PROJECTOR_KEY.length))
        if (key) this.focus(key)
        else this.leaveFocus(true, true)
      },
      open: (key) => {
        const conv = key ? this.scene.character(key)?.model.convId : undefined
        if (conv) this.cb.onOpen(conv)
      },
      zoom: (dy) => {
        this.rig.zoom(dy)
        camera()
      },
      hover: (key) => this.cb.onHover?.(key),
      now: () => this.now()
    }))
  }

  /** Teclado (pointerInput.ts): Esc fecha a tela aberta, WASD anda, documento oculto para o laço. */
  private bindInput(): void {
    bindKeys(this.listen, this.keys, {
      paused: () => this.paused,
      escape: (target) => this.escape(target),
      moved: () => this.requestRender(),
      hidden: (hidden) => (hidden ? this.cancelFrame() : this.requestRender())
    })
  }

  /** Esc fecha a tela aberta (fora de campo de texto); true se consumiu. */
  private escape(target: EventTarget | null): boolean {
    if (!this.focusedKey || isTypingTarget(target)) return false
    this.userCamAt = this.now()
    this.leaveFocus(true, true)
    return true
  }

  /** Balão clicado: o de um pedido (permissão, pergunta) leva ao pedido da conversa; os outros focam o agente. */
  private bubbleClick(key: string): void {
    const quip = this.speech.quipOf(key)
    if (quip?.kind === 'board' && this.board.openFromBubble(key)) return
    if (quip?.kind === 'permission' && this.cb.onFocusRequest) return this.cb.onFocusRequest(quip.convId)
    this.userCamAt = this.now()
    this.focus(key)
  }

  /** O usuário mexeu na câmera: ela para de enquadrar o prédio e a seleção de fora espera FOLLOW_GRACE_MS. */
  private userMoved(): void {
    this.autoFrame = false
    this.userCamAt = this.now()
  }

  private observeSize(): void {
    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize())
      ro.observe(this.container)
      this.cleanups.push(() => ro.disconnect())
    } else {
      this.listen(window, 'resize', () => this.resize())
    }
  }

  private resize(): void {
    // Pausado o palco está escondido (0×0): só anota; a volta remede.
    if (this.paused) {
      this.sizeStale = true
      return
    }
    this.sizeStale = false
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

  /** `catchUp`: volta da pausa — o retrato novo vira a base sem os eventos do intervalo. */
  private applyFeed(feed: OfficeFeed, catchUp = false): void {
    if (this.paused) {
      this.pending = feed
      return
    }
    this.feed = feed
    const wallNow = Date.now()
    const model = deriveOfficeModel(feed, wallNow, this.board.boardRooms)
    this.layout = layoutOffice(model, this.layout)
    // O filtro antes do sync: quem chega de projeto filtrado fora já nasce lá fora.
    this.filter.feed(this.layout.projects)
    const snapshot = snapshotOf(feed, model, wallNow)
    const events = catchUp ? [] : diffEvents(this.snapshot, snapshot, wallNow)
    this.snapshot = snapshot
    // A energia antes do sync: sala no escuro já monta com a tela preta (na volta da pausa, sem o evento).
    const powerEvent = this.power.read(feed, wallNow, this.now() / 1000, catchUp)
    this.scene.sync(this.layout, feed, { snapshot, events, wallNow, t: this.now() / 1000 })
    this.board.feed(feed, this.layout)
    this.speech.feed(snapshot, events, wallNow, this.power.quip(powerEvent))
    this.power.emit()
    if (this.autoFrame && !this.focusedKey) this.frameBuilding()
    if (this.focusedKey && !this.scene.character(this.focusedKey)) this.leaveFocus(true)
    else if (this.focusedKey) this.focusPose(this.focusedKey) // a mesa pode ter andado: a tela acompanha
    const next = this.followNext
    this.followNext = null
    if (next && this.now() - this.userCamAt >= FOLLOW_GRACE_MS) this.flyToAgent(principalKey(next))
    this.requestRender()
  }

  /** Falas e energia andam com o relógio mesmo sem feed (TTL, ociosos, reset que passou): mudança pede um quadro. */
  private readonly tickQuips = (): void => {
    if (this.disposed || this.paused || document.hidden) return
    const now = Date.now()
    this.pointer.flushHover()
    const { event, changed } = this.power.tick(this.feed, now, this.now() / 1000)
    this.power.emit()
    const screens = this.scene.projectors.tick(now)
    const board = this.board.tick(now)
    if (this.speech.tick(now, this.power.quip(event)) || changed || screens || board) this.requestRender()
  }

  /** A energia em vigor (a barra e os testes leem). */
  get officePower(): OfficePower | null {
    return this.power.power
  }

  /** Filtro de projeto do HUD (null = Todos): os outros saem pela porta; pausado ou fora da tela, direto ao fim. */
  setProjectFilter(id: string | null): void {
    this.filter.set(id)
    this.requestRender()
  }

  /** Só DEV (Ctrl+Alt+Shift+B): força o próximo nível de energia, em ciclo, para testar. */
  cyclePower(): void {
    const event = this.power.cycle(Date.now(), this.now() / 1000)
    this.power.emit()
    this.speech.tick(Date.now(), this.power.quip(event))
    this.requestRender()
  }

  /** Enquadra o escritório inteiro no palco atual. */
  private frameBuilding(): void {
    const b = buildingBounds(this.layout.rooms)
    if (b) this.rig.pose = framePose({ ...b, height: BUILDING_HEIGHT }, { fovDeg: this.camera.fov, aspect: this.width / this.height })
  }

  /** Pose que enquadra a tela do personagem (o monitor dele ou do pai); a tela HTML mira o mesmo monitor. */
  private focusPose(key: string): CameraPose | null {
    const c = this.scene.character(key)
    if (!c) return null
    const desk = c.screenDesk ? this.scene.room(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
    const m = desk ? monitorPosition(desk) : null
    this.anchor.aim(m)
    // A mesma vista da âncora (a faixa do HUD livre): a tela HTML tem o tamanho da tela projetada nesta pose.
    if (m) return monitorPose(m, focusView(this.camera.fov, this.width, this.height))
    return { tx: c.x, ty: 1, tz: c.z, yaw: 0, pitch: 0.3, distance: 2.6 }
  }

  get currentFeed(): OfficeFeed | null {
    return this.feed
  }

  /** Números do HUD de desempenho (DEV). */
  get stats(): EngineStats {
    return this.quality.stats
  }

  /** Voa até o monitor do personagem e abre a tela (ele olha para a câmera e acena). */
  focus(key: string, byUser = true): void {
    const to = this.focusPose(key)
    if (!to) return
    if (!this.focusedKey) this.returnPose = { ...this.rig.pose }
    this.autoFrame = false
    this.rig.flyTo(to, this.now())
    this.focusedKey = key
    this.scene.setFocus(key)
    this.scene.greet(key)
    this.cb.onFocus(key, byUser)
    this.requestRender()
  }

  /** Fecha a tela; com `back`, volta à câmera de antes do foco (e o agente dá tchau). `byUser`: foi o usuário. */
  leaveFocus(back: boolean, byUser = false): void {
    const key = this.focusedKey
    if (!key) return
    this.focusedKey = null
    this.scene.setFocus(null)
    if (back && this.returnPose) {
      this.rig.flyTo(this.returnPose, this.now())
      this.scene.greet(key)
    }
    this.returnPose = null
    this.cb.onFocus(null, byUser)
    this.requestRender()
  }

  /** Voa até o agente `key` — a mesa dele (`desk`) ou onde ele está agora — sem abrir a tela; false se ele não está no escritório. */
  flyToAgent(key: string, at: 'desk' | 'agent' = 'agent'): boolean {
    const b = this.scene.crowd.brains.get(key)
    const spot = (at === 'desk' ? b?.desk : null) ?? b ?? this.scene.character(key)
    if (!spot) return false
    this.leaveFocus(false)
    this.autoFrame = false
    this.rig.flyTo(agentPose(spot), this.now())
    this.requestRender()
    return true
  }

  /** Conversa escolhida fora do 3D: voa até o agente dela (agente que ainda não chegou: no próximo feed). */
  follow(convId: string): boolean {
    this.followNext = null
    // A conversa do agente com a tela aberta (o clique nele a selecionou): a câmera já está lá.
    if (this.focusedKey && this.scene.character(this.focusedKey)?.model.convId === convId) return true
    if (this.now() - this.userCamAt < FOLLOW_GRACE_MS) return false
    if (this.flyToAgent(principalKey(convId))) return true
    this.followNext = convId
    return false
  }

  /** Centro da cabeça do personagem `key` no mundo, em `out`; false se ele não está à vista. */
  headWorldPosition(key: string, out: Vector3): boolean {
    return this.scene.headWorldPosition(key, out)
  }

  /** Modo demonstração (Ctrl+Alt+Shift+D): acelera o cochilo, o telão mostra a página falsa e o kanban o Quadro falso. */
  setDemo(on: boolean): void {
    this.scene.setDemo(on)
    this.board.setDemo(on)
    this.requestRender()
  }

  get focused(): string | null {
    return this.focusedKey
  }

  setScreenElement(el: HTMLElement | null): void {
    this.anchor.setElement(el)
    this.requestRender()
  }

  /** O cartão da prévia do hover (data-key = o agente): a cada quadro, acima do monitor dele. */
  setPreviewElement(el: HTMLElement | null): void {
    this.preview.setElement(el)
    this.requestRender()
  }

  get running(): boolean {
    return this.rafId !== 0
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Aba fechada: para o laço e o tique; feed e resize ficam para a volta. Idempotente. */
  pause(): void {
    if (this.paused || this.disposed) return
    this.paused = true
    this.cancelFrame()
    if (this.tick !== null) clearInterval(this.tick)
    this.tick = null
    this.keys.clear()
    this.pointer.reset()
    this.board.pause()
  }

  /** Aba de volta: remede o palco, reaplica o último feed (guardado ou o atual) sem reproduzir o intervalo e retoma o laço. */
  resume(): void {
    if (!this.paused || this.disposed) return
    this.paused = false
    if (this.sizeStale) this.resize()
    const feed = this.pending ?? this.feed
    this.pending = null
    if (feed) this.applyFeed(feed, true)
    this.board.resume()
    this.tick = setInterval(this.tickQuips, QUIP_TICK_MS)
    this.requestRender()
  }

  requestRender(): void {
    this.lowRate = false
    if (this.disposed || this.paused || this.rafId || document.hidden) return
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
    if (this.disposed || this.paused || document.hidden) return
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
      this.leaveFocus(false, true)
      this.userMoved()
      this.rig.move(dx, dz)
    }
    const tweening = this.rig.step(now)
    this.camSync.sync()
    const moved = this.camSync.moved()
    if (moved || this.scene.viewDirty) this.quality.apply(this.scene, this.scene.updateView(this.camera, this.quality.level), this.rig.pose.distance)
    const animating = this.scene.animate(now / 1000, dt, this.camera.position)
    this.quality.shadows(this.scene)
    this.renderer.render(this.scene.scene, this.camera)
    this.quality.measure(now)
    if (this.focusedKey) this.anchor.place(this.camera, this.width, this.height)
    this.preview.place(this.scene, this.camera, this.width, this.height)
    this.speech.place(this.camera, this.width, this.height, this.quality.level === 2, this.headOf)
    this.board.place(this.width, this.height)
    const full = this.keys.moving || tweening || this.scene.rate === 2
    this.lowRate = !full
    if ((full || animating) && !this.rafId) this.rafId = this.raf(this.frame)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    if (this.tick !== null) clearInterval(this.tick)
    this.tick = null
    this.pending = null
    for (const off of this.cleanups.splice(0)) off()
    this.keys.clear()
    this.pointer.reset()
    this.anchor.setElement(null)
    this.preview.setElement(null)
    this.speech.dispose()
    this.board.dispose()
    this.scene.dispose()
    this.renderer.dispose()
  }
}
