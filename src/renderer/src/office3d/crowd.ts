/**
 * A turma do Escritório 3D — PURA (sem three): um cérebro (brain.ts) por
 * personagem, a grade de navegação e os POIs de cada sala (nav.ts +
 * furniture.ts), a reserva de POIs, a fila do café, os pares de conversa e
 * quem entra/sai pela porta. Implementa o BrainWorld e entrega a cada cérebro
 * o status e os eventos de events.ts (snapshotOf/diffEvents, só leitura).
 *
 * Visitantes (especialistas com mesa e subagentes ao lado do pai) aparecem pela
 * porta quando passam a trabalhar e saem por ela quando a trilha fecha; o
 * subagente que some do modelo junto com o `return` vira "fantasma" até
 * atravessar a porta (`gone()` diz quando a cena pode descartá-lo).
 *
 * Apagão (`setParty`): cada sala ganha um plano de festa (partyPlan.ts) e cada
 * agente um papel — todos, inclusive os especialistas na sala; fantasmas não.
 * O trenzinho anda quando todos os vagões chegaram. Quando a luz volta, todo
 * mundo sai do papel e corre para a mesa (brainParty.leaveParty).
 */
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import {
  beginChat,
  brainStatus,
  createBrain,
  DWELL_MAX,
  DWELL_MIN,
  pushReaction,
  react,
  relocate,
  setStatus,
  snapFilter,
  stepBrain,
  type Brain,
  type BrainWorld,
  type DeskRef,
  type FixedStyle
} from './brain'
import { boardSpotIn, type BoardSpot, type BoardWorld } from './brainBoard'
import { leaveParty } from './brainParty'
import { planPath } from './crowdPath'
import { roleOf, seedOf, type LifeInput } from './crowdRoles'
import { roomFurniture, type Poi, type PoiKind, type RoomFurniture, type Spot } from './furniture'
import { monitorPosition, type CharacterLayout, type RoomLayout } from './layout'
import { sameSpot, type MeetingSpot } from './meetingRoom'
import { FRONT_SPOTS, LOUNGE_SEATS } from './officePlan'
import { LINGER_S } from './memoryTrips'
import { isOffstage, onStage } from './offstage'
import { buildNavGrid, PoiBook, type NavGrid } from './nav'
import { CONGA_SPEED, planRoomParty, type PartyRole, type RoomParty } from './partyPlan'
import { rng as mulberry } from './textures'

export { DEMO_TIME_FACTOR, modelPhase, type LifeInput } from './crowdRoles'

interface RoomNav {
  sig: string
  room: RoomLayout
  furniture: RoomFurniture
  grid: NavGrid
  /** Fila do café, da máquina para trás. */
  queue: Poi[]
  chats: Array<[Poi, Poi]>
}

const navSig = (r: RoomLayout): string => `${r.x},${r.z},${r.width},${r.depth},${r.desks.length}`

export class Crowd implements BrainWorld, BoardWorld {
  t = 0
  camX = 0
  camZ = 0
  sleepAfter = SLEEP_AFTER_SEC
  readonly brains = new Map<string, Brain>()
  /** Os mesmos cérebros em lista: o passo por quadro percorre sem criar iterador. */
  readonly list: Brain[] = []
  readonly book = new PoiBook()
  /** Apagão: a festa está rolando. */
  partyOn = false
  /** Filtro de projeto em vigor (null = Todos): quem é de outro projeto fica lá fora. */
  filter: string | null = null
  /** Papel de cada agente na festa (as falas usam). */
  readonly partyRoles = new Map<string, PartyRole>()
  /** Muda a cada plano novo (a caixa de pizza da sala acompanha). */
  planVersion = 0
  private readonly parties = new Map<string, RoomParty>()
  /** Os mesmos planos em lista (o passo por quadro percorre sem iterador). */
  private partyList: RoomParty[] = []
  /** Salas a (re)planejar no próximo passo — depois que todo mundo do feed já entrou. */
  private readonly pending = new Set<string>()
  private readonly rooms = new Map<string, RoomNav>()
  private readonly ghosts = new Set<string>()
  private readonly scratch = new Float32Array(56)
  private readonly rnd: () => number

  constructor(seed = 1) {
    this.rnd = mulberry(seed)
  }

  rng(): number {
    return this.rnd()
  }

  furniture(roomId: string): RoomFurniture | undefined {
    return this.rooms.get(roomId)?.furniture
  }

