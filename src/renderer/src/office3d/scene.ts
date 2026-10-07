/**
 * Cena three.js do escritório 3D, montada a partir do layout puro. Low-poly e procedural; geometrias/materiais
 * no Kit (e no PropKit), o escritório (UMA sala física com zonas) em decor.ts, personagens em characters.ts e a
 * vida deles em crowd.ts.
 *
 * Luz: as três de sunShadow.ts, as únicas em qualquer nível de energia (energy.ts
 * só muda intensidade e cor e liga malhas emissivas). O shadow map só é refeito
 * quando algo que projeta sombra muda (`shadowDirty`, que o motor lê e zera).
 *
 * `sync(layout, feed, life)` é incremental (cria/move/remove por chave) e é o
 * ÚNICO lugar que decide o conteúdo das telas (as 16 mesas e o console da
 * Central) e redesenha o céu — nada por quadro; `life` (retrato + eventos de
 * events.ts) alimenta os cérebros. `updateView(camera)` (o motor chama quando a
 * câmera muda ou `viewDirty`): ZONA fora do frustum fica invisível e parada
 * (sem tela redesenhada); as outras pegam o nível de LOD pela distância
 * (lod.ts, com histerese). Personagem: esfera própria (frustum) e distância.
 * Quem volta à vista sincroniza sem animar o atraso; sem `updateView`, tudo à vista e completo.
 * `animate` passa os cérebros e anima o que está À VISTA sem alocar e diz o ritmo (`rate`). A TV da
 * sala de reunião (projectors.ts) acende com o navegador/Android e quem testa vai até ela. O kanban
 * (board/boards.ts) é o Quadro real de um projeto; `pick` devolve também `card:`, `pile:` e `tab:`; `dispose()` libera tudo.
 */
import { Color, Fog, Frustum, Matrix4, Mesh, Raycaster, Scene, Sphere, Vector2, Vector3, type Camera, type DirectionalLight, type Object3D } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import { AgentModels, type AgentRenderer } from './agentModels'
import { Boards } from './board/boards'
import { greet } from './brain'
import { OfficeErrands } from './officeErrands'
import { Character3D, type FrameCtx } from './characters'
import { Crowd, DEMO_TIME_FACTOR, modelPhase, type LifeInput } from './crowd'
import { buildRoom, roomSig, type RoomView, type ScreenView, type ZoneView } from './decor'
import { CHAIR_PULL } from './decorIslands'
import { doorWant, swingDoors } from './doors'
import { OfficeEnergy } from './energy'
import { createKit, type Kit } from './kit'
import { OFFICE_ID, type CharacterLayout, type Office3DLayout, type RoomLayout } from './layout'
import { zoneAt, type ZoneId } from './officePlan'
import { CHAR_LOD_BOUNDS, FOG_FAR, FOG_NEAR, lodLevel, type Lod } from './lod'
import { Particles } from './particles'
import type { OfficePower, PowerEvent } from './power'
import { MeetingVenues } from './meetingRoom'
import { Projectors } from './projectors'
import { createPropKit, type PropKit } from './props'
import { setRoomLevel } from './roomLod'
import { showScreen, syncRoomScreens } from './screens'
import { createSceneLights, fitSunShadow } from './sunShadow'

export { seedColor } from './characters'
export type { LifeInput } from './crowd'
export { screenPageFor } from './screens'

export { SHADOW_MAP_SIZE } from './sunShadow'

const BACKGROUND = 0x1d1a22
/** Névoa "desligada": começa além do plano distante da câmera. */
const FOG_OFF = 1e6
/** Esfera de cada personagem para o frustum. */
const CHAR_RADIUS = 1.2
/** Quem está a menos disto da TV olha para ela quando ela acende (m). */
const TV_GLANCE_M = 7

