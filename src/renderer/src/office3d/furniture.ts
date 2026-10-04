/**
 * Onde fica cada móvel do escritório — PURO (sem three). Tira as posições de
 * officePlan.ts e monta o que o resto usa: os pontos de interesse (POIs), os
 * obstáculos da grade de navegação (nav.ts), a porta, o kanban e a TV. decor*.ts
 * desenha a partir de officePlan.ts e nav/crowd leem daqui: mudar um móvel de
 * lugar muda os dois juntos.
 *
 * Eixos como em layout.ts (X à direita, Z para a câmera). Yaw de quem está em
 * pé: 0 olha para −Z (parede do fundo), π para a câmera, −π/2 para +X e π/2
 * para −X — o mesmo `rotation.y` do personagem.
 *
 * A porta fica na parede da direita, no corredor cruzado; o café, na mesma
 * parede, de frente para dentro (a fila cresce para −X no corredor do fundo); a
 * estante de Memórias tem 3 lugares de pé; o cochilo é no sofá/poltrona do
 * lounge; o kanban fica no centro da parede do fundo (medidas em
 * board/boardLayout.ts), com um lugar diante de cada coluna, o bloquinho na
 * canaleta e o cesto no chão; olhar lá fora é pela parede de vidro.
 */
import { BIN_SPOT, BOARD_CX, BOARD_CY, BOARD_X0, BOARD_X1, BOARD_Y0, BOARD_Y1, COLUMN_SPOT_Z, columnX, PAD_SPOT } from './board/boardLayout'
import {
  BACK_FACE_Z,
  BOARD_X,
  COFFEE,
  CONSOLE,
  DESK_D,
  DESK_W,
  DOOR,
  ENERGY_PANEL,
  FLOOR_PLANTS,
  GLASS_PLANTER,
  GLASS_X,
  ISLAND_SHELF_Z,
  ISLANDS,
  LOUNGE,
  LOUNGE_SEATS,
  MEETING,
  MEMORY_SHELF,
  MEMORY_SPOT_X,
  MEMORY_SPOTS_Z,
  OFFICE,
  RIGHT_FACE_X,
  RIGHT_WALL_Z1,
  SEAT_FRONT,
  STATIONS,
  WINDOW_SPOT_X,
  WINDOW_SPOTS_Z,
  type Rect
} from './officePlan'

export type { Rect } from './officePlan'

export interface Spot {
  x: number
  z: number
  yaw: number
}

export type PoiKind = 'coffee' | 'shelf' | 'window' | 'plant' | 'postit' | 'sofa' | 'queue' | 'chat' | 'board'

/** Ponto de interesse: onde ficar em pé (e para onde olhar) ao usar algo. */
export interface Poi extends Spot {
  /** `${roomId}|${kind}|${index}` — chave da reserva. */
  id: string
  roomId: string
  kind: PoiKind
  index: number
  look: { x: number; y: number; z: number }
}

/** O kanban na parede (mundo): centro, extensão, bloquinho e cesto. */
export interface BoardPlace {
  x: number
  y: number
  z: number
  x0: number
  x1: number
  y0: number
  y1: number
  pad: { x: number; y: number; z: number }
  bin: { x: number; z: number }
}

export interface RoomFurniture {
  roomId: string
  /** Pontos da parede de vidro por onde entra o luar (x da parede, z). */
  windows: Array<{ x: number; z: number }>
  board: BoardPlace
  /** Centro do balcão do café; o grupo gira −π/2 (a máquina olha para −X). */
  coffee: { x: number; z: number }
  /** A pista da festa: um retângulo de chão livre na praça. */
  rug: { x: number; z: number; w: number; d: number }
  /** Vão da porta na parede da direita (x da parede, centro em z, largura). */
  door: { x: number; z: number; width: number }
  /** A TV da sala de reunião (centro da tela, na frente da parede do fundo). */
  tv: { x: number; y: number; z: number; w: number; h: number }
  /** Logo depois da porta (dentro) e um pouco antes dela (do lado de fora). */
  doorIn: Spot
  doorOut: Spot
  pois: Poi[]
  /** Pisos ocupados (sem a folga do raio do agente). */
  obstacles: Rect[]
}

