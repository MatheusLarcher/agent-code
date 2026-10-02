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
 */
import type { CrewRole } from '../crew'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import {
  beginChat,
  brainStatus,
  createBrain,
  DWELL_MAX,
  DWELL_MIN,
  react,
  relocate,
  setStatus,
  stepBrain,
  type Brain,
  type BrainWorld,
  type FixedStyle,
  type Role
} from './brain'
import type { AgentEvent, AgentPhase, OfficeSnapshot } from './events'
import { roomFurniture, type Poi, type PoiKind, type RoomFurniture, type Spot } from './furniture'
import { DESK_COLS, MONITOR_BACK, MONITOR_Y, type CharacterLayout, type RoomLayout } from './layout'
import { buildNavGrid, PoiBook, type NavGrid } from './nav'
import { rng as mulberry } from './textures'

/** No modo demonstração o cochilo chega DEMO_TIME_FACTOR vezes mais cedo. */
export const DEMO_TIME_FACTOR = 20

/** O que o motor manda a cada feed: o retrato, os eventos e os relógios. */
export interface LifeInput {
  snapshot: OfficeSnapshot
  events: readonly AgentEvent[]
  /** Epoch ms do retrato (o `now` de snapshotOf/diffEvents). */
  wallNow: number
  /** Relógio do motor (s) no mesmo instante. */
  t: number
}

interface RoomNav {
  sig: string
  room: RoomLayout
  furniture: RoomFurniture
  grid: NavGrid
  /** Fila do café, da máquina para trás. */
  queue: Poi[]
  chats: Array<[Poi, Poi]>
}

const SEATED_VISITORS: ReadonlySet<CrewRole> = new Set<CrewRole>(['executor', 'critico', 'navegador-de-codigo'])

const navSig = (r: RoomLayout): string => `${r.x},${r.z},${r.width},${r.depth},${r.desks.length}`

/** Fase só pelo modelo (sem retrato de events.ts — testes e o 1º quadro). */
export function modelPhase(m: OfficeCharacterModel): AgentPhase {
  if (m.bubble === 'permissao' || m.bubble === 'pergunta') return 'waiting-permission'
  if (m.bubble === 'erro') return 'error'
  return m.active ? 'working' : 'idle'
}

function roleOf(c: CharacterLayout): Role {
  const m = c.model
  if (c.roomId === null || m.placement.kind === 'destination' || m.role === 'vigia') return 'fixed'
  if (m.role === 'principal') return 'desk'
  return SEATED_VISITORS.has(m.role) || m.role === 'subagente' ? 'visitor' : 'fixed'
}

function seedOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return ((h >>> 0) % 6283) / 1000
}

