// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { TILE_SIZE } from './constants'
import type { SeatRequest } from './seatPlacement'
import { findPath, getWalkableTiles, isWalkable, tileKey } from './tileMap'
import { CharacterState } from './types'
import type { Character, OfficeLayout, RoomDef, Seat, TilePos, TileType } from './types'

/**
 * O estado que as funções de agents/subagents/bubbles manipulam. A classe
 * OfficeState implementa isto; as funções recebem a interface para não
 * dependerem da classe (e a classe não passar de 500 linhas).
 */
export interface OfficeWorld {
  layout: OfficeLayout
  tileMap: TileType[][]
  seats: Map<string, Seat>
  blockedTiles: Set<string>
  walkableTiles: TilePos[]
  /** Tiles andáveis por sala (chave null = fora de qualquer sala). Limita o perambular. */
  walkableByRoom: Map<string | null, TilePos[]>
  characters: Map<number, Character>
  /** O que cada agente pediu em addAgent — para pedir de novo se o layout mudar. */
  seatRequests: Map<number, SeatRequest>
  subagents: SubagentRegistry
  selectedAgentId: number | null
  hoveredAgentId: number | null
  cameraFollowId: number | null
}

export interface SubagentRegistry {
  /** "paiId:toolId" → id (negativo) do subagente. */
  idByKey: Map<string, number>
  /** id do subagente → de quem ele é. */
  meta: Map<number, { parentAgentId: number; toolId: string }>
  /** Próximo id a dar; só decresce, então um id nunca é reaproveitado. */
  nextId: number
}

export function createSubagentRegistry(): SubagentRegistry {
  return { idByKey: new Map(), meta: new Map(), nextId: -1 }
}

/** Tira o personagem do mapa e de toda referência que o painel ainda segure. */
export function forgetCharacter(world: OfficeWorld, id: number): void {
  world.characters.delete(id)
  world.seatRequests.delete(id)
  // Subagente removido por qualquer caminho (removeAgent, layout): o registro
  // não pode continuar devolvendo um id sem personagem.
  const meta = world.subagents.meta.get(id)
  if (meta) {
    world.subagents.meta.delete(id)
    world.subagents.idByKey.delete(`${meta.parentAgentId}:${meta.toolId}`)
  }
  if (world.selectedAgentId === id) world.selectedAgentId = null
  if (world.hoveredAgentId === id) world.hoveredAgentId = null
  if (world.cameraFollowId === id) world.cameraFollowId = null
}

/**
 * O layout vem de fora do motor (arquivo salvo, gerador de salas): confere as
 * dimensões antes de indexar, porque um `tiles` curto vira `undefined` no meio
 * do mapa e só aparece como personagem atravessando parede.
 */
export function validateLayout(layout: OfficeLayout): void {
  const { cols, rows } = layout
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`Layout do escritório inválido: dimensões ${cols}×${rows}`)
  }
  if (!Array.isArray(layout.tiles) || layout.tiles.length !== cols * rows) {
    throw new Error(`Layout do escritório inválido: esperava ${cols * rows} tiles, veio ${layout.tiles?.length}`)
  }
  for (const key of ['furniture', 'seats', 'rooms', 'destinations'] as const) {
    if (!Array.isArray(layout[key])) throw new Error(`Layout do escritório inválido: "${key}" não é lista`)
  }
}

export function buildTileMap(layout: OfficeLayout): TileType[][] {
  const map: TileType[][] = []
  for (let r = 0; r < layout.rows; r++) {
    map.push(layout.tiles.slice(r * layout.cols, (r + 1) * layout.cols))
  }
  return map
}

/** Assentos do layout, todos livres; quem tem dono é reatribuído por quem chama. */
export function buildSeats(layout: OfficeLayout): Map<string, Seat> {
  const seats = new Map<string, Seat>()
  for (const s of layout.seats) seats.set(s.uid, { ...s, assigned: false })
  return seats
}

/**
 * Bloqueados = footprint dos móveis com blocks=true + os tiles de assento. O
 * assento bloqueia os outros (ninguém perambula por cima de uma cadeira) e o
 * dono o desbloqueia só para si (withOwnSeatUnblocked), como no original.
 */
export function getBlockedTiles(layout: OfficeLayout): Set<string> {
  const tiles = new Set<string>()
  for (const f of layout.furniture) {
    if (!f.blocks) continue
    for (let dr = 0; dr < f.h; dr++) {
      for (let dc = 0; dc < f.w; dc++) tiles.add(tileKey(f.col + dc, f.row + dr))
    }
  }
  for (const s of layout.seats) tiles.add(tileKey(s.col, s.row))
  return tiles
}

export function roomAt(rooms: RoomDef[], col: number, row: number): RoomDef | null {
  for (const r of rooms) {
    if (col >= r.col && col < r.col + r.w && row >= r.row && row < r.row + r.h) return r
  }
  return null
}

