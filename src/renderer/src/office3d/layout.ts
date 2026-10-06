/**
 * OfficeModel → layout 3D. Puro: mesma entrada (modelo + layout anterior),
 * mesmo layout. Não conhece three.
 *
 * UM escritório para todos os projetos (officePlan.ts): `rooms` tem sempre um
 * elemento só, a sala física OFFICE_ID, com as 16 estações fixas (com ou sem
 * dono). O projeto (o `roomId` do modelo) vira atributo do personagem
 * (`projectId`); todo personagem fica na sala física (`roomId = OFFICE_ID`).
 *
 * Mesas (quem pede: placement 'seat' — principais e especialistas com mesa):
 * - quem já tinha mesa fica com ela; ninguém é empurrado;
 * - cada ilha é reservada para um projeto: o primeiro que senta numa ilha vazia
 *   a ganha; a reserva dura enquanto o projeto tiver alguém no modelo (o filtro
 *   de projeto não tira ninguém do modelo) e some com o último;
 * - personagem novo do projeto P: frente livre na ilha de P → fundo livre na
 *   ilha de P → frente livre numa ilha sem reserva (que passa a ser de P, na
 *   ordem fixa 0,1,2,3) → frente livre em qualquer ilha → fundo livre em
 *   qualquer ilha → lounge (4 lugares) → de pé ao lado da ilha do principal da
 *   mesma conversa;
 * - fundo → frente só quando o personagem COMEÇA um turno (`active` passa de
 *   false a true) e só para uma frente livre da mesma ilha;
 * - quem estava no lounge ou de pé pega mesa assim que vagar uma.
 * 'beside' fica ao lado do pai; 'destination' num lugar fixo: PO junto do
 * kanban, memória na estante de Memórias, Central no console. Fora de cena (o
 * Manager de plano já enviado, offstage.ts) fica do lado de fora da porta.
 *
 * Eixos: X à direita, Z para a câmera, Y para cima. Estação `dir +1`: o
 * monitor olha para +Z e quem senta fica em z + SEAT_FRONT, de costas para a
 * câmera (yaw 0); `dir −1`: espelhada (yaw π).
 */
import type { OfficeCharacterModel, OfficeModel } from '../office/adapter/model'
import { managerSeat } from './meetingRoom'
import {
  CENTRAL_SPOT,
  DOOR,
  ISLANDS,
  islandSideSpots,
  LOUNGE_SEATS,
  MEMORY_SPOT_X,
  MEMORY_SPOTS_Z,
  MEMORY_WAIT,
  MONITOR_BACK,
  MONITOR_Y,
  OFFICE,
  OFFICE_D,
  OFFICE_ID,
  OFFICE_W,
  PLAZA_SPOTS,
  PO_SPOTS,
  SEAT_FRONT,
  STATIONS
} from './officePlan'

export { DESK_HEIGHT, MONITOR_BACK, MONITOR_Y, OFFICE_ID, SEAT_FRONT } from './officePlan'

export const BESIDE_STEP = 0.75

export interface DeskLayout {
  index: number
  x: number
  z: number
  /** +1: monitor olha para +Z (a "frente"); −1: espelhada. */
  dir: 1 | -1
  /** Lado de fora da ilha (−1 esquerda, +1 direita). */
  out: 1 | -1
  island: number
  front: boolean
  ownerKey: string | null
  /** Projeto do dono (a plaquinha da mesa); null livre. */
  projectId: string | null
}

export interface IslandLayout {
  index: number
  x: number
  z: number
  /** Projeto que reservou a ilha (a placa no chão); null livre. */
  projectId: string | null
  name: string | null
  icon: string | null
}

export interface RoomLayout {
  id: string
  name: string
  icon: string | null
  slot: number
  /** Canto (x mínimo, z mínimo) do escritório. */
  x: number
  z: number
  width: number
  depth: number
  desks: DeskLayout[]
  islands: IslandLayout[]
}

export interface ProjectLayout {
  id: string
  name: string
  /** Ícone do projeto (feed.projectIcons[cwd]): data URL, caminho, emoji ou null. */
  icon: string | null
  /** Ilhas reservadas para ele. */
  islands: number[]
  /** Personagens dele no escritório. */
  agents: number
}

export type CharacterSpot = 'desk' | 'lounge' | 'stand' | 'beside' | 'po' | 'memory' | 'central' | 'manager' | 'offstage'

