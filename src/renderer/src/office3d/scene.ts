/**
 * Cena three.js do escritório 3D, montada a partir do layout puro. Low-poly e
 * procedural; geometrias/materiais compartilhados no Kit (e no PropKit dos
 * objetos de mão), móveis repetidos em InstancedMesh por sala (decor.ts),
 * personagens em characters.ts e a vida deles (cérebros, salas navegáveis,
 * fila, conversa, porta) em crowd.ts.
 *
 * Luz: hemisférica quente + ambiente fraca + UMA direcional que projeta sombra
 * (shadow map 2048, câmera de sombra ajustada ao prédio a cada sync). O mapa
 * só é refeito quando algo que projeta sombra muda: `shadowDirty`, que o motor
 * lê e zera.
 *
 * `sync(layout, feed, life)` é incremental (cria/move/remove por chave) e é o
 * ÚNICO lugar que decide o conteúdo das telas e redesenha o céu — nada por
 * quadro; `life` (retrato + eventos de events.ts) alimenta os cérebros.
 * `updateView(camera)` (o motor chama quando a câmera muda ou `viewDirty`):
 * sala fora do frustum fica invisível e parada (sem animação, sem tela
 * redesenhada, sem partícula); as outras pegam o nível de LOD pela distância
 * (lod.ts, com histerese). Quem volta à vista sincroniza sem animar o atraso.
 * `animate` dá um passo em todos os cérebros e nos personagens, partículas e
 * portas À VISTA, sem alocar, e diz o ritmo pedido (`rate`). Sem nenhum
 * `updateView`, tudo fica à vista e completo (como antes).
 * `dispose()` libera tudo o que foi criado aqui.
 */
import { AmbientLight, Color, DirectionalLight, Fog, Frustum, HemisphereLight, Matrix4, Mesh, Raycaster, Scene, Sphere, Vector2, Vector3, type Camera, type Object3D } from 'three'
import { currentTool, screenModel } from '../components/office/screenContent'
import type { LookupInfo } from '../office/adapter/director'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import { greet } from './brain'
import { Character3D, type FrameCtx } from './characters'
import { Crowd, DEMO_TIME_FACTOR, modelPhase, type LifeInput } from './crowd'
import { buildRoom, roomSig, type RoomView } from './decor'
import { createKit, type Kit } from './kit'
import { buildingBounds, type CharacterLayout, type Office3DLayout, type RoomLayout } from './layout'
import { FOG_FAR, FOG_NEAR, lodLevel, type Lod } from './lod'
import { screenLines, type ScreenPage } from './monitorTexture'
import { Particles } from './particles'
import { createPropKit, type PropKit } from './props'
import { setRoomLevel } from './roomLod'
import { screenStatus, setScreen, showScreen } from './screens'
import { accentHue } from './sign'

export { seedColor } from './characters'
export type { LifeInput } from './crowd'

export const SHADOW_MAP_SIZE = 2048

const BACKGROUND = 0x1d1a22
const SUN_OFFSET = { x: 7, y: 16, z: 11 }
/** Porta: quanto abre (rad), a que distância de alguém e a que velocidade. */
const DOOR_OPEN = 1.35
const DOOR_NEAR = 1.3
const DOOR_SPEED = 4
/** Névoa "desligada": começa além do plano distante da câmera. */
const FOG_OFF = 1e6
/** Personagem sem sala (corredor): esfera dele para o frustum. */
const LONE_RADIUS = 1.2

/** Página da tela para um personagem ativo: a ferramenta atual ou, sem ela, o rótulo. */
export function screenPageFor(feed: OfficeFeed | null, model: OfficeCharacterModel): ScreenPage {
  const info: LookupInfo = { key: model.key, convId: model.convId, role: model.role, trackId: model.trackId }
  const page = screenLines(screenModel(currentTool(feed, info)))
  if (page.lines.length > 0 || page.title) return page
  const title = model.activity === 'read' ? 'lendo' : model.activity === 'type' ? 'escrevendo' : 'trabalhando'
  return { title, subtitle: '', lines: model.label ? [{ kind: 'meta', text: model.label.slice(0, 58) }] : [] }
}

export class OfficeScene {
  readonly scene = new Scene()
  readonly crowd = new Crowd()
  readonly particles = new Particles()
  private readonly kit: Kit
  private readonly propKit: PropKit
  private readonly sun: DirectionalLight
  private readonly fog = new Fog(BACKGROUND, FOG_OFF, FOG_OFF + 1)
  private readonly rooms = new Map<string, RoomView>()
  /** As mesmas salas em lista (o quadro percorre sem criar iterador). */
  private roomList: Array<{ id: string; view: RoomView }> = []
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
  /** Salas/personagens mudaram: o motor refaz o culling/LOD no próximo quadro. */
  viewDirty = true
  /** Algo que projeta sombra mudou: o motor pede um shadow map novo e zera. */
  shadowDirty = true
  /** Ritmo pedido pelo último animate: 2 cheio, 1 só animação de LONGE (baixa prioridade), 0 parado. */
  rate: 0 | 1 | 2 = 0
  /** Salas à vista no último updateView. */
  visibleRooms = 0
  private readonly frustum = new Frustum()
  private readonly viewProj = new Matrix4()
  private readonly sphere = new Sphere()
  private readonly camPos = new Vector3()
  /** Chamado quando algo assíncrono (ícone da placa) muda a imagem. */
  onDirty: () => void = () => {}