export class OfficeScene {
  readonly scene = new Scene()
  readonly crowd = new Crowd()
  readonly particles = new Particles()
  /** Energia do escritório: quadro de energia, luz, apagão e festa. */
  readonly energy: OfficeEnergy
  /** A TV da sala de reunião (navegador/Android em teste). */
  readonly projectors: Projectors
  private readonly meeting = new MeetingVenues((spots) => this.crowd.setVenues(spots))
  /** O kanban do Quadro real (board/). */
  readonly boards: Boards
  /** O pulso de despacho da Central e a ida à estante de Memórias (officeErrands.ts). */
  readonly errands: OfficeErrands
  readonly agents: AgentModels
  private readonly kit: Kit
  private readonly propKit: PropKit
  private readonly sun: DirectionalLight
  private readonly fog = new Fog(BACKGROUND, FOG_OFF, FOG_OFF + 1)
  private readonly rooms = new Map<string, RoomView>()
  /** As zonas do escritório e as salas com porta em lista (o quadro percorre sem criar iterador). */
  private zoneList: ZoneView[] = []
  private doorRooms: Array<{ id: string; view: RoomView }> = []
  private readonly chars = new Map<string, Character3D>()
  private charList: Character3D[] = []
  private readonly frame: FrameCtx = { t: 0, camX: 0, camY: 8, camZ: 14, particles: null }
  private readonly raycaster = new Raycaster()
  private layout: Office3DLayout | null = null
  private focusKey: string | null = null
  /** Mesa do foco ("sala#índice"; '' sem foco): mudar troca a cadeira escondida (e a sombra). */
  private focusDesk = ''
  /** Culling/LOD ligados (chegou a 1ª câmera): antes disso tudo fica à vista e completo. */
  private viewOn = false
  private shadowBox = ''
  /** Zonas/personagens mudaram: o motor refaz o culling/LOD no próximo quadro. */
  viewDirty = true
  /** Algo que projeta sombra mudou: o motor pede um shadow map novo e zera. */
  shadowDirty = true
  /** Ritmo pedido pelo último animate: 2 cheio, 1 só animação de LONGE (baixa prioridade), 0 parado. */
  rate: 0 | 1 | 2 = 0
  /** Zonas à vista no último updateView. */
  visibleRooms = 0
  private readonly frustum = new Frustum()
  private readonly viewProj = new Matrix4()
  private readonly sphere = new Sphere()
  private readonly camPos = new Vector3()
  private readonly doorMoved = { v: false }
  /** Chamado quando algo assíncrono (ícone da placa) muda a imagem. */
  onDirty: () => void = () => {}

  constructor(anisotropy = 1, renderer: AgentRenderer = null) {
    this.kit = createKit(anisotropy)
    this.propKit = createPropKit()
    this.frame.particles = this.particles
    this.frame.models = this.agents = new AgentModels(renderer, () => this.onDirty(), this.scene)
    this.scene.background = new Color(BACKGROUND)
    this.scene.fog = this.fog
    const { hemi, amb, sun } = createSceneLights(this.scene)
    this.sun = sun
    const ground = new Mesh(this.kit.geo.plane, this.kit.mat.ground)
    ground.scale.set(400, 400, 1)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.2
    this.scene.add(ground, this.particles.group)
    this.kit.sky.draw(new Date().getHours())
    this.energy = new OfficeEnergy(this.scene, this.kit, this.particles, this.crowd, { hemi, amb, sun })
    this.energy.onDark = (id, dark) => this.applyDark(id, dark)
    this.projectors = new Projectors(this.kit, () => this.energy.zoneDark('meeting'))
    this.projectors.onDirty = () => this.onDirty()
    this.projectors.onRoom = (order) => this.meeting.setQueue(order)
    // A TV acendeu: quem está perto dela (e à vista) olha para ela.
    this.projectors.onLit = (_id, x, y, z) => {
      for (const v of this.charList) if (!v.culled && Math.hypot(v.brain.x - x, v.brain.z - z) < TV_GLANCE_M) v.glance(x, y, z)
    }
    this.boards = new Boards(this.kit)
    this.errands = new OfficeErrands(this.scene, this.crowd)
  }

  /** Leitura da energia (motor: feed e tique). `t` = relógio da cena (s); `now` = epoch ms. */
  setPower(power: OfficePower | null, event: PowerEvent | null, t: number, now = Date.now()): void {
    this.energy.setPower(power, event, t, now)
  }