export interface CharacterLayout {
  key: string
  /** A sala física: sempre OFFICE_ID. */
  roomId: string
  /** O projeto (o roomId do modelo); null para a Central. */
  projectId: string | null
  x: number
  z: number
  /** Para onde olha parado no lugar (0 olha para −Z). */
  yaw: number
  /** Mesa ocupada ou null. */
  deskIndex: number | null
  /** Mesa cujo monitor representa o personagem (a dele ou a do pai). */
  screenDesk: { roomId: string; index: number } | null
  /** Lugar do lounge (0..3) de quem ficou sem mesa; null nos outros. */
  lounge: number | null
  spot: CharacterSpot
  model: OfficeCharacterModel
}

export interface Office3DLayout {
  /** Sempre [o escritório]. */
  rooms: RoomLayout[]
  projects: ProjectLayout[]
  characters: CharacterLayout[]
  /** Estado para a próxima chamada: mesa por personagem e ilhas por projeto. */
  deskOf: Record<string, number>
  islandOf: Record<string, number[]>
}

/** O escritório com as mesas e ilhas no estado dado (sem dono por padrão). */
function officeRoom(): RoomLayout {
  return {
    id: OFFICE_ID,
    name: 'Escritório',
    icon: null,
    slot: 0,
    x: OFFICE.x0,
    z: OFFICE.z0,
    width: OFFICE_W,
    depth: OFFICE_D,
    desks: STATIONS.map((s) => ({ index: s.index, x: s.x, z: s.z, dir: s.dir, out: s.out, island: s.island, front: s.front, ownerKey: null, projectId: null })),
    islands: ISLANDS.map((i) => ({ index: i.index, x: i.x, z: i.z, projectId: null, name: null, icon: null }))
  }
}

export const EMPTY_LAYOUT: Office3DLayout = { rooms: [officeRoom()], projects: [], characters: [], deskOf: {}, islandOf: {} }