export function groupWalkableByRoom(walkable: TilePos[], rooms: RoomDef[]): Map<string | null, TilePos[]> {
  const out = new Map<string | null, TilePos[]>()
  for (const t of walkable) {
    const id = roomAt(rooms, t.col, t.row)?.id ?? null
    const list = out.get(id)
    if (list) list.push(t)
    else out.set(id, [t])
  }
  return out
}

/** Recalcula tudo o que deriva do layout (não mexe em personagens). */
export function deriveWorld(
  layout: OfficeLayout
): Pick<OfficeWorld, 'tileMap' | 'seats' | 'blockedTiles' | 'walkableTiles' | 'walkableByRoom'> {
  validateLayout(layout)
  const tileMap = buildTileMap(layout)
  const blockedTiles = getBlockedTiles(layout)
  const walkableTiles = getWalkableTiles(tileMap, blockedTiles)
  return {
    tileMap,
    seats: buildSeats(layout),
    blockedTiles,
    walkableTiles,
    walkableByRoom: groupWalkableByRoom(walkableTiles, layout.rooms)
  }
}

export function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 }
}

/** Teleporta para o centro de um tile e esquece o caminho. */
export function placeAt(ch: Character, col: number, row: number): void {
  const c = tileCenter(col, row)
  ch.tileCol = col
  ch.tileRow = row
  ch.x = c.x
  ch.y = c.y
  ch.path = []
  ch.moveProgress = 0
}

export function findRoom(world: OfficeWorld, roomId: string | null): RoomDef | undefined {
  return roomId === null ? undefined : world.layout.rooms.find((r) => r.id === roomId)
}

/** Onde o personagem pode perambular: os tiles andáveis da própria sala. */
export function roomTiles(world: OfficeWorld, roomId: string | null): TilePos[] {
  return world.walkableByRoom.get(roomId) ?? []
}

function ownSeatKey(world: OfficeWorld, ch: Character): string | null {
  if (!ch.seatId) return null
  const seat = world.seats.get(ch.seatId)
  return seat ? tileKey(seat.col, seat.row) : null
}

/** Desbloqueia o assento do próprio personagem durante fn (para ele poder chegar lá). */
export function withOwnSeatUnblocked<T>(world: OfficeWorld, ch: Character, fn: () => T): T {
  const key = ownSeatKey(world, ch)
  // Só re-bloqueia o que estava bloqueado: um assento fora de blockedTiles
  // (layout trocado no meio) não deve virar bloqueio fantasma.
  const wasBlocked = key !== null && world.blockedTiles.delete(key)
  try {
    return fn()
  } finally {
    if (wasBlocked && key) world.blockedTiles.add(key)
  }
}

export function startWalk(ch: Character, path: TilePos[]): void {
  ch.path = path
  ch.moveProgress = 0
  ch.state = CharacterState.WALK
  ch.frame = 0
  ch.frameTimer = 0
}

/**
 * Caminho até (col,row) ou, se aquele tile não dá para pisar (quadro na parede,
 * impressora que bloqueia, porta fechada por móvel), até o vizinho mais perto
 * dele. [] = já está lá; null = inalcançável.
 */
export function pathToward(world: OfficeWorld, ch: Character, col: number, row: number): TilePos[] | null {
  return withOwnSeatUnblocked(world, ch, () => {
    const targets = [
      { col, row },
      { col, row: row + 1 },
      { col, row: row - 1 },
      { col: col - 1, row },
      { col: col + 1, row }
    ]
    let best: TilePos[] | null = null
    for (const [i, t] of targets.entries()) {
      if (ch.tileCol === t.col && ch.tileRow === t.row) return []
      if (!isWalkable(t.col, t.row, world.tileMap, world.blockedTiles)) continue
      const p = findPath(ch.tileCol, ch.tileRow, t.col, t.row, world.tileMap, world.blockedTiles)
      if (p.length === 0) continue
      // O tile exato ganha sempre que existe caminho; vizinhos só disputam entre si.
      if (i === 0) return p
      if (!best || p.length < best.length) best = p
    }
    return best
  })
}

/** Tile da lista mais perto (Manhattan) de (col,row) sem ninguém em cima. */
export function closestFreeTile(world: OfficeWorld, tiles: TilePos[], col: number, row: number): TilePos | null {
  const occupied = new Set<string>()
  for (const ch of world.characters.values()) occupied.add(tileKey(ch.tileCol, ch.tileRow))
  let best: TilePos | null = null
  let bestDist = Infinity
  for (const t of tiles) {
    if (occupied.has(tileKey(t.col, t.row))) continue
    const d = Math.abs(t.col - col) + Math.abs(t.row - row)
    if (d < bestDist) {
      best = t
      bestDist = d
    }
  }
  return best
}
