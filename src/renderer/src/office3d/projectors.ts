/**
 * Os projetores do escritório na cena — um por sala (projector.ts), ligados ao
 * uso do navegador/Android (projectorUse.ts) e aos quadros do navegador
 * embutido (browserFrames.ts):
 *
 *   syncRooms(layout, views)   sala nova ganha o projetor; a que saiu libera o dela;
 *   feed(feed, chars, now)     quem usa o projetor de cada sala (a tela desce);
 *   tick(now)                  ~4×/s: a tela sem uso há PROJECTOR_IDLE_MS sobe,
 *                              quadro pendente é decodificado, a demo redesenha;
 *   animate(dt)                só as salas À VISTA; fora da tela o estado vai direto
 *                              para o fim (snap), sem animar o atraso;
 *   frameArrived(convId)       quadro novo do navegador da conversa.
 *
 * A imagem só é redesenhada (no máximo uma vez a cada MIN_PAINT_MS, ~5 por
 * segundo) na sala com a tela acesa, à vista e PERTO/MÉDIO — ou com o telão
 * grande aberto. Só aí o quadro bruto é decodificado (createImageBitmap); o
 * bitmap anterior é fechado na hora e a sala que apaga fecha o dela. Sem
 * quadro: a página da demo (no modo demonstração) ou o esqueleto com a URL e o
 * título. Nada aqui aloca por quadro: `animate` só mexe em números e malhas.
 */
import type { Object3D } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { BrowserFrames, decodeFrame, type BrowserFeedApi, type RawFrame } from './browserFrames'
import type { RoomView } from './decor'
import { demoPage } from './demoDevices'
import type { Kit } from './kit'
import type { RoomLayout } from './layout'
import { RoomProjector } from './projector'
import { createProjectorKit, type ProjectorKit } from './projectorKit'
import type { PageImage, ProjectorView } from './projectorPaint'
import { ProjectorTracker, scanDeviceUse, type DeviceKind, type DeviceUse } from './projectorUse'

/** Intervalo mínimo entre dois desenhos da imagem de uma sala (≤ 5 por segundo). */
export const MIN_PAINT_MS = 200

/** O que o telão grande mostra de uma sala. */
export interface ProjectorInfo {
  roomId: string
  convId: string
  /** O personagem que está testando. */
  key: string
  kind: DeviceKind
  url: string
  title: string
  live: boolean
  project: string
}

interface RoomState {
  readonly fx: RoomProjector
  readonly view: RoomView
  readonly name: string
  use: DeviceUse | null
  bitmap: ImageBitmap | null
  /** De quem é o bitmap e de que quadro (RawFrame.at). */
  bitmapConv: string
  bitmapAt: number
  decoding: boolean
  lastDecode: number
  lastPaint: number
  /** O último desenho (assinatura da vista); '' força redesenhar. */
  sig: string
  /** Acesa, à vista e PERTO/MÉDIO (ou com o telão aberto) no último quadro. */
  eligible: boolean
}

const bitmapImage = (bmp: ImageBitmap): PageImage => ({ width: bmp.width, height: bmp.height, draw: (ctx, x, y, w, h) => ctx.drawImage(bmp, x, y, w, h) })

export class Projectors {
  readonly kit: ProjectorKit
  private readonly rooms = new Map<string, RoomState>()
  private list: RoomState[] = []
  private readonly tracker = new ProjectorTracker()
  private readonly center = { x: 0, y: 0, z: 0 }
  private disposed = false
  /** Os quadros do navegador (`connect`); null = só o esqueleto. */
  frames: BrowserFrames | null = null
  /** Modo demonstração: as conversas da demo mostram a página falsa. */
  demo = false
  /** A imagem de uma sala começou a acender (os agentes dela olham para o centro da tela). */
  onLit: (roomId: string, x: number, y: number, z: number) => void = () => {}
  /** Desenho assíncrono pronto (quadro decodificado): a cena pede um quadro. */
  onDirty: () => void = () => {}

  constructor(
    private readonly sceneKit: Kit,
    /** A sala está sem energia (apagão): projetor desligado. */
    private readonly isDark: (roomId: string) => boolean,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.kit = createProjectorKit()
  }