  grid(roomId: string): NavGrid | undefined {
    return this.rooms.get(roomId)?.grid
  }

  /** Salas novas/mudadas refazem grade e POIs; sala que andou leva os agentes junto. */
  syncRooms(rooms: readonly RoomLayout[]): void {
    const seen = new Set<string>()
    for (const r of rooms) {
      seen.add(r.id)
      const cur = this.rooms.get(r.id)
      const sig = navSig(r)
      if (cur && cur.sig === sig) {
        cur.room = r
        continue
      }
      const furniture = roomFurniture(r)
      const byKind = (k: PoiKind): Poi[] => furniture.pois.filter((p) => p.kind === k)
      const chat = byKind('chat')
      const nav: RoomNav = {
        sig,
        room: r,
        furniture,
        grid: buildNavGrid(r, furniture),
        queue: [...byKind('coffee'), ...byKind('queue')],
        chats: chat.flatMap((p, i): Array<[Poi, Poi]> => (i % 2 === 0 && chat[i + 1] ? [[p, chat[i + 1]]] : []))
      }
      this.rooms.set(r.id, nav)
      if (cur) this.moveIn(r.id, cur, nav)
      if (this.partyOn) this.pending.add(r.id)
    }
    for (const id of [...this.rooms.keys()]) {
      if (seen.has(id)) continue
      this.rooms.delete(id)
      if (this.parties.delete(id)) this.partyList = [...this.parties.values()]
      this.pending.delete(id)
      this.book.dropRoom(id)
    }
  }

  /**
   * Liga (apagão) ou desliga (a luz voltou) a festa; `t` = relógio dos cérebros.
   * Ligar: todo mundo leva um susto e os papéis saem no próximo passo (com quem
   * o feed trouxer até lá). Desligar: todo mundo sai do papel e corre para a mesa.
   */
  setParty(on: boolean, t: number): void {
    if (on === this.partyOn) return
    this.partyOn = on
    if (on) {
      for (const id of this.rooms.keys()) this.pending.add(id)
      for (const b of this.list) {
        if (this.ghosts.has(b.key)) continue
        if (b.visible) pushReaction(b, 'scared')
        // Sem sala (corredor): dança onde está.
        if (b.roomId === null) this.join(b, 'dance', 0)
      }
      return
    }
    for (const b of this.list) leaveParty(b, t)
    this.parties.clear()
    this.partyList = []
    this.pending.clear()
    this.partyRoles.clear()
    this.planVersion++
  }

  /** Quem da sala entra na festa: todos menos fantasmas e visitantes que nem estão aqui. */
  private partyMembers(roomId: string): Brain[] {
    return this.list.filter(
      (b) => b.roomId === roomId && !this.ghosts.has(b.key) && !b.outside && (b.role !== 'visitor' || b.visible || b.phase === 'working' || b.phase === 'waiting-permission')
    )
  }

  private planParty(roomId: string): void {
    const nav = this.rooms.get(roomId)
    if (!nav) return
    const plan = planRoomParty(roomId, nav.furniture, this.partyMembers(roomId), seedOf(roomId))
    this.parties.set(roomId, plan)
    this.partyList = [...this.parties.values()]
    for (const b of this.list) if (b.roomId === roomId && b.party) this.partyRoles.set(b.key, b.party)
    this.planVersion++
  }

  private join(b: Brain, role: PartyRole, slot: number): void {
    b.party = role
    b.partySlot = slot
    this.partyRoles.set(b.key, role)
  }