export class Crowd implements BrainWorld {
  t = 0
  camX = 0
  camZ = 0
  sleepAfter = SLEEP_AFTER_SEC
  readonly brains = new Map<string, Brain>()
  /** Os mesmos cérebros em lista: o passo por quadro percorre sem criar iterador. */
  readonly list: Brain[] = []
  readonly book = new PoiBook()
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
        chats: [[chat[0], chat[1]], [chat[2], chat[3]]]
      }
      this.rooms.set(r.id, nav)
      if (cur) this.moveIn(r.id, cur, nav)
    }
    for (const id of [...this.rooms.keys()]) {
      if (seen.has(id)) continue
      this.rooms.delete(id)
      this.book.dropRoom(id)
    }
  }

  /**
   * A sala foi refeita (andou na grade ou ganhou/perdeu fileira de mesas): quem
   * está nela vai junto. Quem cochila no pufe acompanha o pufe (que fica perto
   * da frente) e continua com ele reservado; quem saía pela porta ou esperava
   * na fila recalcula o destino; o resto só replaneja.
   */
  private moveIn(roomId: string, old: RoomNav, nu: RoomNav): void {
    this.book.dropRoom(roomId)
    const pufe = nu.furniture.pois.find((p) => p.kind === 'pufe')
    for (const b of this.brains.values()) {
      if (b.roomId !== roomId) continue
      const onPufe = b.seat === 'pufe' || b.goal.seat === 'pufe'
      const from = onPufe ? old.furniture.pufe : old.room
      const to = onPufe ? nu.furniture.pufe : nu.room
      relocate(b, to.x - from.x, to.z - from.z)
      if (onPufe && pufe && this.book.claim(pufe.id, b.key)) b.poi = pufe
      if (b.mode === 'leave' || b.mode === 'queue') b.mode = 'init'
    }
  }

  /**
   * Cria ou atualiza o cérebro de um personagem do layout. `away` só vale na
   * criação: visitante que acabou de ser delegado (ou que não está trabalhando)
   * nasce do lado de fora da porta.
   */
  upsert(c: CharacterLayout, away: boolean, desks: ReadonlyMap<string, RoomLayout>): Brain {
    const m = c.model
    const role = roleOf(c)
    const room = c.roomId ? desks.get(c.roomId) : undefined
    const own = c.deskIndex !== null && room ? room.desks[c.deskIndex] : undefined
    const screen = c.screenDesk ? desks.get(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
    const home: Spot = { x: c.x, z: c.z, yaw: c.roomId === null ? Math.PI : 0 }
    const desk = role === 'fixed' || !own ? null : { x: own.x, z: own.z }
    const monitor = screen ? { x: screen.x, y: MONITOR_Y, z: screen.z - MONITOR_BACK } : null
    const style: FixedStyle = m.role === 'po' ? 'board' : m.role === 'memoria' ? 'archive' : 'idle'
    const side = own ? (own.index % DESK_COLS < DESK_COLS - 1 ? 1 : -1) : 1
    this.ghosts.delete(c.key)
    let b = this.brains.get(c.key)
    if (!b) {
      b = createBrain({ key: c.key, role, style, roomId: c.roomId, home, desk, monitor, side, seed: seedOf(c.key), away: role === 'visitor' && away })
      this.brains.set(c.key, b)
      this.list.push(b)
      return b
    }
    Object.assign(b, { role, style, roomId: c.roomId, home, desk, monitor, side })
    return b
  }

  /** Personagem saiu do modelo: some já, ou (subagente que voltou) sai andando pela porta. */
  drop(key: string, exitByDoor: boolean): void {
    const b = this.brains.get(key)
    if (!b) return
    if (exitByDoor && b.visible && b.roomId && this.rooms.has(b.roomId)) {
      b.role = 'visitor'
      b.phase = 'done'
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
    for (let i = 0; i < this.list.length; i++) stepBrain(this.list[i], dt, this)
  }

  // ── BrainWorld ────────────────────────────────────────────────────────────

  private navOf(b: Brain): RoomNav | undefined {
    return b.roomId ? this.rooms.get(b.roomId) : undefined
  }

  plan(b: Brain): number {
    const g = b.goal
    const out = b.path
    const nav = this.navOf(b)
    if (!nav) {
      out[0] = g.x
      out[1] = g.z
      return 1
    }
    const { room, furniture: f } = nav
    let n = 0
    let sx = b.x
    let sz = b.z
    // De fora da sala: entra pela porta antes de qualquer coisa.
    if (b.x < room.x || b.x > room.x + room.width || b.z < room.z || b.z > room.z + room.depth) {
      out[0] = sx = f.doorIn.x
      out[1] = sz = f.doorIn.z
      n = 1
    }
    const tx = g.exit ? f.doorIn.x : g.x
    const tz = g.exit ? f.doorIn.z : g.z
    const m = nav.grid.findPath(sx, sz, tx, tz, this.scratch)
    const cap = (out.length >> 1) - 1
    if (m === 0) {
      out[n * 2] = tx
      out[n * 2 + 1] = tz
      n++
    } else {
      for (let i = 0; i < m && n < cap; i++, n++) {
        out[n * 2] = this.scratch[i * 2]
        out[n * 2 + 1] = this.scratch[i * 2 + 1]
      }
    }
    if (g.exit) {
      out[n * 2] = f.doorOut.x
      out[n * 2 + 1] = f.doorOut.z
      n++
    }
    return n
  }

  claim(b: Brain, kind: PoiKind): Poi | null {
    const nav = this.navOf(b)
    if (!nav) return null
    // Sorteio uniforme entre os livres (reservatório: sem montar lista).
    let pick: Poi | null = null
    let count = 0
    for (const p of nav.furniture.pois) {
      if (p.kind !== kind || !this.book.isFree(p.id, b.key)) continue
      count++
      if (this.rnd() * count < 1) pick = p
    }
    return pick && this.book.claim(pick.id, b.key) ? pick : null
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

  doorOut(b: Brain): Spot | null {
    return this.navOf(b)?.furniture.doorOut ?? null
  }
}
