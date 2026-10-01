/**
 * O escritório num canvas: laço de quadros (com limite de fps), câmera em
 * níveis, seguir, rótulos das salas e entrada (hover, clique, duplo clique,
 * arrastar, roda). Classe imperativa fora do React: nada aqui faz setState
 * por quadro — os callbacks só disparam em eventos do usuário.
 *
 * O laço só roda entre start() e stop(); quem decide é o painel (aba ativa,
 * painel expandido, documento visível). stop() cancela o rAF: zero callbacks.
 */
import { roomIdFor } from '../../office/adapter/model'
import {
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  clampPan,
  createGameLoop,
  followStep,
  isSeated,
  roomAt,
  screenToWorld,
  TILE_SIZE,
  worldToScreen,
  type GameLoop,
  type MapOffset,
  type Point,
  type RoomDef
} from '../../office/engine'
import type { OfficeRuntime } from './officeRuntime'
import {
  deskOf,
  monitorAt,
  nextScreenTarget,
  sameTarget,
  screenRectFor,
  type ScreenRect,
  type ScreenTarget
} from './screenTarget'
import { stepLevel, viewForLevel, type ZoomLevel } from './zoomLevels'

export const FPS_CAP = 30
const FRAME_MIN_SEC = 1 / FPS_CAP - 0.002
const DRAG_THRESHOLD_PX = 4
const WHEEL_STEP = 60

export interface HoverInfo {
  id: number
  /** Posição em pixels CSS dentro do canvas. */
  x: number
  y: number
}

export interface OfficeViewCallbacks {
  onHover(info: HoverInfo | null): void
  onSelect(id: number | null): void
  onOpen(convId: string, trackId?: string): void
  onFocusRequest(convId: string): void
  onLevel(level: ZoomLevel): void
  /** Tela do monitor aberta (alvo) ou fechada (null). Só em mudança, nunca por quadro. */
  onScreen?(target: ScreenTarget | null): void
}

export type { ScreenRect, ScreenTarget } from './screenTarget'

export interface OfficeViewOptions {
  raf?: (cb: FrameRequestCallback) => number
  caf?: (id: number) => void
  now?: () => number
  dpr?: () => number
}

export interface FrameStats {
  frames: number
  /** Média de ms gastos em update+render por quadro desenhado. */
  avgWorkMs: number
}