  /** O kanban está no escuro (a coreografia não anima no apagão). */
  boardDark(): boolean {
    return this.energy.zoneDark('plaza')
  }

  /** Uma zona apagou ou acendeu de vez: os monitores dela (pretos/de volta, se à vista) e o brilho no rosto de quem está nela. */
  private applyDark(zone: ZoneId, dark: boolean): void {
    for (const view of this.rooms.values()) for (const s of this.allScreens(view)) if (s.zone === zone && !s.lod.culled) showScreen(s, this.kit, s.lod.level, true, dark)
    for (const v of this.charList) if (zoneAt(v.brain.x, v.brain.z) === zone) v.powerDark = dark
  }

  private allScreens(view: RoomView): ScreenView[] {
    return [...view.screens, view.consoleScreen]
  }

  sync(layout: Office3DLayout, feed: OfficeFeed | null = null, life: LifeInput | null = null): void {
    this.layout = layout
    const seenRooms = new Set<string>()
    for (const r of layout.rooms) {
      seenRooms.add(r.id)
      const cur = this.rooms.get(r.id)
      if (cur && cur.sig === roomSig(r)) continue
      cur?.dispose()
      const v = buildRoom(this.kit, r, () => this.onDirty())
      this.scene.add(v.group)
      this.rooms.set(r.id, v)
      this.shadowDirty = true
    }
    for (const [id, v] of this.rooms) {
      if (seenRooms.has(id)) continue
      v.dispose()
      this.rooms.delete(id)
      this.shadowDirty = true
    }
    this.zoneList = [...this.rooms.values()].flatMap((v) => v.zones)
    this.doorRooms = [...this.rooms].map(([id, view]) => ({ id, view }))
    this.crowd.syncRooms(layout.rooms)
    this.energy.syncRooms(layout.rooms, this.rooms)
    this.projectors.syncRooms(layout.rooms, this.rooms)
    this.boards.syncRooms(layout.rooms, this.rooms)

    // Monitores primeiro: o brilho no rosto depende da tela acesa (screens.ts: mesas, console e pilhas de papel).
    const lit = new Set<string>()
    for (const r of layout.rooms) {
      const view = this.rooms.get(r.id)
      if (!view) continue
      syncRoomScreens(view, r, layout, this.kit, feed, life, (z) => this.energy.zoneDark(z), this.viewOn, lit, () => this.onDirty())
      view.plaques.sync(r, layout.projects)
    }

    this.syncCharacters(layout, lit, life, feed)
    this.meeting.setChairs(layout.characters)
    if (life) this.crowd.apply(life)
    const projects = new Map(layout.projects.map((p) => [p.id, p.name]))
    const convProject = new Map(layout.characters.map((c) => [c.model.convId, c.projectId ? (projects.get(c.projectId) ?? null) : null]))
    this.projectors.projectOf = (convId) => convProject.get(convId) ?? null
    this.projectors.feed(feed, layout.characters.map((c) => ({ ...c.model, roomId: c.roomId, projectId: c.projectId })), life?.wallNow ?? Date.now())
    this.errands.feed(feed, layout, this.rooms.get(OFFICE_ID)?.zone('plaza').lod ?? null)
    this.kit.sky.draw(new Date().getHours())
    this.fitShadow(layout.rooms)
    this.applyFocus()
    this.viewDirty = true
  }