  constructor(anisotropy = 1) {
    this.kit = createKit(anisotropy)
    this.propKit = createPropKit()
    this.frame.particles = this.particles
    this.scene.background = new Color(BACKGROUND)
    this.scene.fog = this.fog
    this.scene.add(new HemisphereLight(0xfff1dc, 0x3a3040, 1.25))
    this.scene.add(new AmbientLight(0xffe8d0, 0.2))
    const sun = new DirectionalLight(0xffe2b8, 1.7)
    sun.castShadow = true
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02
    sun.shadow.radius = 3
    sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z)
    this.sun = sun
    this.scene.add(sun, sun.target)
    const ground = new Mesh(this.kit.geo.plane, this.kit.mat.ground)
    ground.scale.set(400, 400, 1)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.03
    this.scene.add(ground, this.particles.group)
    this.kit.sky.draw(new Date().getHours())
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
    this.roomList = [...this.rooms].map(([id, view]) => ({ id, view }))
    this.crowd.syncRooms(layout.rooms)

    // Monitores primeiro: o brilho no rosto depende da tela acesa. Sala fora da tela só guarda a página.
    const lit = new Set<string>()
    for (const r of layout.rooms) {
      const view = this.rooms.get(r.id)
      if (!view) continue
      const accent = `hsl(${accentHue(r.id)} 70% 60%)`
      const shown = !view.lod.culled && (view.lod.placed || !this.viewOn)
      r.desks.forEach((desk, i) => {
        const s = view.screens[i]
        s.mesh.userData.charKey = desk.ownerKey
        const owner = desk.ownerKey ? layout.characters.find((c) => c.key === desk.ownerKey)?.model : undefined
        if (owner?.active) {
          lit.add(owner.key)
          setScreen(s, 'on', screenPageFor(feed, owner), accent, screenStatus(owner, life))
        } else {
          setScreen(s, owner ? 'saver' : 'off', null, accent, 'idle')
        }
        showScreen(s, this.kit, view.lod.level, shown)
      })
    }

