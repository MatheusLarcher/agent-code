/**
 * A TV da sala de reunião na cena (projector.ts: a imagem na tela da TV). O que
 * ela mostra segue a prioridade decidida (tvAgenda.ts): o mockup de quem chama,
 * o teste ao vivo (no quadrinho se houver chamado), o último HTML criado e, sem
 * nada, o placar — o conteúdo além do teste vem de tvContent.ts. Ligada ao uso
 * do navegador/Android (projectorUse.ts) e aos quadros do navegador embutido
 * (browserFrames.ts):
 *
 *   syncRooms(layout, views)   sala nova ganha a TV; a que saiu libera a dela;
 *   feed(feed, chars, now)     quem testa, o HTML, os chamados; a fila da sala (`onRoom`);
 *   tick(now)                  ~4×/s: teste ocioso há PROJECTOR_IDLE_MS sai, HTML
 *                              velho sai, quadro pendente é decodificado, a demo redesenha;
 *   animate(dt)                só as salas À VISTA; fora da tela vai direto ao fim;
 *   frameArrived(convId)       quadro novo do navegador da conversa;
 *   lock(on) / focusInfo()     o foco na TV: o conteúdo congela enquanto o usuário
 *                              está nela, e o foco abre o que estava na tela;
 *   planFocus(convId?)         o foco que o usuário pede ("📋 Planejar", a conversa do plano,
 *                              o Agent Manager): o plano primeiro, com a fila de quem chama/testa à parte.
 *
 * A imagem só é redesenhada (no máximo uma vez a cada MIN_PAINT_MS, ~5 por
 * segundo) na sala com a tela acesa, à vista e PERTO/MÉDIO — ou com o espelho
 * do foco aberto. Só aí o quadro bruto é decodificado (createImageBitmap); o
 * bitmap anterior é fechado na hora. Sem quadro: a página da demo (no modo
 * demonstração) ou o esqueleto com a URL e o título. `animate` não aloca.
 */
import type { Object3D } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { BrowserFrames, decodeFrame, type BrowserFeedApi, type RawFrame } from './browserFrames'
import type { MonitorAt } from './cameraRig'
import type { RoomView } from './decor'
import { demoPage } from './demoDevices'
import type { Kit } from './kit'
import type { RoomLayout } from './layout'
import type { MeetingEntry } from './meetingRoom'
import type { OfficeCall } from './officeCalls'
import { RoomProjector } from './projector'
import { createProjectorKit, type ProjectorKit } from './projectorKit'
import type { PageImage, ProjectorView } from './projectorPaint'
import { ProjectorTracker, scanDeviceUse, type DeviceUse } from './projectorUse'
import type { RoomLod } from './roomLod'
import { agendaSig, SCORE, type TvAgenda, type TvPlan } from './tvAgenda'
import { fileLabel, TvContent, type TvChar } from './tvContent'

/** Intervalo mínimo entre dois desenhos da imagem de uma sala (≤ 5 por segundo). */
export const MIN_PAINT_MS = 200

/** A tela de um agente no foco: o mockup de quem chama (ou o último HTML) ou o espelho de quem testa. */
export type TvAgentFocus =
  | { kind: 'mockup'; roomId: string; convId: string; agent: string; cwd: string; path: string; rel: string; callId: string | null; waiting: number }
  | { kind: 'test'; roomId: string; convId: string; agent: string; url: string; title: string; waiting: number }

/**
 * O que o foco na TV abre (o que estava na tela no clique, ou o plano que o
 * usuário pediu). No plano, `agents` é a fila de quem chama e de quem testa —
 * a aba "Agente chamando (N)" abre a 1ª — e cada plano traz a pasta e o slug
 * (a aba Implantação acha por eles os envios para implementação).
 */
export type TvFocusInfo =
  | TvAgentFocus
  | { kind: 'plan'; roomId: string; convId: string; plans: TvPlan[]; waiting: number; agents?: TvAgentFocus[] }
  | { kind: 'score'; roomId: string; waiting: number }

interface RoomState {
  readonly fx: RoomProjector
  readonly view: RoomView
  /** A zona da TV (a sala de reunião): culling e nível. */
  readonly lod: RoomLod
  readonly name: string
  agenda: TvAgenda
  agendaSig: string
  /** O teste cujos quadros a TV mostra (o principal ou o do quadrinho). */
  use: DeviceUse | null
  bitmap: ImageBitmap | null
  /** De quem é o bitmap e de que quadro (RawFrame.seq). */
  bitmapConv: string
  bitmapAt: number
  decoding: boolean
  lastDecode: number
  lastPaint: number
  /** O último desenho (assinatura da vista); '' força redesenhar. */
  sig: string
  /** Acesa, à vista e PERTO/MÉDIO (ou com o espelho aberto) no último quadro. */
  eligible: boolean
}