export const DOOR_WIDTH = DOOR.width
export const DOOR_HEIGHT = DOOR.height
/** Do centro da cadeira até onde a pessoa fica em pé, ao lado dela. */
export const CHAIR_SIDE = 0.62
/** …e quanto atrás do centro do assento (o tampo vai até 0,25 m da cadeira). */
export const CHAIR_BACK = 0.15
/** Passo entre quem espera na fila do café. */
export const QUEUE_STEP = 0.65
export const QUEUE_LEN = 4
/** A máquina fica deslocada do centro do balcão (em direção ao fundo do escritório). */
export const MACHINE_OFFSET = 0.15
/** Meia largura da cadeira da estação (obstáculo). */
const CHAIR_HALF = 0.26

const FACE_BACK = 0
const FACE_CAMERA = Math.PI
const FACE_RIGHT = -Math.PI / 2
const FACE_LEFT = Math.PI / 2

const rect = (cx: number, cz: number, hw: number, hd: number): Rect => ({ x0: cx - hw, z0: cz - hd, x1: cx + hw, z1: cz + hd })

type DeskSpot = { x: number; z: number; dir?: 1 | -1; out?: 1 | -1 }

/** Lugar da cadeira da mesa (onde o quadril fica sentado), olhando para o monitor. */
export function seatOf(desk: DeskSpot): Spot {
  const dir = desk.dir ?? 1
  return { x: desk.x, z: desk.z + dir * SEAT_FRONT, yaw: dir === 1 ? FACE_BACK : FACE_CAMERA }
}

/** Em pé ao lado da cadeira (um pouco atrás do assento, longe do tampo): no lado de fora da ilha (ou em `side`). */
export function chairSide(desk: DeskSpot, side: 1 | -1 = desk.out ?? 1): Spot {
  const s = seatOf(desk)
  return { x: desk.x + side * CHAIR_SIDE, z: s.z + (desk.dir ?? 1) * CHAIR_BACK, yaw: s.yaw }
}

/** O kanban na parede do fundo (as medidas são de board/boardLayout.ts, centradas em BOARD_X). */
export function boardPlace(): BoardPlace {
  const z = BACK_FACE_Z - 0.06
  const dx = BOARD_X - BOARD_CX
  return {
    x: BOARD_X,
    y: BOARD_CY,
    z,
    x0: dx + BOARD_X0,
    x1: dx + BOARD_X1,
    y0: BOARD_Y0,
    y1: BOARD_Y1,
    pad: { x: dx + PAD_SPOT.x, y: PAD_SPOT.y, z: z + PAD_SPOT.z },
    bin: { x: dx + BIN_SPOT.x, z: z + BIN_SPOT.z }
  }
}