  /** Cria/atualiza personagens; quem saiu some (ou, subagente que voltou, sai pela porta). */
  private syncCharacters(layout: Office3DLayout, lit: Set<string>, life: LifeInput | null, feed: OfficeFeed | null): void {
    const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
    const delegated = new Set<string>()
    const returned = new Set<string>()
    for (const e of life?.events ?? []) {
      if (e.type === 'delegate') delegated.add(e.childKey)
      else if (e.type === 'return') returned.add(e.childKey)
    }
    const seen = new Set<string>()
    for (const c of layout.characters) {
      seen.add(c.key)
      const status = life?.snapshot.agents.get(c.key)
      const working = status ? status.phase === 'working' || status.phase === 'waiting-permission' : c.model.active
      const brain = this.crowd.upsert(c, delegated.has(c.key) || !working, rooms)
      if (!life) brain.phase = modelPhase(c.model)
      let v = this.chars.get(c.key)
      if (!v) {
        v = new Character3D(this.kit, this.propKit, this.frame, c, brain)
        this.scene.add(v.group)
        this.chars.set(c.key, v)
        this.shadowDirty = true
      }
      v.powerDark = this.energy.zoneDark(zoneAt(brain.x, brain.z))
      v.deskIndex = c.deskIndex
      v.applyModel(c, lit.has(c.key))
      v.body.paintShirt(feed, c.projectId) // a camisa na cor do projeto, trocada em cena (a Central fica com a dela)
    }
    for (const [k, v] of this.chars) {
      if (seen.has(k) || this.crowd.isGhost(k)) continue
      this.crowd.drop(k, returned.has(k))
      if (this.crowd.gone(k)) this.removeChar(k, v)
    }
    this.charList = [...this.chars.values()]
  }

  private removeChar(key: string, v: Character3D): void {
    v.dispose()
    this.chars.delete(key)
    this.crowd.forget(key)
    this.shadowDirty = true
  }

  /** A câmera de sombra cobre o escritório (e só ele): refeita só quando a caixa muda. */
  private fitShadow(rooms: RoomLayout[]): void {
    const sig = fitSunShadow(this.sun, rooms, this.shadowBox)
    if (sig === this.shadowBox) return
    this.shadowBox = sig
    this.shadowDirty = true
  }

  /**
   * Foco no monitor: esconde quem está na frente dele (o dono e quem fica ao lado) e a cadeira
   * daquela mesa, para a câmera não ficar atrás de ninguém nem atravessar a cadeira no voo.
   */
  setFocus(key: string | null): void {
    this.focusKey = key
    this.applyFocus()
  }

  private applyFocus(): void {
    const target = this.focusKey ? this.character(this.focusKey) : undefined
    const desk = target?.screenDesk ?? null
    const sameDesk = (c: CharacterLayout): boolean => !!desk && c.screenDesk?.roomId === desk.roomId && c.screenDesk.index === desk.index
    let changed = false
    for (const c of this.layout?.characters ?? []) {
      const v = this.chars.get(c.key)
      if (!v) continue
      const hidden = c.key === this.focusKey || sameDesk(c)
      if (hidden !== v.focusHidden) changed = true
      v.focusHidden = hidden
      v.group.visible = v.brain.visible && !v.focusHidden && !v.culled
    }
    for (const [id, r] of this.rooms) r.hideChair(desk && desk.roomId === id ? desk.index : null)
    const deskKey = desk ? `${desk.roomId}#${desk.index}` : ''
    if (changed || deskKey !== this.focusDesk) this.shadowDirty = true
    this.focusDesk = deskKey
  }

  /** Modo demonstração: o cochilo chega DEMO_TIME_FACTOR vezes mais cedo e a TV mostra a página falsa. */
  setDemo(on: boolean): void {
    this.crowd.sleepAfter = on ? SLEEP_AFTER_SEC / DEMO_TIME_FACTOR : SLEEP_AFTER_SEC
    this.projectors.demo = on
    this.projectors.content.plans.demo = on
  }

  /** Clique no agente: ele olha para a câmera e dá um tchauzinho. */
  greet(key: string): void {
    const v = this.chars.get(key)
    if (v) greet(v.brain)
  }

  /** Filtro de projeto (crowd.setFilter): `snapAll` (motor pausado) ou personagem fora da tela vão direto ao fim, sem andar. */
  setProjectFilter(id: string | null, snapAll: boolean): void {
    this.crowd.setFilter(id, (b) => snapAll || (this.chars.get(b.key)?.culled ?? true))
    this.shadowDirty = true
    this.onDirty()
  }