const bitmapImage = (bmp: ImageBitmap): PageImage => ({ width: bmp.width, height: bmp.height, draw: (ctx, x, y, w, h) => ctx.drawImage(bmp, x, y, w, h) })

export class Projectors {
  readonly kit: ProjectorKit
  /** O HTML, os chamados, o placar e o filtro (tvContent.ts). */
  readonly content: TvContent
  private readonly rooms = new Map<string, RoomState>()
  private list: RoomState[] = []
  private readonly tracker = new ProjectorTracker()
  private readonly center = { x: 0, y: 0, z: 0 }
  private disposed = false
  /** O usuário está em foco na TV: nada troca o conteúdo dela. */
  private locked = false
  /** O relógio do último feed/tique (ms). */
  private lastNow = 0
  /** Os quadros do navegador (`connect`); null = só o esqueleto. */
  frames: BrowserFrames | null = null
  /** Modo demonstração: as conversas da demo mostram a página falsa. */
  demo = false
  /** Nome do projeto da conversa (o escritório é um só: a TV diz de qual projeto é). */
  projectOf: (convId: string) => string | null = () => null
  /** A imagem de uma sala começou a acender (os agentes dela olham para o centro da tela). */
  onLit: (roomId: string, x: number, y: number, z: number) => void = () => {}
  /** Desenho assíncrono pronto (quadro decodificado, captura): a cena pede um quadro. */
  onDirty: () => void = () => {}
  /** A fila da sala mudou: os chamados (na ordem em que chegaram) e depois quem testa; o 1º fica ao lado da TV. */
  onRoom: (order: readonly MeetingEntry[]) => void = () => {}
  private roomSig = ''

