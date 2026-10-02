/**
 * Plano da festa do apagão — PURO (sem three). Por sala: quem procura o
 * disjuntor com a lanterna, quem come pizza sentado na mesa, quem entra no
 * trenzinho (conga) em volta do tapete e quem vai para a pista; e ONDE cada um
 * fica (vagas da pista no tapete, a volta do trenzinho, a rota da lanterna
 * pelos móveis, o poleiro na beira da mesa). Os papéis saem da seed de cada
 * agente: o mesmo escritório faz sempre a mesma festa.
 *
 * Papéis (assignRoles): com 3+ na sala, o primeiro pega a lanterna; nas salas
 * de trenzinho (slot ímpar) os outros (3+) viram trenzinho; nas outras, quem
 * tem mesa come pizza (com 3+ sobrando) e o resto dança.
 */
import type { Brain } from './brainBody'
import { chairSide, type RoomFurniture, type Spot } from './furniture'

export type PartyRole = 'dance' | 'conga' | 'flashlight' | 'pizza'

export interface PartySeat {
  role: PartyRole
  /** Vaga na pista, lugar no trenzinho (0 = líder)… */
  slot: number
}

export interface PartyMember {
  key: string
  seed: number
  hasDesk: boolean
}

/** Uma parada da lanterna: onde ficar e para onde apontar. */
export interface FlashStop extends Spot {
  lx: number
  ly: number
  lz: number
}

/** A volta do trenzinho: elipse em torno do tapete. */
export interface CongaLoop {
  cx: number
  cz: number
  a: number
  b: number
}

export interface RoomParty {
  readonly roomId: string
  readonly furniture: RoomFurniture
  readonly loop: CongaLoop
  readonly route: readonly FlashStop[]
  /** Chaves do trenzinho, do líder para trás. */
  readonly conga: string[]
  /** Metros (aprox.) andados pelo líder; o crowd soma enquanto o trenzinho anda. */
  congaS: number
  /** Todos chegaram ao ponto de partida: o trenzinho anda. */
  congaGo: boolean
  /** Próxima vaga livre da pista (quem chega atrasado na festa). */
  dancers: number
}

export const CONGA_SPEED = 0.55
/** Distância entre um vagão e outro do trenzinho (m). */
export const CONGA_GAP = 0.62
/** Quanto a lanterna fica em cada parada (s). */
export const FLASH_DWELL = 2.6
/** Poleiro de quem come pizza: na beira da mesa, à direita do teclado, de frente para a sala. */
export const PERCH = { dx: 0.4, dz: 0.3 } as const

/** Trenzinho só em algumas salas: as de slot ímpar. */
export const isCongaRoom = (slot: number): boolean => slot % 2 === 1

export function assignRoles(members: readonly PartyMember[], congaRoom: boolean): Map<string, PartySeat> {
  const rest = [...members].sort((a, b) => a.seed - b.seed || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const out = new Map<string, PartySeat>()
  if (rest.length >= 3) out.set(rest.shift()!.key, { role: 'flashlight', slot: 0 })
  if (congaRoom && rest.length >= 3) {
    rest.forEach((m, i) => out.set(m.key, { role: 'conga', slot: i }))
    return out
  }
  if (rest.length >= 3) {
    const i = rest.findIndex((m) => m.hasDesk)
    if (i >= 0) out.set(rest.splice(i, 1)[0].key, { role: 'pizza', slot: 0 })
  }
  rest.forEach((m, i) => out.set(m.key, { role: 'dance', slot: i }))
  return out
}

/** Vagas da pista em volta do centro do tapete (dx, dz), longe do pufe (à esquerda). */
const DANCE_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [-0.6, -0.25], [0.6, -0.25], [0, 0.45], [1.45, 0.3], [-1.0, 0.55], [1.2, -0.6], [-0.3, -0.8], [0.5, 0.85]
]