  /**
   * Liga os quadros do navegador embutido (window.api): cada um é da conversa
   * `activeId()` (na demo, de nenhuma); com `paused()` (aba fechada) só fica guardado.
   */
  connect(api: BrowserFeedApi | null, activeId: () => string | null, paused: () => boolean): void {
    this.frames?.dispose()
    this.frames = new BrowserFrames(api, () => (this.demo ? null : activeId()), (id) => {
      if (!paused()) this.frameArrived(id)
    })
  }

  syncRooms(layout: readonly RoomLayout[], views: ReadonlyMap<string, RoomView>): void {
    for (const r of layout) {
      const view = views.get(r.id)
      const cur = this.rooms.get(r.id)
      if (!view || cur?.view === view) continue
      if (cur) this.drop(cur, false)
      const fx = new RoomProjector(this.sceneKit, this.kit, view.group, r.id, { x: view.furniture.screen.x, z: r.z })
      // Sala refeita (mais mesas) com a tela embaixo: a nova já nasce embaixo, sem descer de novo.
      if (cur?.fx.want) {
        fx.setWant(true)
        fx.snap(this.isDark(r.id))
      }
      const st: RoomState = { fx, view, name: r.name, use: cur?.use ?? null, bitmap: null, bitmapConv: '', bitmapAt: 0, decoding: false, lastDecode: -Infinity, lastPaint: -Infinity, sig: '', eligible: false }
      fx.onLit = () => {
        fx.center(this.center)
        this.onLit(fx.roomId, this.center.x, this.center.y, this.center.z)
        this.refresh(st, this.clock(), true)
      }
      this.rooms.set(r.id, st)
    }
    const ids = new Set(layout.map((r) => r.id))
    for (const st of [...this.rooms.values()]) if (!ids.has(st.fx.roomId) || views.get(st.fx.roomId) !== st.view) this.drop(st, !ids.has(st.fx.roomId))
    this.list = [...this.rooms.values()]
  }

  /** Libera o projetor da sala; `gone` = a sala saiu do escritório (esquece quem a usava). */
  private drop(st: RoomState, gone: boolean): void {
    st.fx.dispose()
    st.bitmap?.close()
    st.bitmap = null
    this.rooms.delete(st.fx.roomId)
    if (gone) this.tracker.forget(st.fx.roomId)
  }

  /** Feed novo: quem usou navegador/Android em cada sala e se a tela fica embaixo. */
  feed(feed: OfficeFeed | null, characters: ReadonlyArray<Pick<OfficeCharacterModel, 'key' | 'convId' | 'roomId' | 'role' | 'trackId'>>, now: number): void {
    this.tracker.update(feed ? scanDeviceUse(feed, characters) : [], now)
    for (const st of this.list) {
      st.use = this.tracker.use(st.fx.roomId)
      st.fx.setWant(this.tracker.down(st.fx.roomId, now))
      this.refresh(st, now)
    }
  }

  /** Sem feed: a tela sem uso sobe, quadro pendente sai, a demo anda. true se algo mudou (a cena pede um quadro). */
  tick(now: number): boolean {
    let changed = false
    for (const st of this.list) {
      const down = this.tracker.down(st.fx.roomId, now)
      if (down !== st.fx.want) {
        st.fx.setWant(down)
        changed = true
      }
      if (!st.fx.want && st.fx.lit === 0 && st.bitmap) {
        st.bitmap.close()
        st.bitmap = null
        st.sig = ''
      }
      if (this.refresh(st, now)) changed = true
    }
    return changed
  }

  /** Quadro novo do navegador da conversa: as salas que a mostram redesenham (respeitando o intervalo). */
  frameArrived(convId: string): void {
    const now = this.clock()
    for (const st of this.list) if (st.use?.convId === convId && this.refresh(st, now)) this.onDirty()
  }

  private isEligible(st: RoomState): boolean {
    const lod = st.view.lod
    return st.fx.lit > 0 && st.use !== null && ((!lod.culled && lod.level < 2) || st.fx.mirroring)
  }

  /** Redesenha (ou decodifica o quadro novo) se a sala merece e o intervalo deixa; true se desenhou. */
  private refresh(st: RoomState, now: number, force = false): boolean {
    const use = st.use
    if (!use || this.disposed || !this.isEligible(st)) return false
    const raw = this.demo ? null : (this.frames?.frame(use.convId) ?? null)
    if (raw && (st.bitmapConv !== use.convId || st.bitmapAt !== raw.at) && !st.decoding && now - st.lastDecode >= MIN_PAINT_MS) this.decode(st, raw, use.convId, now)
    const view = this.viewOf(st, use, now)
    const sig = `${view.kind}|${view.url}|${view.title}|${view.live}|${st.bitmap ? `${st.bitmapConv}@${st.bitmapAt}` : ''}|${this.demo ? Math.floor(now / 250) : ''}`
    if (!force && (sig === st.sig || now - st.lastPaint < MIN_PAINT_MS)) return false
    st.sig = sig
    st.lastPaint = now
    st.fx.paint(view, !st.view.lod.culled && st.view.lod.level < 2)
    return true
  }

