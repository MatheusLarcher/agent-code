/**
 * OfficeModel → layout 3D. Puro: mesma entrada (modelo + layout anterior),
 * mesmo layout. Não conhece three.
 *
 * - Uma sala por room, numa grade de ceil(sqrt(n)) colunas (slot estável por
 *   sala; ver gridCell). Uma linha só se desloca em Z se uma sala de linha
 *   anterior ganhar fileira de mesas.
 * - Mesas por sala = max(4, personagens sentados da sala) — sentados são os
 *   de placement 'seat' (principais e especialistas com mesa).
 * - Cada personagem sentado fica com a mesma mesa enquanto estiver na sala:
 *   quem entra pega a primeira mesa livre e não empurra ninguém.
 * - 'beside' fica ao lado do pai; 'destination' fica num ponto fixo da sala
 *   (PO) ou do corredor (memória, roomId null).
 *
 * Eixos: X à direita, Z para quem olha a sala de frente, Y para cima. Os
 * monitores olham para +Z; o personagem senta em +Z da mesa.
 */
import type { OfficeCharacterModel, OfficeModel } from '../office/adapter/model'

export const DESK_COLS = 4
export const DESK_PITCH_X = 2.4
export const DESK_PITCH_Z = 3
export const ROOM_MARGIN = 1.6
export const ROOM_WIDTH = DESK_COLS * DESK_PITCH_X + ROOM_MARGIN * 2
export const ROOM_GAP = 2
/** Mesa: altura do tampo; monitor: centro da tela e recuo para trás da mesa. */
export const DESK_HEIGHT = 0.75
export const MONITOR_Y = 1.12
export const MONITOR_BACK = 0.25
export const SEAT_FRONT = 0.85
export const BESIDE_STEP = 0.75
export const MIN_DESKS = 4

export interface DeskLayout {
  index: number
  x: number
  z: number
  ownerKey: string | null
}

export interface RoomLayout {
  id: string
  name: string
  /** Ícone do projeto (feed.projectIcons[cwd]): data URL, caminho, emoji ou null. */
  icon: string | null
  slot: number
  /** Canto (x mínimo, z mínimo) da sala. */
  x: number
  z: number
  width: number
  depth: number
  desks: DeskLayout[]
}

export interface CharacterLayout {
  key: string
  roomId: string | null
  x: number
  z: number
  /** Mesa ocupada (índice na sala) ou null. */
  deskIndex: number | null
  /** Mesa cujo monitor representa o personagem (a dele ou a do pai). */
  screenDesk: { roomId: string; index: number } | null
  model: OfficeCharacterModel
}

export interface Office3DLayout {
  rooms: RoomLayout[]
  characters: CharacterLayout[]
  /** Estado para a próxima chamada: slot por sala e mesa por personagem. */
  roomSlots: Record<string, number>
  deskOf: Record<string, { roomId: string; index: number }>
}

export const EMPTY_LAYOUT: Office3DLayout = { rooms: [], characters: [], roomSlots: {}, deskOf: {} }

function firstFree(used: Set<number>): number {
  let i = 0
  while (used.has(i)) i++
  return i
}

export function deskPosition(room: Pick<RoomLayout, 'x' | 'z'>, index: number): { x: number; z: number } {
  const col = index % DESK_COLS
  const row = Math.floor(index / DESK_COLS)
  return {
    x: room.x + ROOM_MARGIN + DESK_PITCH_X * (col + 0.5),
    z: room.z + ROOM_MARGIN + DESK_PITCH_Z * (row + 0.5)
  }
}

/**
 * Célula (coluna, linha) do slot numa grade quadrada que cresce em "camadas":
 * a camada k (slots k²..(k+1)²-1) abre a coluna k (linhas 0..k-1) e depois a
 * linha k (colunas 0..k). Assim n salas ocupam ceil(sqrt(n)) colunas e a
 * célula de um slot nunca muda quando outra sala entra.
 */
export function gridCell(slot: number): { col: number; row: number } {
  const k = Math.floor(Math.sqrt(slot))
  const i = slot - k * k
  return i < k ? { col: k, row: i } : { col: i - k, row: k }
}