/** Mobília, POIs e obstáculos do escritório (a sala física `roomId`). */
export function roomFurniture(r: { id: string }): RoomFurniture {
  const id = r.id
  const board = boardPlace()
  const tvZ = BACK_FACE_Z + 0.115
  const pois: Poi[] = []
  const poi = (kind: PoiKind, index: number, s: Spot, lx: number, ly: number, lz: number): void => {
    pois.push({ id: `${id}|${kind}|${index}`, roomId: id, kind, index, ...s, look: { x: lx, y: ly, z: lz } })
  }
  // Café: a máquina fica MACHINE_OFFSET para o fundo do centro do balcão (decorWall.ts); a fila vai para −X.
  const machine = { x: COFFEE.x - 0.1, z: COFFEE.z - MACHINE_OFFSET }
  const machineX = COFFEE.x - 0.7
  poi('coffee', 0, { x: machineX, z: machine.z, yaw: FACE_RIGHT }, machine.x, 1.05, machine.z)
  for (let i = 1; i < QUEUE_LEN; i++) poi('queue', i, { x: machineX - i * QUEUE_STEP, z: machine.z, yaw: FACE_RIGHT }, machine.x, 1.05, machine.z)
  // Estante de Memórias: 3 lugares de pé, olhando para a parede da direita.
  MEMORY_SPOTS_Z.forEach((z, i) => poi('shelf', i, { x: MEMORY_SPOT_X, z, yaw: FACE_RIGHT }, MEMORY_SHELF.x, 0.7, z))
  // Parede de vidro.
  WINDOW_SPOTS_Z.forEach((z, i) => poi('window', i, { x: WINDOW_SPOT_X, z, yaw: FACE_LEFT }, GLASS_X, 1.4, z))
  // Regar: a planta grande da frente e as dos cantos (de lado para elas).
  const [front, left, right] = FLOOR_PLANTS
  poi('plant', 0, { x: front.x + 0.75, z: front.z, yaw: FACE_LEFT }, front.x, 0.55, front.z)
  poi('plant', 1, { x: left.x + 0.7, z: left.z, yaw: FACE_LEFT }, left.x, 0.5, left.z)
  poi('plant', 2, { x: right.x - 0.7, z: right.z, yaw: FACE_RIGHT }, right.x, 0.5, right.z)
  // Ler o quadro inteiro (um passo atrás dos lugares das colunas) e um lugar diante de cada coluna.
  poi('postit', 0, { x: board.x, z: board.z + 1.3, yaw: FACE_BACK }, board.x, board.y, board.z)
  for (let c = 0; c < 3; c++) poi('board', c, { x: board.x + columnX(c), z: board.z + COLUMN_SPOT_Z, yaw: FACE_BACK }, board.x + columnX(c), board.y, board.z)
  // Cochilo: os lugares do lounge (o POI é onde ficar em pé; `look` é o assento).
  LOUNGE_SEATS.forEach((s, i) => poi('sofa', i, { x: s.standX, z: s.standZ, yaw: s.yaw }, s.x, 0.3, s.z))
  // Pares de conversa, um de frente para o outro: praça (atrás e na frente do console), corredor do fundo e lounge.
  const pairs: Array<[number, number]> = [
    [0, CONSOLE.z - 2.1],
    [0, CONSOLE.z + 2.1],
    [0, -2.4],
    [-5.45, -3.4]
  ]
  pairs.forEach(([x, z], i) => {
    poi('chat', i * 2, { x: x - 0.45, z, yaw: FACE_RIGHT }, x + 0.45, 1.25, z)
    poi('chat', i * 2 + 1, { x: x + 0.45, z, yaw: FACE_LEFT }, x - 0.45, 1.25, z)
  })

  return {
    roomId: id,
    windows: WINDOW_SPOTS_Z.map((z) => ({ x: GLASS_X, z })),
    board,
    coffee: { x: COFFEE.x, z: COFFEE.z },
    rug: { x: 0, z: CONSOLE.z + 2.95, w: 3.0, d: 1.6 },
    door: { x: DOOR.x, z: DOOR.z, width: DOOR.width },
    tv: { x: MEETING.tv.x, y: MEETING.tv.y, z: tvZ, w: MEETING.tv.w, h: MEETING.tv.h },
    doorIn: { x: RIGHT_FACE_X - 0.65, z: DOOR.z, yaw: FACE_LEFT },
    doorOut: { x: OFFICE.x1 + 1.0, z: DOOR.z, yaw: FACE_LEFT },
    pois,
    obstacles: officeObstacles(board)
  }
}