  constructor(
    private readonly sceneKit: Kit,
    /** A sala está sem energia (apagão): TV desligada. */
    private readonly isDark: (roomId: string) => boolean,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.kit = createProjectorKit()
    this.content = new TvContent(
      () => {
        for (const st of this.list) if (this.refresh(st, this.clock(), true)) this.onDirty()
      },
      () => this.onDirty(),
      clock
    )
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
      const zone = view.zone('meeting')
      const fx = new RoomProjector(this.sceneKit, this.kit, zone.group, r.id, view.furniture.tv)
      // A TV está sempre ligada (sem nada, o placar): nasce acesa, sem animar.
      fx.setWant(true)
      fx.snap(this.isDark(r.id))
      const st: RoomState = { fx, view, lod: zone.lod, name: r.name, agenda: cur?.agenda ?? SCORE, agendaSig: '', use: cur?.use ?? null, bitmap: null, bitmapConv: '', bitmapAt: 0, decoding: false, lastDecode: -Infinity, lastPaint: -Infinity, sig: '', eligible: false }
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

  /** Libera a TV da sala; `gone` = a sala saiu do escritório (esquece quem a usava). */
  private drop(st: RoomState, gone: boolean): void {
    st.fx.dispose()
    st.bitmap?.close()
    st.bitmap = null
    this.rooms.delete(st.fx.roomId)
    if (gone) this.tracker.forget(st.fx.roomId)
  }

  /** Feed novo: quem testa, o HTML e os chamados; a TV troca de conteúdo (desenha já) e a fila da sala anda. */
  feed(feed: OfficeFeed | null, characters: ReadonlyArray<TvChar & { roomId: string | null }>, now: number): void {
    this.lastNow = now
    this.tracker.update(feed ? scanDeviceUse(feed, characters) : [], now)
    this.content.feed(feed, characters, now)
    for (const st of this.list) this.refresh(st, now, this.pickContent(st, now))
    this.emitRoom(now)
  }

  /** Os chamados abertos (o 1º é o que está ao lado da TV). */
  openCalls(): readonly OfficeCall[] {
    return this.content.openCalls
  }

  /** O que a TV mostra agora (tvAgenda.ts); com o foco na TV, nada muda. true se mudou. */
  private pickContent(st: RoomState, now: number): boolean {
    if (this.locked) return false
    const a = this.content.agenda(this.tracker.queue(st.fx.roomId, now), now)
    const sig = agendaSig(a)
    const use = a.main.kind === 'test' ? a.main.use : a.pip
    if (sig === st.agendaSig && use?.key === st.use?.key) return false
    st.agenda = a
    st.agendaSig = sig
    st.use = use
    st.sig = ''
    return true
  }

  /** A fila da sala (chamados, depois quem testa; o escritório tem uma TV): avisa só quando muda. */
  private emitRoom(now: number): boolean {
    const callers = this.content.openCalls.map((c) => ({ key: c.key, call: true }))
    const taken = new Set(callers.map((c) => c.key))
    const testers = this.list.flatMap((st) => this.tracker.queue(st.fx.roomId, now).map((u) => u.key)).filter((k) => !taken.has(k))
    const order: MeetingEntry[] = [...callers, ...testers]
    const sig = [...callers.map((c) => `${c.key}!`), ...testers].join('|')
    if (sig === this.roomSig) return false
    this.roomSig = sig
    this.onRoom(order)
    return true
  }

  /** Sem feed: o teste ocioso sai, o HTML velho sai, a marca de um chamado vale, a demo anda. true se algo mudou. */
  tick(now: number): boolean {
    this.lastNow = now
    let changed = this.content.tick(now)
    for (const st of this.list) {
      const swapped = this.pickContent(st, now)
      if (swapped) changed = true
      if (this.refresh(st, now, swapped)) changed = true
    }
    if (this.emitRoom(now)) changed = true
    return changed
  }

  /** Quadro novo do navegador da conversa: as salas que a mostram redesenham (respeitando o intervalo). */
  frameArrived(convId: string): void {
    const now = this.clock()
    for (const st of this.list) if (st.use?.convId === convId && this.refresh(st, now)) this.onDirty()
  }

  private isEligible(st: RoomState): boolean {
    const lod = st.lod
    return st.fx.lit > 0 && ((!lod.culled && lod.level < 2) || st.fx.mirroring)
  }

  /** Redesenha (ou decodifica o quadro novo) se a sala merece e o intervalo deixa; true se desenhou. */
  private refresh(st: RoomState, now: number, force = false): boolean {
    if (this.disposed || !this.isEligible(st)) return false
    const use = st.use
    const raw = use && !this.demo ? (this.frames?.frame(use.convId) ?? null) : null
    if (use && raw && (st.bitmapConv !== use.convId || st.bitmapAt !== raw.seq) && !st.decoding && now - st.lastDecode >= MIN_PAINT_MS) this.decode(st, raw, use.convId, now)
    const { view, sig } = this.viewNow(st, now)
    if (!force && (sig === st.sig || now - st.lastPaint < MIN_PAINT_MS)) return false
    st.sig = sig
    st.lastPaint = now
    st.fx.paint(view, !st.lod.culled && st.lod.level < 2)
    return true
  }

  /** A vista da TV e a assinatura dela (mudou = redesenha). */
  private viewNow(st: RoomState, now: number): { view: ProjectorView; sig: string } {
    const a = st.agenda
    const m = a.main
    const project = (convId: string): string => this.projectOf(convId) ?? st.name
    const frameSig = (): string => `${st.bitmap ? `${st.bitmapConv}@${st.bitmapAt}` : ''}|${this.demo ? Math.floor(now / 250) : ''}`
    // Na demo não há arquivo para capturar: a página falsa no lugar.
    const fake = (convId: string): PageImage | null => (this.demo && convId.startsWith('demo-') ? demoPage('web', now) : null)
    let view: ProjectorView
    let sig: string
    if (m.kind === 'test') {
      view = this.viewOf(st, m.use, now)
      sig = `test|${view.kind}|${view.url}|${view.title}|${view.live}|${frameSig()}`
    } else if (m.kind === 'call') {
      const pip = a.pip ? this.viewOf(st, a.pip, now) : null
      view = { ...this.content.pageView(m.call.id, m.call.path, m.call.convId, project(m.call.convId), fake(m.call.convId)), banner: this.content.banner(m.call), pip }
      sig = `call|${m.call.id}|${this.content.captureState(m.call.id)}|${pip ? `${pip.url}|${pip.live}|${frameSig()}` : ''}`
    } else if (m.kind === 'plan') {
      view = this.content.planView(m.plan, project(m.plan.convId))
      sig = `plan|${JSON.stringify(view.plan)}`
    } else if (m.kind === 'html') {
      view = this.content.pageView(m.write.id, m.write.path, m.write.convId, project(m.write.convId), fake(m.write.convId))
      sig = `html|${m.write.id}|${this.content.captureState(m.write.id)}`
    } else {
      view = this.content.scoreView(st.name)
      sig = `score|${JSON.stringify(view.score)}`
    }
    view.waiting = a.waiting
    return { view, sig: `${sig}|${a.waiting}` }
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
      st.bitmapAt = raw.seq
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
      project: this.projectOf(use.convId) ?? st.name,
      image
    }
  }