/** Caixa (no chão) que envolve todas as salas; null sem salas. */
export function buildingBounds(rooms: RoomLayout[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (rooms.length === 0) return null
  return {
    minX: Math.min(...rooms.map((r) => r.x)),
    maxX: Math.max(...rooms.map((r) => r.x + r.width)),
    minZ: Math.min(...rooms.map((r) => r.z)),
    maxZ: Math.max(...rooms.map((r) => r.z + r.depth))
  }
}

export function monitorPosition(desk: Pick<DeskLayout, 'x' | 'z'>): { x: number; y: number; z: number } {
  return { x: desk.x, y: MONITOR_Y, z: desk.z - MONITOR_BACK }
}

export function layoutOffice(model: OfficeModel, prev: Office3DLayout = EMPTY_LAYOUT): Office3DLayout {
  // Slots de sala: quem já tinha fica; sala nova pega o primeiro livre.
  const roomSlots: Record<string, number> = {}
  const usedSlots = new Set<number>()
  for (const r of model.rooms) {
    const s = prev.roomSlots[r.id]
    if (s !== undefined && !usedSlots.has(s)) {
      roomSlots[r.id] = s
      usedSlots.add(s)
    }
  }
  for (const r of model.rooms) {
    if (roomSlots[r.id] !== undefined) continue
    const s = firstFree(usedSlots)
    roomSlots[r.id] = s
    usedSlots.add(s)
  }

  // Mesas: mantém a do layout anterior se o personagem continua na mesma sala.
  const seated = model.characters.filter((c) => c.placement.kind === 'seat' && c.roomId !== null && roomSlots[c.roomId] !== undefined)
  const deskOf: Record<string, { roomId: string; index: number }> = {}
  const usedDesks = new Map<string, Set<number>>()
  const used = (roomId: string): Set<number> => {
    let s = usedDesks.get(roomId)
    if (!s) usedDesks.set(roomId, (s = new Set()))
    return s
  }
  for (const c of seated) {
    const p = prev.deskOf[c.key]
    const roomId = c.roomId as string
    if (p && p.roomId === roomId && !used(roomId).has(p.index)) {
      deskOf[c.key] = p
      used(roomId).add(p.index)
    }
  }
  for (const c of seated) {
    if (deskOf[c.key]) continue
    const roomId = c.roomId as string
    const index = firstFree(used(roomId))
    deskOf[c.key] = { roomId, index }
    used(roomId).add(index)
  }

  // Grade: colunas com passo fixo (largura constante); cada linha começa
  // depois da sala mais funda da linha anterior.
  const sized = model.rooms.map((r) => {
    const taken = used(r.id)
    const highest = taken.size > 0 ? Math.max(...taken) + 1 : 0
    const count = Math.max(MIN_DESKS, seated.filter((c) => c.roomId === r.id).length, highest)
    const depth = Math.ceil(count / DESK_COLS) * DESK_PITCH_Z + ROOM_MARGIN * 2 + 1.5
    return { r, count, depth, slot: roomSlots[r.id], cell: gridCell(roomSlots[r.id]) }
  })
  const rowDepth: number[] = []
  for (const s of sized) rowDepth[s.cell.row] = Math.max(rowDepth[s.cell.row] ?? 0, s.depth)
  const rowZ: number[] = []
  for (let row = 0, z = 0; row < rowDepth.length; row++) {
    rowZ[row] = z
    z += (rowDepth[row] ?? 0) + ROOM_GAP
  }
  const rooms: RoomLayout[] = sized.map(({ r, count, depth, slot, cell }) => {
    const base = { x: cell.col * (ROOM_WIDTH + ROOM_GAP), z: rowZ[cell.row] }
    const desks: DeskLayout[] = []
    for (let i = 0; i < count; i++) desks.push({ index: i, ...deskPosition(base, i), ownerKey: null })
    return { id: r.id, name: r.name, icon: r.icon ?? null, slot, ...base, width: ROOM_WIDTH, depth, desks }
  })
  const roomById = new Map(rooms.map((r) => [r.id, r]))

  const characters: CharacterLayout[] = []
  const byKey = new Map<string, CharacterLayout>()
  const besideCount = new Map<string, number>()
  let corridor = 0
  for (const c of model.characters) {
    let out: CharacterLayout | null = null
    const room = c.roomId !== null ? roomById.get(c.roomId) : undefined
    if (c.placement.kind === 'seat' && room) {
      const d = deskOf[c.key]
      const desk = room.desks[d.index]
      desk.ownerKey = c.key
      out = { key: c.key, roomId: room.id, x: desk.x, z: desk.z + SEAT_FRONT, deskIndex: d.index, screenDesk: d, model: c }
    } else if (c.placement.kind === 'beside') {
      const parent = byKey.get(c.placement.parentKey)
      if (parent) {
        const n = (besideCount.get(parent.key) ?? 0) + 1
        besideCount.set(parent.key, n)
        const side = n % 2 === 1 ? 1 : -1
        const x = parent.x + side * BESIDE_STEP * Math.ceil(n / 2)
        out = { key: c.key, roomId: parent.roomId, x, z: parent.z + 0.2, deskIndex: null, screenDesk: parent.screenDesk, model: c }
      }
    } else if (c.placement.kind === 'destination' && room) {
      // PO na frente da sala (o "kanban" fica na parede do fundo, à esquerda).
      out = { key: c.key, roomId: room.id, x: room.x + 0.9, z: room.z + 0.9, deskIndex: null, screenDesk: null, model: c }
    } else if (c.roomId === null) {
      // Corredor: à esquerda da primeira sala.
      out = { key: c.key, roomId: null, x: -1, z: 1 + corridor * 1.1, deskIndex: null, screenDesk: null, model: c }
      corridor++
    }
    if (!out) continue
    characters.push(out)
    byKey.set(c.key, out)
  }
  return { rooms, characters, roomSlots, deskOf }
}