/** Tudo o que ocupa o piso: estações, ilhas, lounge, sala de reunião, parede da direita, plantas e paredes. */
function officeObstacles(board: BoardPlace): Rect[] {
  const o: Rect[] = []
  for (const s of STATIONS) {
    o.push(rect(s.x, s.z, DESK_W / 2, DESK_D / 2))
    o.push(rect(s.x, s.z + s.dir * (SEAT_FRONT + 0.08), CHAIR_HALF, CHAIR_HALF))
  }
  for (const isl of ISLANDS) o.push(rect(isl.x, isl.z + ISLAND_SHELF_Z, 0.31, 0.15))
  // Praça: o console e o cesto do kanban.
  o.push(rect(CONSOLE.x, CONSOLE.z, CONSOLE.r, CONSOLE.r))
  o.push(rect(board.bin.x, board.bin.z, BIN_SPOT.r + 0.02, BIN_SPOT.r + 0.02))
  // Lounge.
  const L = LOUNGE
  o.push(rect(L.sideboard.x, L.sideboard.z, L.sideboard.w / 2, L.sideboard.d / 2))
  o.push(rect(L.sofa.x, L.sofa.z, L.sofa.w / 2, L.sofa.d / 2))
  o.push(rect(L.table.x, L.table.z, L.table.r, L.table.r))
  o.push(rect(L.armchair.x, L.armchair.z, 0.32, 0.32))
  o.push(rect(L.lamp.x, L.lamp.z, 0.16, 0.16))
  // Sala de reunião: vidro da frente (com o vão da porta), vidro da esquerda, a mesa e as 8 cadeiras.
  const M = MEETING
  o.push({ x0: M.x0, z0: M.z1 - 0.03, x1: M.door.x0, z1: M.z1 + 0.03 })
  o.push({ x0: M.door.x1, z0: M.z1 - 0.03, x1: M.x1, z1: M.z1 + 0.03 })
  o.push({ x0: M.x0 - 0.03, z0: M.z0, x1: M.x0 + 0.03, z1: M.z1 })
  o.push(rect(M.table.x, M.table.z, M.table.w / 2, M.table.d / 2))
  for (const s of meetingChairs()) o.push(rect(s.x, s.z, CHAIR_HALF, CHAIR_HALF))
  // Parede da direita: café, Memórias e o quadro de energia.
  o.push({ x0: COFFEE.x - 0.27, z0: COFFEE.z - 0.47, x1: OFFICE.x1, z1: COFFEE.z + 0.47 })
  o.push({ x0: MEMORY_SHELF.x - MEMORY_SHELF.d / 2, z0: MEMORY_SHELF.z - MEMORY_SHELF.w / 2, x1: OFFICE.x1, z1: MEMORY_SHELF.z + MEMORY_SHELF.w / 2 })
  o.push({ x0: ENERGY_PANEL.x - ENERGY_PANEL.d / 2, z0: ENERGY_PANEL.z - ENERGY_PANEL.w / 2, x1: OFFICE.x1, z1: ENERGY_PANEL.z + ENERGY_PANEL.w / 2 })
  // Floreira junto do vidro e as plantas do chão.
  o.push(rect(GLASS_PLANTER.x, GLASS_PLANTER.z, GLASS_PLANTER.d / 2, GLASS_PLANTER.len / 2))
  for (const p of FLOOR_PLANTS) o.push(rect(p.x, p.z, 0.2 * p.scale, 0.2 * p.scale))
  // Paredes: fundo, vidro (esquerda) e a da direita com o vão da porta.
  o.push({ x0: OFFICE.x0, z0: OFFICE.z0, x1: OFFICE.x1, z1: BACK_FACE_Z + 0.02 })
  o.push({ x0: OFFICE.x0, z0: OFFICE.z0, x1: GLASS_X + 0.06, z1: OFFICE.z1 })
  o.push({ x0: RIGHT_FACE_X - 0.02, z0: OFFICE.z0, x1: OFFICE.x1, z1: DOOR.z - DOOR.width / 2 })
  o.push({ x0: RIGHT_FACE_X - 0.02, z0: DOOR.z + DOOR.width / 2, x1: OFFICE.x1, z1: RIGHT_WALL_Z1 })
  return o
}

/** As 8 cadeiras da mesa de reunião: 3 em cada lado comprido e uma em cada cabeceira (de frente para a mesa). */
export function meetingChairs(): Spot[] {
  const { x, z, d } = MEETING.table
  const out: Spot[] = []
  for (const dx of [-0.95, 0, 0.95]) {
    out.push({ x: x + dx, z: z - d / 2 - 0.36, yaw: FACE_CAMERA })
    out.push({ x: x + dx, z: z + d / 2 + 0.36, yaw: FACE_BACK })
  }
  out.push({ x: x - MEETING.table.w / 2 - 0.4, z, yaw: FACE_RIGHT })
  out.push({ x: x + MEETING.table.w / 2 + 0.4, z, yaw: FACE_LEFT })
  return out
}