  private decode(st: RoomState, raw: RawFrame, convId: string, now: number): void {
    st.decoding = true
    st.lastDecode = now
    void decodeFrame(raw).then((bmp) => {
      st.decoding = false
      if (this.disposed || this.rooms.get(st.fx.roomId) !== st) return bmp?.close()
      if (!bmp) return
      st.bitmap?.close()
      st.bitmap = bmp
      st.bitmapConv = convId
      st.bitmapAt = raw.at
      if (this.refresh(st, this.clock(), true)) this.onDirty()
    })
  }

  private viewOf(st: RoomState, use: DeviceUse, now: number): ProjectorView {
    const state = this.frames?.state(use.convId) ?? null
    const demo = this.demo && use.convId.startsWith('demo-')
    const image = demo ? demoPage(use.kind, now) : st.bitmap && st.bitmapConv === use.convId ? bitmapImage(st.bitmap) : null
    const web = use.kind === 'web'
    return {
      kind: use.kind,
      url: (web && state?.url) || use.url,
      title: (web ? state?.title || use.title : use.title || state?.title) ?? '',
      live: demo || (this.frames?.live(use.convId) ?? false),
      project: st.name,
      image
    }
  }

  /** Um quadro: anima as salas à vista (as outras vão direto para o fim). 2 enquanto algo anda, senão 0. */
  animate(dt: number): 0 | 2 {
    let moving = false
    const now = this.clock()
    for (let i = 0; i < this.list.length; i++) {
      const st = this.list[i]
      const lod = st.view.lod
      const dark = this.isDark(st.fx.roomId)
      if (lod.culled) {
        if (st.fx.drop !== (st.fx.want ? 1 : 0) || st.fx.lit !== (st.fx.want && !dark ? 1 : 0)) st.fx.snap(dark)
        st.eligible = false
        continue
      }
      st.fx.setLevel(lod.level)
      if (st.fx.animate(dt, dark)) moving = true
      // Voltou a merecer desenho (acendeu, voltou à vista, saiu do LONGE): desenha já.
      const eligible = this.isEligible(st)
      if (eligible && !st.eligible) this.refresh(st, now, true)
      st.eligible = eligible
    }
    return moving ? 2 : 0
  }

  /** Telas clicáveis (as que estão embaixo, em salas à vista). */
  pickTargets(out: Object3D[]): void {
    for (const st of this.list) if (!st.view.lod.culled) st.fx.pickTargets(out)
  }

  /** O que o telão grande mostra da sala; null se ninguém usou o projetor dela. */
  info(roomId: string): ProjectorInfo | null {
    const st = this.rooms.get(roomId)
    const use = st?.use
    if (!st || !use) return null
    const view = this.viewOf(st, use, this.clock())
    return { roomId, convId: use.convId, key: use.key, kind: use.kind, url: view.url, title: view.title, live: view.live, project: st.name }
  }

  /** O telão grande da sala (o overlay) passa a receber cada desenho; null desliga. */
  mirror(roomId: string, canvas: HTMLCanvasElement | null): void {
    const st = this.rooms.get(roomId)
    if (!st) return
    st.fx.setMirror(canvas)
    if (canvas) this.refresh(st, this.clock(), true)
  }

  /** A sala com a tela embaixo (testes e HUD). */
  isDown(roomId: string): boolean {
    return this.rooms.get(roomId)?.fx.want ?? false
  }

  room(roomId: string): RoomProjector | undefined {
    return this.rooms.get(roomId)?.fx
  }

  dispose(): void {
    this.disposed = true
    for (const st of this.list) {
      st.fx.dispose()
      st.bitmap?.close()
      st.bitmap = null
    }
    this.rooms.clear()
    this.list = []
    this.kit.dispose()
    this.frames?.dispose()
    this.frames = null
    this.onLit = () => {}
    this.onDirty = () => {}
  }
}