/** Caixa (no chão) que envolve as salas; null sem salas. */
export function buildingBounds(rooms: readonly RoomLayout[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (rooms.length === 0) return null
  return {
    minX: Math.min(...rooms.map((r) => r.x)),
    maxX: Math.max(...rooms.map((r) => r.x + r.width)),
    minZ: Math.min(...rooms.map((r) => r.z)),
    maxZ: Math.max(...rooms.map((r) => r.z + r.depth))
  }
}

/** Centro da tela do monitor da mesa e para onde ela olha (dir·Z). */
export function monitorPosition(desk: Pick<DeskLayout, 'x' | 'z'> & { dir?: 1 | -1 }): { x: number; y: number; z: number; dir: 1 | -1 } {
  const dir = desk.dir ?? 1
  return { x: desk.x, y: MONITOR_Y, z: desk.z - dir * MONITOR_BACK, dir }
}

/** O projeto de um personagem: o roomId do modelo (null para a Central). */
export const projectOf = (c: Pick<OfficeCharacterModel, 'roomId'>): string | null => c.roomId

const wantsDesk = (c: OfficeCharacterModel): boolean => c.placement.kind === 'seat' && c.roomId !== null

export function layoutOffice(model: OfficeModel, prev: Office3DLayout = EMPTY_LAYOUT): Office3DLayout {
  const room = officeRoom()
  const desks = room.desks
  const present = new Set<string>()
  for (const c of model.characters) {
    const p = projectOf(c)
    if (p) present.add(p)
  }

  // Ilhas: a reserva continua enquanto o projeto tiver alguém no escritório.
  const owner: Array<string | null> = ISLANDS.map(() => null)
  for (const [project, islands] of Object.entries(prev.islandOf)) {
    if (!present.has(project)) continue
    for (const i of islands) if (owner[i] === null) owner[i] = project
  }
  const islandsOf = (p: string): number[] => owner.flatMap((o, i) => (o === p ? [i] : []))

  // Mesas: quem já tinha fica (ninguém é empurrado).
  const deskOf: Record<string, number> = {}
  const taken: Array<string | null> = desks.map(() => null)
  const seated = model.characters.filter(wantsDesk)
  for (const c of seated) {
    const d = prev.deskOf[c.key]
    if (d === undefined || taken[d] !== null) continue
    taken[d] = c.key
    deskOf[c.key] = d
  }
  // Fundo → frente: a tela da mesa da frente fica virada para a câmera (o usuário vê o que o agente faz).
  // Vagou uma frente da ilha dele (ou de outra ilha do mesmo projeto), quem está no fundo muda para ela já.
  for (const c of seated) {
    const d = deskOf[c.key]
    if (d === undefined || desks[d].front) continue
    const mine = new Set([desks[d].island, ...islandsOf(c.roomId as string)])
    const free = desks.find((k) => k.island === desks[d].island && k.front && taken[k.index] === null) ?? desks.find((k) => mine.has(k.island) && k.front && taken[k.index] === null)
    if (!free) continue
    taken[d] = null
    taken[free.index] = c.key
    deskOf[c.key] = free.index
  }
  // Quem não tem mesa (novo, ou estava no lounge/de pé): a ordem de escolha.
  const pick = (p: string): number | null => {
    const freeIn = (island: number, front: boolean): number | null => {
      const k = desks.find((d) => d.island === island && d.front === front && taken[d.index] === null)
      return k ? k.index : null
    }
    for (const front of [true, false]) for (const i of islandsOf(p)) {
      const k = freeIn(i, front)
      if (k !== null) return k
    }
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== null) continue
      const k = freeIn(i, true)
      if (k === null) continue
      owner[i] = p
      return k
    }
    for (const front of [true, false]) for (let i = 0; i < owner.length; i++) {
      const k = freeIn(i, front)
      if (k === null) continue
      // Ilha sem reserva onde o projeto sem ilha senta (pelo fundo): passa a ser dele.
      if (owner[i] === null && islandsOf(p).length === 0) owner[i] = p
      return k
    }
    return null
  }
  for (const c of seated) {
    if (deskOf[c.key] !== undefined) continue
    const k = pick(c.roomId as string)
    if (k === null) continue
    taken[k] = c.key
    deskOf[c.key] = k
  }

  // Dono e projeto de cada mesa e de cada ilha.
  const byKey = new Map(model.characters.map((c) => [c.key, c]))
  for (const d of desks) {
    const key = taken[d.index]
    d.ownerKey = key
    d.projectId = key ? (byKey.get(key)?.roomId ?? null) : null
  }
  const projectModel = new Map(model.rooms.map((r) => [r.id, r]))
  for (const isl of room.islands) {
    const p = owner[isl.index]
    const m = p ? projectModel.get(p) : undefined
    isl.projectId = p
    isl.name = m?.name ?? null
    isl.icon = m?.icon ?? null
  }

  const prevLounge = new Map(prev.characters.flatMap((c): Array<[string, number]> => (c.lounge !== null ? [[c.key, c.lounge]] : [])))
  const characters = placeCharacters(model, room, deskOf, prevLounge)
  const agents = new Map<string, number>()
  for (const c of model.characters) {
    const p = projectOf(c)
    if (p) agents.set(p, (agents.get(p) ?? 0) + 1)
  }
  const projects: ProjectLayout[] = model.rooms.map((r) => ({ id: r.id, name: r.name, icon: r.icon ?? null, islands: islandsOf(r.id), agents: agents.get(r.id) ?? 0 }))
  const islandOf: Record<string, number[]> = {}
  for (const p of projects) if (p.islands.length > 0) islandOf[p.id] = p.islands
  return { rooms: [room], projects, characters, deskOf, islandOf }
}

