/**
 * Plano da festa do apagão — PURO (sem three). No escritório único: quem
 * procura o disjuntor com a lanterna, quem come pizza sentado na mesa, quem
 * entra no trenzinho (conga) em volta de uma ilha e quem dança na boca do U das
 * outras três; e ONDE cada um fica (vagas da pista, a volta do trenzinho, a rota da
 * lanterna pelos móveis, o poleiro na beira da mesa). Os papéis saem da seed
 * de cada agente: o mesmo escritório faz sempre a mesma festa.
 *
 * Papéis (assignRoles): com 3+ presentes, o primeiro pega a lanterna; com 3+
 * sobrando, até CONGA_MAX viram trenzinho; com 3+ ainda sobrando, quem tem mesa
 * come pizza; o resto dança.
 */
import type { Brain } from './brainBody'
import { chairSide, type RoomFurniture, type Spot } from './furniture'
import { deskPoint, ISLAND_PLAQUE_Z, ISLANDS, U_EXTENT } from './officePlan'

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
  /** A ilha do trenzinho (a pista fica na frente das outras três). */
  readonly congaIsland: number
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
/** Poleiro de quem come pizza: na beira da mesa, do lado de fora da ilha, de costas para o monitor. */
export const PERCH = { dx: 0.4, dz: 0.42 } as const

/** Vagões do trenzinho, no máximo (o resto vai para a pista). */
export const CONGA_MAX = 6

export function assignRoles(members: readonly PartyMember[]): Map<string, PartySeat> {
  const rest = [...members].sort((a, b) => a.seed - b.seed || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const out = new Map<string, PartySeat>()
  if (rest.length >= 3) out.set(rest.shift()!.key, { role: 'flashlight', slot: 0 })
  if (rest.length >= 3) rest.splice(0, Math.min(CONGA_MAX, rest.length)).forEach((m, i) => out.set(m.key, { role: 'conga', slot: i }))
  if (rest.length >= 3) {
    const i = rest.findIndex((m) => m.hasDesk)
    if (i >= 0) out.set(rest.splice(i, 1)[0].key, { role: 'pizza', slot: 0 })
  }
  rest.forEach((m, i) => out.set(m.key, { role: 'dance', slot: i }))
  return out
}

/** Vagas da pista na frente de uma ilha (dx, dz a partir da placa no chão dela). */
const DANCE_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-0.75, 0], [0.75, 0], [-0.4, -0.6], [0.4, -0.6], [-1.15, -0.6], [1.15, -0.6]
]

/**
 * Vaga `slot` da pista, de frente para a câmera: a festa se espalha pela frente
 * das três ilhas sem o trenzinho (como a festa de cada sala de antes), não num
 * bolo só — de perto de uma ilha se vê a turma dela.
 */
export function danceSpot(congaIsland: number, slot: number, out: Spot): Spot {
  const k = slot % 3
  const isl = ISLANDS[k >= congaIsland ? k + 1 : k]
  const row = Math.floor(slot / 3)
  const [dx, dz] = DANCE_SLOTS[row % DANCE_SLOTS.length]
  const ring = Math.floor(row / DANCE_SLOTS.length)
  out.x = isl.x + dx + (ring % 2) * 0.37
  out.z = isl.z + ISLAND_PLAQUE_Z + 0.1 + dz - ring * 0.3
  out.yaw = Math.PI
  return out
}

/** A ilha do trenzinho, pela seed do escritório. */
export function congaIsland(seed: number): number {
  return Math.floor(Math.abs(seed) * 7) % ISLANDS.length
}

/** A volta do trenzinho: em torno do U inteiro (mesas, cadeiras recuadas e lugares de pé), por fora dele. */
export function congaLoop(island: number): CongaLoop {
  const isl = ISLANDS[island]
  const hz = (U_EXTENT.z1 - U_EXTENT.z0) / 2
  return { cx: isl.x, cz: isl.z + U_EXTENT.z0 + hz, a: U_EXTENT.x1 + 0.55, b: hz + 0.55 }
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
export function pizzaPerch(desk: { x: number; z: number; yaw: number; out: 1 | -1 }): { seat: Spot; stand: Spot } {
  const p = deskPoint(desk, desk.out * PERCH.dx, PERCH.dz)
  return { seat: { x: p.x, z: p.z, yaw: desk.yaw + Math.PI }, stand: chairSide(desk) }
}

/**
 * Monta o plano do escritório com os presentes: o papel de cada um (nos
 * cérebros) e o trenzinho em ordem. Quem já estava na festa e mudou de papel
 * volta a 'init' — o próximo passo o leva para o lugar novo.
 */
export function planRoomParty(roomId: string, furniture: RoomFurniture, members: readonly Brain[], seed: number): RoomParty {
  const roles = assignRoles(members.map((b) => ({ key: b.key, seed: b.seed, hasDesk: b.desk !== null })))
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
  const island = congaIsland(seed)
  return { roomId, furniture, loop: congaLoop(island), congaIsland: island, route: flashRoute(furniture, seed), conga, congaS: 0, congaGo: false, dancers }
}
