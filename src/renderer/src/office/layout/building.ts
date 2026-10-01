/**
 * Gera o prédio inteiro: uma sala por projeto, lado a lado numa fileira, e um
 * corredor horizontal embaixo de todas, com a entrada, a copa e o arquivo de
 * memórias. Função pura e determinística: mesma entrada → mesmo layout.
 *
 * Por que fileira (e não salas alternando acima/abaixo do corredor): todas as
 * salas ficam na mesma orientação do protótipo aprovado — kanban na parede de
 * cima, porta embaixo dando no corredor — e a posição horizontal de cada sala
 * só depende da vaga dela, nunca da altura das outras.
 */

import { TileType } from '../engine/types'
import type { Destination, OfficeLayout, PlacedFurniture, RoomDef, SeatDef } from '../engine/types'
import { EMPTY_SLOT, stableRoomOrder } from './roomOrder'
import { ROOM_W, buildRoomContent, deskRowCount, roomHeight } from './roomTemplate'

export interface BuildingRoomInput {
  id: string
  projectKey: string
  name: string
  /** Conversas principais do projeto; abaixo de 8 a sala continua com 8 mesas. */
  principals: number
}

export interface BuildingInput {
  rooms: BuildingRoomInput[]
  /**
   * Vagas da fileira (saída de stableRoomOrder; '' = vaga vazia). Sem isto,
   * vale a ordem de `rooms`. Sala fora de `order` entra no fim.
   */
  order?: string[]
}

/** Interior do corredor: 3 linhas — larga o bastante para os móveis do fundo sem fechar a passagem. */
const CORRIDOR_ROWS = 3
const ENTRANCE_COL = 3
const COPA = { col: 8, w: 3 }
const ARQUIVO = { col: 15, w: 2 }

/** Valida na fronteira: o input vem do app (lista de projetos), não do motor. */
function sanitize(rooms: BuildingRoomInput[]): BuildingRoomInput[] {
  const seen = new Set<string>()
  const out: BuildingRoomInput[] = []
  for (const r of rooms) {
    if (typeof r.id !== 'string' || r.id === EMPTY_SLOT) throw new Error('Sala sem id no gerador do escritório')
    if (seen.has(r.id)) throw new Error(`Sala duplicada no gerador do escritório: ${r.id}`)
    seen.add(r.id)
    const principals = Number.isFinite(r.principals) ? Math.max(0, Math.floor(r.principals)) : 0
    out.push({ ...r, principals })
  }
  return out
}

function floorTile(col: number, row: number): TileType {
  // Xadrez do protótipo: tom alternado por tile.
  return (col + row) % 2 === 0 ? TileType.FLOOR : TileType.FLOOR_ALT
}

function paintRect(tiles: TileType[], cols: number, c0: number, r0: number, w: number, h: number): void {
  for (let r = r0; r < r0 + h; r++) {
    for (let c = c0; c < c0 + w; c++) {
      const edge = r === r0 || r === r0 + h - 1 || c === c0 || c === c0 + w - 1
      // Parede dividida entre vizinhos: não pinta parede por cima de piso já pintado.
      const cur = tiles[r * cols + c]
      if (edge) {
        if (cur === TileType.VOID) tiles[r * cols + c] = TileType.WALL
      } else {
        tiles[r * cols + c] = floorTile(c, r)
      }
    }
  }
}

export function buildBuilding(input: BuildingInput): OfficeLayout {
  const rooms = sanitize(input.rooms)
  const byId = new Map(rooms.map((r) => [r.id, r]))
  const slots = stableRoomOrder(input.order ?? [], rooms.map((r) => r.id))

  // Salas vizinhas dividem a parede: a vaga i começa na coluna i*(W-1).
  const slotCount = Math.max(1, slots.length)
  const cols = slotCount * (ROOM_W - 1) + 1
  const heights = slots.map((id) => (byId.has(id) ? roomHeight(deskRowCount(byId.get(id)!.principals)) : 0))
  // Todas as salas encostam a parede de baixo na linha corridorTop - 1.
  // Mínimo 1: sem sala nenhuma ainda há a parede de cima do corredor.
  const corridorTop = Math.max(1, ...heights)
  const rowsTotal = corridorTop + CORRIDOR_ROWS + 1
  const tiles: TileType[] = new Array<TileType>(cols * rowsTotal).fill(TileType.VOID)

  const furniture: PlacedFurniture[] = []
  const seats: SeatDef[] = []
  const destinations: Destination[] = []
  const roomDefs: RoomDef[] = []

  // Corredor: parede só nas pontas e embaixo; em cima são as paredes das salas.
  // Linha corridorTop - 1 nas vagas vazias vira parede para fechar o corredor.
  paintRect(tiles, cols, 0, corridorTop - 1, cols, CORRIDOR_ROWS + 2)

  for (const [i, id] of slots.entries()) {
    const room = byId.get(id)
    if (!room) continue
    const h = heights[i]
    const ox = i * (ROOM_W - 1)
    const oy = corridorTop - h
    paintRect(tiles, cols, ox, oy, ROOM_W, h)
    const content = buildRoomContent(room.id, room.principals, ox, oy)
    // A parede de baixo da sala é a de cima do corredor: a porta vira piso.
    tiles[content.door.row * cols + content.door.col] = floorTile(content.door.col, content.door.row)
    furniture.push(...content.furniture)
    seats.push(...content.seats)
    destinations.push(...content.destinations)
    roomDefs.push({
      id: room.id,
      projectKey: room.projectKey,
      name: room.name,
      col: ox,
      row: oy,
      w: ROOM_W,
      h,
      doorCol: content.door.col,
      doorRow: content.door.row
    })
  }

  // Área comum, no começo do corredor (fica parada quando salas entram no fim).
  const bottomWall = corridorTop + CORRIDOR_ROWS
  const backRow = bottomWall - 1
  const common = (p: Omit<PlacedFurniture, 'roomId'>, dest: { col: number; row: number }): void => {
    furniture.push({ ...p, roomId: null })
    destinations.push({ papel: p.papel!, roomId: null, ...dest })
  }
  // Entrada: abertura na parede de baixo; o destino é o tile logo dentro.
  tiles[bottomWall * cols + ENTRANCE_COL] = floorTile(ENTRANCE_COL, bottomWall)
  common(
    { uid: 'corredor:entrada', kind: 'entrada', col: ENTRANCE_COL, row: bottomWall, w: 1, h: 1, blocks: false, papel: 'entrada' },
    { col: ENTRANCE_COL, row: backRow }
  )
  // Copa e arquivo encostados na parede de baixo; ficam 2 linhas livres para passar.
  common(
    { uid: 'corredor:copa', kind: 'copa', col: COPA.col, row: backRow, w: COPA.w, h: 1, blocks: true, papel: 'copa' },
    { col: COPA.col + 1, row: backRow - 1 }
  )
  common(
    { uid: 'corredor:arquivo-memorias', kind: 'arquivo-memorias', col: ARQUIVO.col, row: backRow, w: ARQUIVO.w, h: 1, blocks: true, papel: 'arquivo-memorias' },
    { col: ARQUIVO.col, row: backRow - 1 }
  )

  return { cols, rows: rowsTotal, tiles, furniture, seats, rooms: roomDefs, destinations }
}