/** Onde cada personagem fica parado (a mesa, o lounge, o lugar fixo ou ao lado do pai). */
function placeCharacters(model: OfficeModel, room: RoomLayout, deskOf: Record<string, number>, prevLounge: ReadonlyMap<string, number>): CharacterLayout[] {
  const out: CharacterLayout[] = []
  const byKey = new Map<string, CharacterLayout>()
  const besideCount = new Map<string, number>()
  const used = new Set<string>()
  const counters = { po: 0, memory: 0, plaza: 0, manager: 0 }
  // Lounge estável como as mesas: quem já tinha lugar fica com ele (ninguém é empurrado); os novos pegam os livres.
  const loungeOf = new Map<string, number>()
  const taken = new Set<number>()
  const wantsLounge = model.characters.filter((c) => c.placement.kind === 'seat' && c.roomId !== null && deskOf[c.key] === undefined)
  for (const c of wantsLounge) {
    const i = prevLounge.get(c.key)
    if (i === undefined || taken.has(i)) continue
    loungeOf.set(c.key, i)
    taken.add(i)
  }
  for (const c of wantsLounge) {
    if (loungeOf.has(c.key)) continue
    const i = LOUNGE_SEATS.findIndex((_, k) => !taken.has(k))
    if (i < 0) break
    loungeOf.set(c.key, i)
    taken.add(i)
  }
  const islandOfConv = new Map<string, number>()
  for (const c of model.characters) {
    const d = deskOf[c.key]
    if (d !== undefined && c.role === 'principal') islandOfConv.set(c.convId, room.desks[d].island)
  }
  const base = (c: OfficeCharacterModel, x: number, z: number, yaw: number, spot: CharacterSpot): CharacterLayout => ({
    key: c.key,
    roomId: OFFICE_ID,
    projectId: projectOf(c),
    x,
    z,
    yaw,
    deskIndex: null,
    screenDesk: null,
    lounge: null,
    spot,
    model: c
  })
  const plaza = (c: OfficeCharacterModel): CharacterLayout => {
    const s = PLAZA_SPOTS[counters.plaza++ % PLAZA_SPOTS.length]
    return base(c, s.x, s.z, 0, 'stand')
  }
  for (const c of model.characters) {
    let o: CharacterLayout | null = null
    const p = c.placement
    if (c.offstage) {
      // Fora de cena (plano enviado: o corpo dele foi para o PC): lá fora, sem ocupar a cabeceira nem mesa.
      o = base(c, OFFICE.x1 + 1, DOOR.z, 0, 'offstage')
    } else if (p.kind === 'seat' && c.roomId !== null) {
      const d = deskOf[c.key]
      if (d !== undefined) {
        const desk = room.desks[d]
        o = base(c, desk.x, desk.z + desk.dir * SEAT_FRONT, desk.dir === 1 ? 0 : Math.PI, 'desk')
        o.deskIndex = d
        o.screenDesk = { roomId: OFFICE_ID, index: d }
      } else if (loungeOf.has(c.key)) {
        const i = loungeOf.get(c.key)!
        const s = LOUNGE_SEATS[i]
        o = base(c, s.x, s.z, s.yaw, 'lounge')
        o.lounge = i
      } else {
        // Lounge cheio: de pé ao lado da ilha do principal da mesma conversa (ou da do projeto).
        const island = islandOfConv.get(c.convId) ?? room.islands.find((i) => i.projectId === c.roomId)?.index ?? null
        const spot = island === null ? undefined : islandSideSpots(island).find((s) => !used.has(`${s.x},${s.z}`))
        if (spot) {
          used.add(`${spot.x},${spot.z}`)
          o = base(c, spot.x, spot.z, spot.yaw, 'stand')
        } else o = plaza(c)
      }
    } else if (p.kind === 'beside') {
      const parent = byKey.get(p.parentKey)
      if (parent) {
        const n = (besideCount.get(parent.key) ?? 0) + 1
        besideCount.set(parent.key, n)
        const side = n % 2 === 1 ? 1 : -1
        const back = parent.deskIndex !== null ? room.desks[parent.deskIndex].dir : 1
        o = base(c, parent.x + side * BESIDE_STEP * Math.ceil(n / 2), parent.z + back * 0.2, parent.yaw, 'beside')
        o.projectId = parent.projectId ?? o.projectId
        o.screenDesk = parent.screenDesk
      }
    } else if (p.kind === 'destination') {
      if (p.papel === 'kanban') {
        const s = PO_SPOTS[counters.po++ % PO_SPOTS.length]
        o = base(c, s.x, s.z, 0, 'po')
      } else if (p.papel === 'arquivo-memorias') {
        const i = counters.memory++
        o = i < MEMORY_SPOTS_Z.length ? base(c, MEMORY_SPOT_X, MEMORY_SPOTS_Z[i], -Math.PI / 2, 'memory') : base(c, MEMORY_WAIT.x, MEMORY_WAIT.z, -Math.PI / 2, 'memory')
      } else if (p.papel === 'central') {
        o = base(c, CENTRAL_SPOT.x, CENTRAL_SPOT.z, CENTRAL_SPOT.yaw, 'central')
      } else if (p.papel === 'reuniao-cabeceira') {
        // O Agent Manager: à cabeceira da mesa da sala de reunião (sem cadeira livre, na praça).
        const s = managerSeat(counters.manager++)
        o = s ? base(c, s.x, s.z, s.yaw, 'manager') : plaza(c)
      } else o = plaza(c)
    } else {
      o = plaza(c)
    }
    if (!o) continue
    out.push(o)
    byKey.set(c.key, o)
  }
  return out
}