  /** Trenzinho: anda quando todos os vagões chegaram ao ponto de partida (e ninguém está no susto). Por quadro, sem iterador. */
  private partyStep(dt: number): void {
    const list = this.partyList
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      if (p.conga.length === 0) continue
      if (p.congaGo) {
        p.congaS += CONGA_SPEED * dt
        continue
      }
      let ready = true
      for (let k = 0; k < p.conga.length; k++) {
        const b = p.conga[k] ? this.brains.get(p.conga[k]) : undefined
        if (b && b.party === 'conga' && (!b.arrived || b.reaction !== null)) ready = false
      }
      p.congaGo = ready
    }
  }

  /**
   * Filtro de projeto (null = Todos): quem é de outro projeto sai pela porta e,
   * quando o filtro o inclui de novo, entra e volta à mesma mesa (a Central e
   * quem não tem projeto nunca saem). `snap(b)`: vai direto ao fim, sem andar.
   */
  setFilter(projectId: string | null, snap: (b: Brain) => boolean): void {
    this.filter = projectId
    let changed = false
    for (const b of this.list) {
      const out = this.outsideOf(b.projectId) || isOffstage(b)
      if (out === b.outside || this.ghosts.has(b.key)) continue
      b.outside = out
      changed = true
      if (snap(b)) snapFilter(b, this)
    }
    if (changed && this.partyOn) for (const id of this.rooms.keys()) this.pending.add(id)
  }

  /**
   * Quem está na sala de reunião (meetingRoom.ts: ao lado da TV ou esperando a
   * vez) — quem não está no mapa sai dela. Lugar novo refaz o modo (vai para lá).
   */
  setVenues(spots: ReadonlyMap<string, MeetingSpot>): void {
    for (const b of this.list) {
      const v = spots.get(b.key) ?? null
      if (sameSpot(v, b.venue)) continue
      b.venue = v
      if (b.mode === 'meeting') b.mode = 'init'
    }
  }

  /**
   * Quem consulta a memória agora (memoryTrips.ts): vai à estante de Memórias. Quem saiu do mapa fica
   * ainda LINGER_S (a consulta rápida não vira vaivém); gravar vale até o fim da ida.
   */
  setShelfTrips(trips: ReadonlyMap<string, 'read' | 'write'>): void {
    for (const b of this.list) {
      const use = trips.get(b.key)
      if (use) b.shelfTrip = { use: b.shelfTrip?.use === 'write' ? 'write' : use, until: Infinity }
      else if (b.shelfTrip && b.shelfTrip.until === Infinity) b.shelfTrip.until = this.t + LINGER_S
    }
  }

  private outsideOf(projectId: string | null): boolean {
    return this.filter !== null && projectId !== null && projectId !== this.filter
  }

  /** A sala foi refeita: quem está nela vai junto; quem saía pela porta ou esperava na fila recalcula o destino. */
  private moveIn(roomId: string, old: RoomNav, nu: RoomNav): void {
    this.book.dropRoom(roomId)
    for (const b of this.brains.values()) {
      if (b.roomId !== roomId) continue
      relocate(b, nu.room.x - old.room.x, nu.room.z - old.room.z)
      if (b.mode === 'leave' || b.mode === 'queue') b.mode = 'init'
    }
  }

  /**
   * Cria ou atualiza o cérebro de um personagem do layout. `away` só vale na criação: visitante que acabou de ser delegado
   * (ou que não está trabalhando) nasce lá fora. Lugar fixo que mudou mais de 5 cm (outra cadeira): levanta e vai ao novo.
   */
  upsert(c: CharacterLayout, away: boolean, desks: ReadonlyMap<string, RoomLayout>): Brain {
    const m = c.model
    const role = roleOf(c)
    const room = c.roomId ? desks.get(c.roomId) : undefined
    const own = c.deskIndex !== null && room ? room.desks[c.deskIndex] : undefined
    const screen = c.screenDesk ? desks.get(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
    const home: Spot = { x: c.x, z: c.z, yaw: c.yaw }
    const desk = role === 'fixed' || !own ? null : { x: own.x, z: own.z, yaw: own.yaw, out: own.out }
    const lounge = role !== 'fixed' && c.lounge !== null ? LOUNGE_SEATS[c.lounge] : null
    const monitor = screen ? monitorPosition(screen) : null
    const style: FixedStyle = m.role === 'po' ? 'board' : m.role === 'memoria' ? 'archive' : c.spot === 'central' ? 'console' : c.spot === 'manager' ? 'manager' : 'idle'
    // A pasta vai para o lado do colega da ilha (o de dentro).
    const side = own ? -own.out : 1
    const projectId = c.projectId
    this.ghosts.delete(c.key)
    const outside = this.outsideOf(projectId) || m.offstage === true
    let b = this.brains.get(c.key)
    if (!b) {
      // Lá fora (o filtro ou fora de cena, offstage.ts) já nasce lá fora; a 1ª implementação de um plano nasce no lugar do Manager.
      const out = (role === 'visitor' && away) || outside
      b = createBrain({ key: c.key, role, style, roomId: c.roomId, projectId, home, desk, lounge, monitor, side, seed: seedOf(c.key), away: out })
      onStage(b, outside, m.offstage === true, this.t, out || !m.handoverFrom ? undefined : this.brains.get(m.handoverFrom))
      this.brains.set(c.key, b)
      this.list.push(b)
      // Chegou no meio do apagão: vai direto para a pista (se a sala já tem plano; senão o plano o inclui).
      const p = c.roomId ? this.parties.get(c.roomId) : undefined
      if (this.partyOn && !out && (p || c.roomId === null) && !(c.roomId && this.pending.has(c.roomId))) this.join(b, 'dance', p ? p.dancers++ : 0)
      this.yieldLounge(b)
      return b
    }
    onStage(b, outside, m.offstage === true, this.t)
    if (b.mode === 'fixed' && Math.hypot(home.x - b.home.x, home.z - b.home.z) > 0.05) b.mode = 'init'
    Object.assign(b, { role, style, roomId: c.roomId, projectId, home, desk, lounge, monitor, side })
    this.yieldLounge(b)
    return b
  }

  /** Personagem saiu do modelo: some já, ou (subagente que voltou) sai andando pela porta. */
  drop(key: string, exitByDoor: boolean): void {
    const b = this.brains.get(key)
    if (!b) return
    if (exitByDoor && b.visible && b.roomId && this.rooms.has(b.roomId)) {
      b.role = 'visitor'
      b.phase = 'done'
      // Fantasma não fica na festa: sai pela porta.
      Object.assign(b, { party: null, puppet: false, prop: null })
      this.partyRoles.delete(key)
      this.ghosts.add(key)
      return
    }
    this.forget(key)
  }

  /** Fantasma já atravessou a porta (ou nunca foi fantasma e não existe mais). */
  gone(key: string): boolean {
    const b = this.brains.get(key)
    return !b || (this.ghosts.has(key) && !b.visible)
  }

  isGhost(key: string): boolean {
    return this.ghosts.has(key)
  }

  forget(key: string): void {
    const b = this.brains.get(key)
    if (b) this.list.splice(this.list.indexOf(b), 1)
    this.book.releaseAll(key)
    this.brains.delete(key)
    this.ghosts.delete(key)
    this.partyRoles.delete(key)
  }

  /** Status de cada personagem e as reações aos eventos do retrato. */
  apply(life: LifeInput): void {
    this.t = life.t
    for (const [key, s] of life.snapshot.agents) {
      const b = this.brains.get(key)
      if (b && !this.ghosts.has(key)) setStatus(b, brainStatus(s, life.t, life.wallNow), life.t)
    }
    for (const e of life.events) {
      const b = this.brains.get(e.key)
      if (b) react(b, e, this)
    }
  }

  /** Um passo de todos os cérebros. */
  step(dt: number, t: number, camX: number, camZ: number): void {
    this.t = t
    this.camX = camX
    this.camZ = camZ
    if (this.pending.size > 0) {
      for (const id of this.pending) this.planParty(id)
      this.pending.clear()
    }
    for (let i = 0; i < this.list.length; i++) stepBrain(this.list[i], dt, this)
    if (this.partyOn) this.partyStep(dt)
  }

  // ── BrainWorld ────────────────────────────────────────────────────────────

  private navOf(b: Brain): RoomNav | undefined {
    return b.roomId ? this.rooms.get(b.roomId) : undefined
  }

  /** O lounge: quem trabalha (sem mesa, com lugar no lounge) tem prioridade — quem cochila ali levanta e cochila em outro lugar (ou na mesa). */
  private yieldLounge(b: Brain): void {
    if (!b.lounge) return
    for (const o of this.list) if (o !== b && o.mode === 'sleep' && o.poi?.kind === 'sofa' && LOUNGE_SEATS[o.poi.index] === b.lounge) o.mode = 'init'
  }

  plan(b: Brain): number {
    return planPath(b, this.navOf(b), this.scratch)
  }

  claim(b: Brain, kind: PoiKind): Poi | null {
    const nav = this.navOf(b)
    if (!nav) return null
    // Sorteio uniforme entre os livres (reservatório: sem montar lista).
    let pick: Poi | null = null
    let count = 0
    for (const p of nav.furniture.pois) {
      if (p.kind !== kind || !this.book.isFree(p.id, b.key) || this.held(b, p)) continue
      count++
      if (this.rnd() * count < 1) pick = p
    }
    return pick && this.book.claim(pick.id, b.key) ? pick : null
  }

  /** Lugar de quem trabalha ali (fora do sorteio): o assento do lounge (mesmo lá fora pelo filtro) e o lugar da memória na estante. */
  private held(b: Brain, p: Poi): boolean {
    if (p.kind !== 'sofa' && p.kind !== 'shelf') return false
    for (const o of this.list) {
      if (o === b) continue
      if (p.kind === 'sofa' && o.lounge === LOUNGE_SEATS[p.index]) return true
      if (p.kind === 'shelf' && o.style === 'archive' && !o.outside && Math.hypot(o.home.x - p.x, o.home.z - p.z) < 0.05) return true
    }
    return false
  }

  release(b: Brain): void {
    this.book.releaseAll(b.key)
  }

  queueSpot(b: Brain): Poi | null {
    const nav = this.navOf(b)
    if (!nav) return null
    const cur = b.poi && nav.queue.includes(b.poi) ? b.poi : null
    for (const p of nav.queue) {
      if (p === cur) return cur
      if (!this.book.isFree(p.id, b.key)) continue
      if (cur) this.book.release(cur.id, b.key)
      this.book.claim(p.id, b.key)
      return p
    }
    return cur
  }

  wander(b: Brain, out: { x: number; z: number }): boolean {
    const nav = this.navOf(b)
    if (!nav) return false
    for (let k = 0; k < 12; k++) {
      const i = nav.grid.randomFree(this.rnd)
      if (i < 0) return false
      const x = nav.grid.cellX(i)
      const z = nav.grid.cellZ(i)
      if (Math.hypot(x - b.x, z - b.z) < 1.5) continue
      out.x = x
      out.z = z
      return true
    }
    return false
  }

  pairUp(b: Brain): boolean {
    const nav = this.navOf(b)
    if (!nav) return false
    const pair = nav.chats.find(([p0, p1]) => this.book.isFree(p0.id) && this.book.isFree(p1.id))
    if (!pair) return false
    let mate: Brain | null = null
    let count = 0
    for (const o of this.brains.values()) {
      if (o === b || o.roomId !== b.roomId || o.mode !== 'free' || !o.visible || o.chatWith !== null || this.ghosts.has(o.key)) continue
      if (o.leisure !== null && o.leisure !== 'phone' && o.leisure !== 'window') continue
      count++
      if (this.rnd() * count < 1) mate = o
    }
    if (!mate) return false
    const d0 = Math.hypot(pair[0].x - b.x, pair[0].z - b.z)
    const d1 = Math.hypot(pair[1].x - b.x, pair[1].z - b.z)
    const [mine, theirs] = d0 <= d1 ? pair : [pair[1], pair[0]]
    this.book.releaseAll(b.key)
    this.book.releaseAll(mate.key)
    this.book.claim(mine.id, b.key)
    this.book.claim(theirs.id, mate.key)
    const dur = DWELL_MIN + this.rnd() * (DWELL_MAX - DWELL_MIN)
    beginChat(b, mate.key, true, mine, dur)
    beginChat(mate, b.key, false, theirs, dur)
    return true
  }

  partner(b: Brain): Brain | null {
    const o = b.chatWith ? this.brains.get(b.chatWith) : undefined
    return o && o.leisure === 'chat' && o.chatWith === b.key && o.mode === 'free' ? o : null
  }

  /** O lugar de uma parada no quadro (brainBoard.boardSpotIn): coluna reservada, bloquinho ou cesto. */
  boardSpot(b: Brain, col: number, out: BoardSpot): boolean {
    return boardSpotIn(this.navOf(b)?.furniture, this.book, b, col, out)
  }

  doorOut(b: Brain): Spot | null {
    return this.navOf(b)?.furniture.doorOut ?? null
  }

  frontSpot(b: Brain): Spot {
    const queue = this.list.filter((o) => o.mode === 'permission' && o.visible).sort((x, y) => (x.key < y.key ? -1 : 1))
    const s = FRONT_SPOTS[Math.max(0, queue.indexOf(b)) % FRONT_SPOTS.length]
    return { x: s.x, z: s.z, yaw: Math.PI }
  }

  party(b: Brain): RoomParty | null {
    return this.partyOn && b.roomId ? (this.parties.get(b.roomId) ?? null) : null
  }

  /** A mesa de quem come pizza na festa (a caixa vai para a cadeira dela); null sem ninguém. */
  pizzaDesk(): DeskRef | null {
    for (const b of this.list) if (b.party === 'pizza' && b.desk) return b.desk
    return null
  }
}