export class OfficeView {
  private readonly loop: GameLoop
  private readonly now: () => number
  private readonly dpr: () => number
  private level: ZoomLevel = 'predio'
  private roomId: string | null = null
  private zoom = 1
  private pan: Point = { x: 0, y: 0 }
  private offset: MapOffset = { offsetX: 0, offsetY: 0 }
  private acc = 0
  private drawNext = true
  private seenVersion = -1
  private seenLayout = -1
  private labelKey = ''
  private drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null
  private wheelAcc = 0
  private work = 0
  private frames = 0
  private readonly detach: Array<() => void> = []
  private screen: ScreenTarget | null = null
  private screenEl: HTMLElement | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labels: HTMLElement | null,
    private readonly rt: OfficeRuntime,
    private readonly cb: OfficeViewCallbacks,
    opts: OfficeViewOptions = {}
  ) {
    this.now = opts.now ?? (() => performance.now())
    this.dpr = opts.dpr ?? (() => window.devicePixelRatio || 1)
    this.loop = createGameLoop({ update: (dt) => this.update(dt), render: () => this.render() }, opts.raf, opts.caf)
    this.listen()
  }

  get running(): boolean {
    return this.loop.running
  }

  get currentLevel(): ZoomLevel {
    return this.level
  }

  start(): void {
    this.drawNext = true
    this.loop.start()
  }

  stop(): void {
    this.loop.stop()
  }

  dispose(): void {
    this.stop()
    for (const off of this.detach.splice(0)) off()
  }

  stats(): FrameStats {
    return { frames: this.frames, avgWorkMs: this.frames ? this.work / this.frames : 0 }
  }

  /** Abre/centra na sala do projeto (cwd da conversa ativa). */
  focusProject(cwd: string): void {
    this.roomId = roomIdFor(cwd)
    this.setLevel('sala')
  }

  zoomStep(delta: 1 | -1): void {
    this.setLevel(stepLevel(this.level, delta))
  }

  setLevel(level: ZoomLevel): void {
    this.level = level
    this.applyLevel()
    this.cb.onLevel(level)
    this.syncScreen()
  }

  // ── Tela do monitor ────────────────────────────────────────

  get screenTarget(): ScreenTarget | null {
    return this.screen
  }

  /** Elemento HTML da tela: reposicionado no render de cada quadro (DOM direto). */
  setScreenElement(el: HTMLElement | null): void {
    this.screenEl = el
    this.drawNext = true
    this.placeScreen()
  }

  /** Abre/fecha conforme o nível (regra em screenTarget.nextScreenTarget). */
  private syncScreen(desk: string | null = null): void {
    const next = nextScreenTarget(this.rt.state, this.level, this.screen, desk)
    if (sameTarget(next, this.screen)) return
    this.screen = next
    this.drawNext = true
    this.cb.onScreen?.(next)
  }

  /** Mesa cujo monitor está sob o ponto. */
  monitorAt(p: Point): string | null {
    return monitorAt(this.rt.state, p)
  }

  /** Retângulo do monitor em foco (CSS px), ou null sem tela aberta. */
  screenRect(): ScreenRect | null {
    return screenRectFor(this.rt.state, this.screen, this.offset, this.zoom, this.dpr())
  }

  /** Ancora a tela no topo-centro do monitor (sem setState: só style). */
  private placeScreen(): void {
    const el = this.screenEl
    if (!el) return
    const r = this.screenRect()
    if (!r) return
    el.style.transform = `translate(${Math.round(r.x + r.w / 2)}px, ${Math.round(r.y)}px) translate(-50%, -100%)`
  }

  // ── Laço ───────────────────────────────────────────────────

  private update(dt: number): void {
    this.acc += dt
    if (this.acc < FRAME_MIN_SEC && !this.drawNext) {
      this.skip = true
      return
    }
    this.skip = false
    const t0 = this.now()
    const { state } = this.rt
    state.update(this.acc)
    this.acc = 0
    this.syncSize()
    if (this.seenLayout !== state.layoutVersion) {
      this.seenLayout = state.layoutVersion
      this.applyLevel()
    }
    const follow = state.cameraFollowId !== null ? state.getCharacter(state.cameraFollowId) : undefined
    if (state.cameraFollowId !== null && !follow) state.cameraFollowId = null
    if (follow && !this.drag) {
      this.pan = followStep(this.pan, { x: follow.x, y: follow.y }, this.mapSize(), this.zoom)
    }
    this.work += this.now() - t0
  }

  private skip = false

  private render(): void {
    if (this.skip) return
    const t0 = this.now()
    this.drawNext = false
    const ctx = this.canvas.getContext('2d')
    if (ctx) {
      this.offset = this.rt.renderer.render(ctx, this.canvas.width, this.canvas.height, this.rt.state, {
        zoom: this.zoom,
        panX: this.pan.x,
        panY: this.pan.y
      })
    }
    this.placeLabels()
    this.placeScreen()
    this.work += this.now() - t0
    this.frames++
  }

  private syncSize(): void {
    const dpr = this.dpr()
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.applyLevel()
    }
  }

  private mapSize(): { cols: number; rows: number } {
    const { cols, rows } = this.rt.state.layout
    return { cols, rows }
  }

  private viewport(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }

  private focusRoom(): RoomDef | null {
    const rooms = this.rt.state.layout.rooms
    return rooms.find((r) => r.id === this.roomId) ?? rooms[0] ?? null
  }

  private applyLevel(): void {
    const { state } = this.rt
    const id = state.cameraFollowId ?? state.selectedAgentId
    const ch = id !== null ? state.getCharacter(id) : undefined
    const point = ch ? { x: ch.x, y: ch.y } : null
    const v = viewForLevel(this.level, this.viewport(), this.mapSize(), { room: this.focusRoom(), point })
    this.zoom = v.zoom
    this.pan = v.pan
    this.drawNext = true
  }

  // ── Rótulos das salas (DOM direto, sem React por quadro) ───

  private placeLabels(): void {
    if (!this.labels) return
    const { model, state } = this.rt
    const key = `${this.rt.version}|${state.layoutVersion}|${this.zoom}|${this.offset.offsetX}|${this.offset.offsetY}`
    if (key === this.labelKey) return
    const rebuild = !this.labelKey.startsWith(`${this.rt.version}|${state.layoutVersion}|`)
    this.labelKey = key
    const dpr = this.dpr()
    if (rebuild) {
      this.labels.replaceChildren()
      for (const room of state.layout.rooms) {
        const info = model.rooms.find((r) => r.id === room.id)
        const el = document.createElement('div')
        el.className = 'office-room-label'
        el.dataset.room = room.id
        if (info?.icon) {
          const img = document.createElement('img')
          img.src = info.icon
          img.alt = ''
          img.onerror = () => img.remove()
          el.appendChild(img)
        }
        el.appendChild(document.createTextNode(info?.name ?? room.name))
        this.labels.appendChild(el)
      }
    }
    for (const el of Array.from(this.labels.children) as HTMLElement[]) {
      const room = state.layout.rooms.find((r) => r.id === el.dataset.room)
      if (!room) continue
      const p = worldToScreen({ x: room.col * TILE_SIZE, y: room.row * TILE_SIZE }, this.offset, this.zoom)
      el.style.transform = `translate(${Math.round(p.x / dpr)}px, ${Math.round(p.y / dpr) - 18}px)`
    }
  }

  // ── Entrada ────────────────────────────────────────────────

  private toWorld(e: { clientX: number; clientY: number }): { world: Point; css: Point } {
    const rect = this.canvas.getBoundingClientRect()
    const css = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const dpr = this.dpr()
    return { world: screenToWorld({ x: css.x * dpr, y: css.y * dpr }, this.offset, this.zoom), css }
  }

  /** Balão de pedido ('permissao'/'pergunta') sob o ponto, se houver. */
  bubbleAt(p: Point): number | null {
    for (const ch of this.rt.state.characters.values()) {
      if (ch.bubble !== 'permissao' && ch.bubble !== 'pergunta') continue
      const base = ch.y + (isSeated(ch) ? BUBBLE_SITTING_OFFSET_PX : 0) - BUBBLE_VERTICAL_OFFSET_PX
      if (p.x >= ch.x - 5 && p.x <= ch.x + 5 && p.y >= base - 11 && p.y <= base + 1) return ch.id
    }
    return null
  }

  /** Clique num ponto de mundo: balão → pedido; personagem → seleciona; sala (no prédio) → aproxima. */
  clickAt(p: Point): void {
    const { state, director } = this.rt
    const bubble = this.bubbleAt(p)
    if (bubble !== null) {
      const info = director.lookup(bubble)
      if (info) this.cb.onFocusRequest(info.convId)
      return
    }
    const id = state.getCharacterAt(p.x, p.y)
    if (id !== null) {
      state.selectedAgentId = id
      state.cameraFollowId = id
      const ch = state.getCharacter(id)
      if (ch?.roomId) this.roomId = ch.roomId
      this.cb.onSelect(id)
      if (this.level === 'predio') this.setLevel('sala')
      else this.syncScreen()
      this.drawNext = true
      return
    }
    const room = roomAt(state.layout.rooms, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE))
    if (this.level === 'predio' && room) {
      this.roomId = room.id
      this.setLevel('sala')
      return
    }
    state.selectedAgentId = null
    state.cameraFollowId = null
    this.cb.onSelect(null)
    this.drawNext = true
    this.syncScreen()
  }

  /** Duplo clique: personagem abre a conversa (subagente leva a trilha junto);
   *  monitor de uma mesa abre a tela dela (foco no dono, se houver). */
  openAt(p: Point): void {
    const { state } = this.rt
    const id = state.getCharacterAt(p.x, p.y)
    if (id !== null) {
      const info = this.rt.director.lookup(id)
      if (info) this.cb.onOpen(info.convId, info.trackId)
      return
    }
    const desk = this.monitorAt(p)
    if (!desk) return
    const owner = [...state.characters.values()].find((c) => deskOf(state, c.id) === desk && !c.leaving)
    state.selectedAgentId = owner?.id ?? null
    state.cameraFollowId = owner?.id ?? null
    if (owner) this.cb.onSelect(owner.id)
    this.screen = null
    if (this.level === 'tela') this.syncScreen(desk)
    else {
      this.level = 'tela'
      this.applyLevel()
      this.cb.onLevel('tela')
      this.syncScreen(desk)
    }
  }

  private listen(): void {
    const c = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
      c.addEventListener(type, fn as EventListener, { passive: type !== 'wheel' })
      this.detach.push(() => c.removeEventListener(type, fn as EventListener))
    }
    on('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, panX: this.pan.x, panY: this.pan.y, moved: false }
    })
    on('pointermove', (e) => {
      const d = this.drag
      if (d) {
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        d.moved = true
        this.rt.state.cameraFollowId = null
        const dpr = this.dpr()
        this.setPan({ x: d.panX + dx * dpr, y: d.panY + dy * dpr })
        return
      }
      const { world, css } = this.toWorld(e)
      const id = this.rt.state.getCharacterAt(world.x, world.y)
      if (id !== this.rt.state.hoveredAgentId) {
        this.rt.state.hoveredAgentId = id
        this.drawNext = true
      }
      this.cb.onHover(id === null ? null : { id, x: css.x, y: css.y })
    })
    on('pointerleave', () => {
      this.drag = null
      this.rt.state.hoveredAgentId = null
      this.cb.onHover(null)
    })
    on('pointerup', (e) => {
      const d = this.drag
      this.drag = null
      if (d && !d.moved) this.clickAt(this.toWorld(e).world)
    })
    on('dblclick', (e) => this.openAt(this.toWorld(e).world))
    on('wheel', (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        // Ctrl+roda e pinça (o Chromium entrega a pinça como ctrl+wheel).
        this.wheelAcc += e.deltaY
        if (Math.abs(this.wheelAcc) < WHEEL_STEP) return
        const dir = this.wheelAcc < 0 ? 1 : -1
        this.wheelAcc = 0
        this.zoomStep(dir)
        return
      }
      this.rt.state.cameraFollowId = null
      const dpr = this.dpr()
      this.setPan({ x: this.pan.x - e.deltaX * dpr, y: this.pan.y - e.deltaY * dpr })
    })
  }

  private setPan(p: Point): void {
    this.pan = clampPan(p, this.viewport(), this.mapSize(), this.zoom)
    this.drawNext = true
  }
}