    this.syncCharacters(layout, lit, life)
    if (life) this.crowd.apply(life)
    this.kit.sky.draw(new Date().getHours())
    this.fitShadow(layout.rooms)
    this.applyFocus()
    this.viewDirty = true
  }

  /** Cria/atualiza personagens; quem saiu some (ou, subagente que voltou, sai pela porta). */
  private syncCharacters(layout: Office3DLayout, lit: Set<string>, life: LifeInput | null): void {
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
      v.applyModel(c, lit.has(c.key))
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

  /** A câmera de sombra cobre o prédio todo (e só ele). */
  private fitShadow(rooms: RoomLayout[]): void {
    const b = buildingBounds(rooms)
    if (!b) return
    const sig = `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`
    if (sig === this.shadowBox) return
    this.shadowBox = sig
    this.shadowDirty = true
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 3
    this.sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z)
    this.sun.target.position.set(cx, 0, cz)
    this.sun.target.updateMatrixWorld()
    const cam = this.sun.shadow.camera
    cam.left = -half
    cam.right = half
    cam.top = half
    cam.bottom = -half
    cam.near = 1
    cam.far = 60 + half * 2
    cam.updateProjectionMatrix()
  }

  /**
   * Foco no monitor: esconde quem está na frente dele (o dono e quem fica ao
   * lado) e a cadeira daquela mesa, para a câmera não ficar atrás de ninguém
   * nem atravessar a cadeira durante o voo.
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

  /** Modo demonstração: o cochilo chega DEMO_TIME_FACTOR vezes mais cedo. */
  setDemo(on: boolean): void {
    this.crowd.sleepAfter = on ? SLEEP_AFTER_SEC / DEMO_TIME_FACTOR : SLEEP_AFTER_SEC
  }

  /** Clique no agente: ele olha para a câmera e dá um tchauzinho. */
  greet(key: string): void {
    const v = this.chars.get(key)
    if (v) greet(v.brain)
  }

  /**
   * Câmera mudou: sala fora do frustum fica invisível (e parada no animate);
   * as outras pegam o nível pela distância da câmera até a caixa delas, com
   * histerese. Sala que volta à vista (ou muda de nível) refaz as telas e a
   * porta já no lugar. Devolve o nível global — o mais detalhado entre as salas
   * à vista (`prev` se nenhuma estiver).
   */
  updateView(camera: Camera, prev: Lod = 0): Lod {
    this.viewOn = true
    this.viewDirty = false
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.viewProj)
    const cam = this.camPos.setFromMatrixPosition(camera.matrixWorld)
    let best: Lod = 2
    this.visibleRooms = 0
    for (let i = 0; i < this.roomList.length; i++) {
      const { id, view } = this.roomList[i]
      const r = view.lod
      const culled = !this.frustum.intersectsBox(r.box)
      const first = !r.placed
      const back = r.culled && !culled
      r.placed = true
      if (culled !== r.culled) {
        r.culled = culled
        view.group.visible = !culled
        this.shadowDirty = true
      }
      const changed = setRoomLevel(r, lodLevel(r.box.distanceToPoint(cam), first ? null : r.level))
      if (changed) this.shadowDirty = true
      if (culled) continue
      this.visibleRooms++
      if (r.level < best) best = r.level
      if (first || back || changed) this.showRoom(id, view, first || back)
    }
    for (let i = 0; i < this.charList.length; i++) this.placeChar(this.charList[i], cam)
    return this.visibleRooms > 0 ? best : prev
  }

  /** Telas no nível da sala e, na volta à vista, a porta já aberta/fechada (sem animar o atraso). */
  private showRoom(id: string, view: RoomView, snapDoor: boolean): void {
    for (const s of view.screens) showScreen(s, this.kit, view.lod.level, true)
    if (snapDoor) view.door.rotation.y = this.doorWant(id, view)
  }

  /** Personagem segue a sala dele; sem sala (corredor), a esfera dele decide. */
  private placeChar(v: Character3D, cam: Vector3): void {
    const b = v.brain
    const room = b.roomId ? this.rooms.get(b.roomId) : undefined
    let culled: boolean
    let level: Lod
    if (room) {
      culled = room.lod.culled
      level = room.lod.level
    } else {
      this.sphere.center.set(b.x, 1, b.z)
      this.sphere.radius = LONE_RADIUS
      culled = !this.frustum.intersectsSphere(this.sphere)
      level = lodLevel(this.sphere.center.distanceTo(cam), v.viewPlaced ? v.viewLevel : null)
    }
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
   * true se há algo animando. Todos os cérebros andam; personagem de sala fora
   * da tela não é animado. `rate`: 2 se algo PERTO/MÉDIO anima, 1 se só LONGE.
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
      if (this.crowd.isGhost(v.key) && this.crowd.gone(v.key)) {
        this.removeChar(v.key, v)
        this.charList = [...this.chars.values()]
      }
    }
    if (this.particles.update(dt)) full = true
    const doors = this.swingDoors(dt)
    if (doors === 2) full = true
    else if (doors === 1) low = true
    this.rate = full ? 2 : low ? 1 : 0
    return full || low
  }

  /** Porta que alguém está perto de atravessar fica aberta. */
  private doorWant(id: string, view: RoomView): number {
    const brains = this.crowd.list
    for (let i = 0; i < brains.length; i++) {
      const b = brains[i]
      if (b.visible && b.roomId === id && Math.abs(b.x - view.doorAt.x) < DOOR_NEAR && Math.abs(b.z - view.doorAt.z) < DOOR_NEAR) return DOOR_OPEN
    }
    return 0
  }

  /** Abre a porta de quem chega perto dela e fecha depois (só salas à vista); devolve o ritmo pedido. */
  private swingDoors(dt: number): 0 | 1 | 2 {
    let rate: 0 | 1 | 2 = 0
    for (let r = 0; r < this.roomList.length; r++) {
      const { id, view } = this.roomList[r]
      if (view.lod.culled) continue
      const want = this.doorWant(id, view)
      const cur = view.door.rotation.y
      if (cur === want) continue
      view.door.rotation.y = cur + Math.max(-DOOR_SPEED * dt, Math.min(DOOR_SPEED * dt, want - cur))
      this.shadowDirty = true
      if (view.lod.level < 2) rate = 2
      else if (rate === 0) rate = 1
    }
    return rate
  }

  /** Centro da cabeça do personagem no mundo (para ancorar balões); false se não está à vista. */
  headWorldPosition(key: string, out: Vector3): boolean {
    const v = this.chars.get(key)
    return !!v && v.group.visible && v.headWorldPosition(out)
  }

  /** Personagem sob o raio (corpo, cabeça, indicador ou monitor dele). */
  pick(ndcX: number, ndcY: number, camera: Camera): string | null {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera)
    const targets: Object3D[] = []
    for (const v of this.chars.values()) if (v.group.visible) targets.push(v.group)
    for (const r of this.rooms.values()) for (const s of r.screens) if (s.mesh.userData.charKey) targets.push(s.mesh)
    const hit = this.raycaster.intersectObjects(targets, true).find((h) => h.object.userData.charKey)
    return (hit?.object.userData.charKey as string | undefined) ?? null
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

  dispose(): void {
    for (const v of this.rooms.values()) v.dispose()
    for (const v of this.chars.values()) v.dispose()
    this.rooms.clear()
    this.chars.clear()
    this.roomList = []
    this.charList = []
    this.particles.dispose()
    this.propKit.dispose()
    this.sun.shadow.map?.dispose()
    this.kit.dispose()
    this.scene.clear()
    this.layout = null
    this.onDirty = () => {}
  }
}