  /**
   * Câmera mudou: zona fora do frustum fica invisível (e parada no animate); as outras pegam o
   * nível pela distância até a caixa delas, com histerese. Zona que volta à vista (ou muda de
   * nível) refaz as telas e a porta já no lugar. Devolve o nível global (`prev` sem zona à vista).
   */
  updateView(camera: Camera, prev: Lod = 0): Lod {
    this.viewOn = true
    this.viewDirty = false
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.viewProj)
    const cam = this.camPos.setFromMatrixPosition(camera.matrixWorld)
    let best: Lod = 2
    this.visibleRooms = 0
    for (let i = 0; i < this.zoneList.length; i++) {
      const zone = this.zoneList[i]
      const r = zone.lod
      const culled = !this.frustum.intersectsBox(r.box)
      const first = !r.placed
      const back = r.culled && !culled
      r.placed = true
      if (culled !== r.culled) {
        r.culled = culled
        zone.group.visible = !culled
        this.shadowDirty = true
      }
      const changed = setRoomLevel(r, lodLevel(r.box.distanceToPoint(cam), first ? null : r.level))
      if (changed) this.shadowDirty = true
      if (culled) continue
      this.visibleRooms++
      if (r.level < best) best = r.level
      if (first || back || changed) this.showZone(zone, first || back)
    }
    this.energy.updateView()
    for (let i = 0; i < this.charList.length; i++) this.placeChar(this.charList[i], cam)
    return this.visibleRooms > 0 ? best : prev
  }

  /** Telas da zona no nível dela (pretas sem energia) e, na volta à vista, a porta já no lugar (sem animar o atraso). */
  private showZone(zone: ZoneView, snapDoor: boolean): void {
    const dark = this.energy.zoneDark(zone.id)
    for (const [id, view] of this.rooms) {
      for (const s of this.allScreens(view)) if (s.lod === zone.lod) showScreen(s, this.kit, zone.lod.level, true, dark)
      if (snapDoor && view.doorZone === zone) view.door.rotation.y = doorWant(this.crowd.list, id, view)
    }
  }

  /** Personagem: a esfera dele decide o culling; a distância, o nível. */
  private placeChar(v: Character3D, cam: Vector3): void {
    const b = v.brain
    this.sphere.center.set(b.x, 1, b.z)
    this.sphere.radius = CHAR_RADIUS
    const culled = !this.frustum.intersectsSphere(this.sphere)
    const level = lodLevel(this.sphere.center.distanceTo(cam), v.viewPlaced ? v.viewLevel : null, CHAR_LOD_BOUNDS)
    if (culled !== v.culled || level !== v.viewLevel) this.shadowDirty = true
    v.setView(culled, level)
  }

  /** O sol projeta sombra (fora do LONGE)? */
  get castsShadows(): boolean {
    return this.sun.castShadow
  }

  /** Nível global: LONGE desliga a sombra do sol e põe uma névoa suave a partir de ~0,75× a distância da câmera. */
  setQuality(level: Lod, camDistance: number): void {
    const far = level === 2
    if (this.sun.castShadow === far) {
      this.sun.castShadow = !far
      this.shadowDirty = true
    }
    this.fog.near = far ? camDistance * FOG_NEAR : FOG_OFF
    this.fog.far = far ? camDistance * FOG_FAR : FOG_OFF + 1
  }

  /**
   * Um quadro da vida do escritório (t e dt em s; `cam` = posição da câmera);
   * true se há algo animando. Todos os cérebros andam; personagem fora da tela
   * não é animado. `rate`: 2 se algo PERTO/MÉDIO anima, 1 se só LONGE.
   */
  animate(t: number, dt = 0, cam?: Vector3): boolean {
    const f = this.frame
    f.t = t
    if (cam) {
      f.camX = cam.x
      f.camY = cam.y
      f.camZ = cam.z
    }
    this.crowd.step(dt, t, f.camX, f.camZ)
    let full = false
    let low = false
    const list = this.charList
    for (let i = 0; i < list.length; i++) {
      const v = list[i]
      if (!v.culled) {
        const lod = v.viewLevel
        if (v.update(dt, lod)) {
          if (lod === 2) low = true
          else full = true
        }
        if (v.castMoved()) this.shadowDirty = true
      }
      this.pullChair(v)
      if (this.crowd.isGhost(v.key) && this.crowd.gone(v.key)) {
        this.removeChar(v.key, v)
        this.charList = [...this.chars.values()]
      }
    }
    // Energia: transições, piscadas, emergência, festa e o quadro de energia pedem o ritmo delas; a TV, o dela.
    const power = this.energy.animate(t, dt)
    if (this.projectors.animate(dt) === 2) full = true
    if (this.boards.animate(dt) === 2) full = true
    if (this.errands.animate(dt)) full = true
    if (this.particles.update(dt)) full = true
    this.doorMoved.v = false
    const doors = swingDoors(this.doorRooms, this.crowd.list, dt, this.doorMoved)
    if (this.doorMoved.v) this.shadowDirty = true
    if (doors === 2 || power === 2) full = true
    else if (doors === 1 || power === 1) low = true
    this.rate = full ? 2 : low ? 1 : 0
    return full || low
  }

  /** Sentando ou levantando da própria mesa: a cadeira recua no meio do movimento e volta (as pernas não cruzam o tampo). */
  private pullChair(v: Character3D): void {
    const b = v.brain
    const pull = v.deskIndex !== null && b.seat === 'chair' && b.sit > 0 && b.sit < 1 ? CHAIR_PULL * Math.sin(Math.PI * b.sit) : 0
    if (pull === v.chairPull || v.deskIndex === null) return
    v.chairPull = pull
    this.rooms.get(OFFICE_ID)?.pullChair(v.deskIndex, pull)
    this.shadowDirty = true
  }

  /** Centro da cabeça do personagem no mundo (para ancorar balões); false se não está à vista. */
  headWorldPosition(key: string, out: Vector3): boolean {
    const v = this.chars.get(key)
    return !!v && v.group.visible && v.headWorldPosition(out)
  }

  /** O que está sob o raio: personagem (corpo, cabeça, indicador ou monitor dele), TV, papel ou pilha do quadro. */
  pick(ndcX: number, ndcY: number, camera: Camera): string | null {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera)
    const targets: Object3D[] = []
    for (const v of this.chars.values()) if (v.group.visible) targets.push(v.group)
    for (const r of this.rooms.values()) for (const s of this.allScreens(r)) if (s.mesh.userData.charKey && !s.lod.culled) targets.push(s.mesh)
    this.projectors.pickTargets(targets)
    for (const r of this.rooms.values()) targets.push(...r.pickables)
    this.boards.pickTargets(targets)
    for (const h of this.raycaster.intersectObjects(targets, true)) {
      const key = h.object.userData.charKey as string | undefined
      if (key) return key
      const board = this.boards.keyAt(h.object, h.faceIndex, h.point)
      if (board) return board
    }
    return null
  }

  character(key: string): CharacterLayout | undefined {
    return this.layout?.characters.find((c) => c.key === key)
  }

  room(id: string): RoomLayout | undefined {
    return this.layout?.rooms.find((r) => r.id === id)
  }

  get rooms3d(): RoomLayout[] {
    return this.layout?.rooms ?? []
  }

  /** Quantas zonas o escritório tem (o HUD de desempenho). */
  get zoneCount(): number {
    return this.zoneList.length
  }

  dispose(): void {
    this.energy.dispose()
    this.projectors.dispose()
    this.errands.dispose()
    this.boards.dispose()
    for (const v of this.rooms.values()) v.dispose()
    for (const v of this.chars.values()) v.dispose()
    this.rooms.clear()
    this.chars.clear()
    this.zoneList = []
    this.doorRooms = []
    this.charList = []
    this.particles.dispose()
    this.propKit.dispose()
    this.agents.dispose()
    this.sun.shadow.map?.dispose()
    this.kit.dispose()
    this.scene.clear()
    this.layout = null
    this.onDirty = () => {}
  }
}