/** Vaga `slot` da pista, de frente para a câmera. */
export function danceSpot(f: RoomFurniture, slot: number, out: Spot): Spot {
  const [dx, dz] = DANCE_SLOTS[slot % DANCE_SLOTS.length]
  const ring = Math.floor(slot / DANCE_SLOTS.length)
  out.x = f.rug.x + dx + ring * 0.3
  out.z = f.rug.z + dz + ring * 0.2
  out.yaw = Math.PI
  return out
}

export function congaLoop(f: RoomFurniture): CongaLoop {
  return { cx: f.rug.x, cz: f.rug.z, a: f.rug.w / 2 + 0.45, b: f.rug.d / 2 + 0.2 }
}

/**
 * Ponto e rumo do vagão `slot` quando o líder andou `s` metros; devolve o fator
 * de velocidade daquele trecho (a elipse é mais rápida nos lados compridos).
 */
export function congaPoint(loop: CongaLoop, s: number, slot: number, out: Spot): number {
  const r = (loop.a + loop.b) / 2
  const th = (s - slot * CONGA_GAP) / r
  const c = Math.cos(th)
  const sn = Math.sin(th)
  out.x = loop.cx + loop.a * c
  out.z = loop.cz + loop.b * sn
  const tx = -loop.a * sn
  const tz = loop.b * c
  out.yaw = Math.atan2(-tx, -tz)
  return Math.hypot(tx, tz) / r
}

/** Rota da lanterna pelos móveis (máquina de café, estante, quadro, janelas, plantas, porta), na ordem da seed. */
export function flashRoute(f: RoomFurniture, seed: number): FlashStop[] {
  const stops: FlashStop[] = f.pois
    .filter((p) => p.kind === 'coffee' || p.kind === 'shelf' || p.kind === 'postit' || p.kind === 'window' || p.kind === 'plant')
    .map((p) => ({ x: p.x, z: p.z, yaw: p.yaw, lx: p.look.x, ly: p.look.y, lz: p.look.z }))
  stops.push({ x: f.doorIn.x, z: f.doorIn.z, yaw: Math.PI / 2, lx: f.door.x - 0.5, ly: 1.2, lz: f.door.z })
  // Embaralha de forma estável pela seed (Fisher-Yates com um LCG).
  let h = Math.floor(Math.abs(seed) * 1_000_003) % 2_147_483_647 || 1
  for (let i = stops.length - 1; i > 0; i--) {
    h = (h * 48_271) % 2_147_483_647
    const j = h % (i + 1)
    const t = stops[i]
    stops[i] = stops[j]
    stops[j] = t
  }
  return stops
}

/** Onde sentar na mesa para comer pizza (assento) e de onde pular para ela (em pé, ao lado da cadeira). */
export function pizzaPerch(desk: { x: number; z: number }): { seat: Spot; stand: Spot } {
  return { seat: { x: desk.x + PERCH.dx, z: desk.z + PERCH.dz, yaw: Math.PI }, stand: chairSide(desk, 1) }
}

/**
 * Monta o plano de uma sala com os membros dela: o papel de cada um (nos
 * cérebros) e o trenzinho em ordem. Quem já estava na festa e mudou de papel
 * volta a 'init' — o próximo passo o leva para o lugar novo.
 */
export function planRoomParty(roomId: string, slot: number, furniture: RoomFurniture, members: readonly Brain[], seed: number): RoomParty {
  const roles = assignRoles(
    members.map((b) => ({ key: b.key, seed: b.seed, hasDesk: b.desk !== null })),
    isCongaRoom(slot)
  )
  const conga: string[] = []
  let dancers = 0
  for (const b of members) {
    const seat = roles.get(b.key)
    if (!seat) continue
    if (b.mode === 'party' && (b.party !== seat.role || b.partySlot !== seat.slot)) {
      b.mode = 'init'
      b.puppet = false
    }
    b.party = seat.role
    b.partySlot = seat.slot
    if (seat.role === 'conga') conga[seat.slot] = b.key
    if (seat.role === 'dance') dancers = Math.max(dancers, seat.slot + 1)
  }
  return { roomId, furniture, loop: congaLoop(furniture), route: flashRoute(furniture, seed), conga, congaS: 0, congaGo: false, dancers }
}