  /** Um quadro: anima as salas à vista (as outras vão direto para o fim). 2 enquanto algo anda, senão 0. */
  animate(dt: number): 0 | 2 {
    let moving = false
    const now = this.clock()
    for (let i = 0; i < this.list.length; i++) {
      const st = this.list[i]
      const lod = st.lod
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

  /** Telas clicáveis (as acesas, em salas à vista). */
  pickTargets(out: Object3D[]): void {
    for (const st of this.list) if (!st.lod.culled) st.fx.pickTargets(out)
  }

  /** O foco na TV: com `on`, o conteúdo congela (o que estava na tela fica); ao sair, a fila entra. */
  lock(on: boolean): void {
    if (on === this.locked) return
    this.locked = on
    if (!on) for (const st of this.list) this.refresh(st, this.clock(), this.pickContent(st, this.clock()))
  }

  /** O que o foco na TV abre: o que está na tela da (única) TV. */
  focusInfo(): TvFocusInfo | null {
    const st = this.list[0]
    if (!st) return null
    const { main: m, waiting } = st.agenda
    const roomId = st.fx.roomId
    if (m.kind === 'score') return { kind: 'score', roomId, waiting }
    if (m.kind === 'plan') return { kind: 'plan', roomId, convId: m.plan.convId, plans: this.content.plans.all(this.content.keep).map(({ convId, title, cwd, slug }) => ({ convId, title, cwd, slug })), waiting }
    if (m.kind === 'test') return this.testFocus(st, m.use, waiting)
    return m.kind === 'call' ? this.mockupFocus(roomId, m.call.convId, m.call.path, m.call.id, waiting) : this.mockupFocus(roomId, m.write.convId, m.write.path, null, waiting)
  }

  /**
   * O foco que o usuário pede ("📋 Planejar", a conversa do plano, o Agent
   * Manager): o plano `convId` (o pedido, mesmo fora do filtro) ou o da TV
   * (TvPlans.current, no filtro), por cima de quem chama ou testa — esses vão
   * para `agents`, na ordem da TV (chamados, depois testes). null sem plano:
   * vale o que está na tela.
   */
  planFocus(convId: string | null = null): Extract<TvFocusInfo, { kind: 'plan' }> | null {
    const st = this.list[0]
    if (!st) return null
    const { plans, keep } = this.content
    const shown = plans.all(keep)
    const forced = convId ? plans.all(() => true).find((p) => p.convId === convId) : undefined
    const plan = forced ?? plans.current(keep)
    if (!plan) return null
    const tabs = forced && !shown.includes(forced) ? [forced, ...shown] : shown
    const roomId = st.fx.roomId
    const open = this.content.openCalls.filter((c) => keep(c.convId))
    // Um por agente, como a fila da sala (emitRoom): quem chama não conta de novo pelo teste.
    const callers = new Set(open.map((c) => c.key))
    const calls = open.map((c) => this.mockupFocus(roomId, c.convId, c.path, c.id, 0))
    const tests = this.tracker.queue(roomId, this.lastNow).filter((u) => keep(u.convId) && !callers.has(u.key)).map((u) => this.testFocus(st, u, 0))
    return { kind: 'plan', roomId, convId: plan.convId, plans: tabs.map(({ convId: id, title, cwd, slug }) => ({ convId: id, title, cwd, slug })), waiting: 0, agents: [...calls, ...tests] }
  }

  private testFocus(st: RoomState, use: DeviceUse, waiting: number): Extract<TvAgentFocus, { kind: 'test' }> {
    const v = this.viewOf(st, use, this.clock())
    return { kind: 'test', roomId: st.fx.roomId, convId: use.convId, agent: this.content.titleOf(use.convId), url: v.url, title: v.title, waiting }
  }

  private mockupFocus(roomId: string, convId: string, path: string, callId: string | null, waiting: number): Extract<TvAgentFocus, { kind: 'mockup' }> {
    const cwd = this.content.cwdOf(convId)
    return { kind: 'mockup', roomId, convId, agent: this.content.titleOf(convId), cwd, path, rel: fileLabel(path, cwd).rel, callId, waiting }
  }

  /** A zona da TV está à vista (o aviso do chamado não notifica quem já está olhando). */
  tvInView(): boolean {
    const st = this.list[0]
    return !!st && !st.lod.culled
  }

  /** O centro da tela da TV (o foco mira nela); null sem TV. */
  screen(): MonitorAt | null {
    const tv = this.list[0]?.view.furniture.tv
    return tv ? { x: tv.x, y: tv.y, z: tv.z } : null
  }

  /** O espelho do foco (um canvas no palco) passa a receber cada desenho; null desliga. */
  mirror(roomId: string, canvas: HTMLCanvasElement | null): void {
    const st = this.rooms.get(roomId)
    if (!st) return
    st.fx.setMirror(canvas)
    if (canvas) this.refresh(st, this.clock(), true)
  }

  /** Há teste ao vivo na sala (dentro de PROJECTOR_IDLE_MS). */
  isDown(roomId: string): boolean {
    return this.tracker.down(roomId, this.lastNow)
  }

  /** O que a TV da sala mostra agora. */
  agendaOf(roomId: string): TvAgenda | null {
    return this.rooms.get(roomId)?.agenda ?? null
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
    this.content.dispose()
    this.frames?.dispose()
    this.frames = null
    this.onLit = () => {}
    this.onDirty = () => {}
    this.onRoom = () => {}
  }
}
