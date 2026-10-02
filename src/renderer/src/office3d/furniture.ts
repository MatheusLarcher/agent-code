/**
 * Onde fica cada móvel de uma sala — PURO (sem three). decor.ts desenha a
 * partir daqui e nav.ts bloqueia a grade e marca os pontos de interesse (POIs)
 * a partir daqui: mudar um móvel de lugar muda os dois juntos.
 *
 * Eixos como em layout.ts (X à direita, Z para a câmera). Yaw de quem está em
 * pé: 0 olha para -Z (parede do fundo), π para a câmera, -π/2 para +X e π/2
 * para -X — o mesmo `rotation.y` do personagem.
 *
 * A porta fica na parede da esquerda, perto da frente; o pufe do cochilo, na
 * ponta esquerda do tapete; a máquina de café, na parede da direita, de frente
 * para dentro da sala (a fila cresce para a esquerda dela).
 */
import { SEAT_FRONT, type DeskLayout, type RoomLayout } from './layout'

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface Spot {
  x: number
  z: number
  yaw: number
}

export type PoiKind = 'coffee' | 'shelf' | 'window' | 'plant' | 'postit' | 'pufe' | 'queue' | 'chat'

/** Ponto de interesse: onde ficar em pé (e para onde olhar) ao usar algo. */
export interface Poi extends Spot {
  /** `${roomId}|${kind}|${index}` — chave da reserva. */
  id: string
  roomId: string
  kind: PoiKind
  index: number
  look: { x: number; y: number; z: number }
}

export interface RoomFurniture {
  roomId: string
  windows: Array<{ x: number; z: number }>
  board: { x: number; z: number }
  shelf: { x: number; z: number }
  plants: Array<{ x: number; z: number; scale: number }>
  lamps: Array<{ x: number; z: number }>
  /** Centro do balcão; o grupo gira -π/2 (a máquina olha para -X). */
  coffee: { x: number; z: number }
  rug: { x: number; z: number; w: number; d: number }
  pufe: { x: number; z: number }
  /** Vão da porta na parede da esquerda (x da parede, centro em z, largura). */
  door: { x: number; z: number; width: number }
  /** Logo depois da porta (dentro) e um pouco antes dela (no corredor). */
  doorIn: Spot
  doorOut: Spot
  pois: Poi[]
  /** Pisos ocupados (sem a folga do raio do agente). */
  obstacles: Rect[]
}

export const DOOR_WIDTH = 1
export const DOOR_HEIGHT = 1.9
export const PUFE_RADIUS = 0.38
/** Do centro da cadeira até onde a pessoa fica em pé, ao lado dela. */
export const CHAIR_SIDE = 0.62
/** Passo entre quem espera na fila do café. */
export const QUEUE_STEP = 0.65
export const QUEUE_LEN = 4
/** A máquina fica deslocada do centro do balcão (em direção ao fundo da sala). */
export const MACHINE_OFFSET = 0.15

const FACE_BACK = 0
const FACE_CAMERA = Math.PI
const FACE_RIGHT = -Math.PI / 2
const FACE_LEFT = Math.PI / 2

const rect = (cx: number, cz: number, hw: number, hd: number): Rect => ({ x0: cx - hw, z0: cz - hd, x1: cx + hw, z1: cz + hd })

/** Lugar da cadeira da mesa (onde o quadril fica sentado), olhando para o monitor. */
export function seatOf(desk: Pick<DeskLayout, 'x' | 'z'>): Spot {
  return { x: desk.x, z: desk.z + SEAT_FRONT, yaw: FACE_BACK }
}

/** Em pé ao lado da cadeira (lado +1 à direita, -1 à esquerda). */
export function chairSide(desk: Pick<DeskLayout, 'x' | 'z'>, side: 1 | -1): Spot {
  return { x: desk.x + side * CHAIR_SIDE, z: desk.z + SEAT_FRONT, yaw: FACE_BACK }
}

export function roomFurniture(r: RoomLayout): RoomFurniture {
  const { x, z, width: w, depth: d, id } = r
  const cx = x + w / 2
  const windows = [
    { x: cx - 3.6, z },
    { x: cx + 3.6, z }
  ]
  const board = { x: x + 1.25, z }
  const shelf = { x: x + w - 1.1, z }
  const plants = [
    { x: x + 0.55, z: z + d - 0.55, scale: 1.1 },
    { x: x + w - 2.15, z: z + 0.45, scale: 0.9 }
  ]
  const lamps = [
    { x: x + 0.45, z: z + d * 0.5 },
    { x: x + w - 0.45, z: z + d * 0.5 }
  ]
  const coffee = { x: x + w - 0.34, z: z + d - 1.3 }
  const rug = { x: cx, z: z + d - 1.4, w: 4.2, d: 2.1 }
  const pufe = { x: cx - 1.6, z: z + d - 1.5 }
  const door = { x, z: z + d - 2.6, width: DOOR_WIDTH }

  const pois: Poi[] = []
  const poi = (kind: PoiKind, index: number, s: Spot, lx: number, ly: number, lz: number): void => {
    pois.push({ id: `${id}|${kind}|${index}`, roomId: id, kind, index, ...s, look: { x: lx, y: ly, z: lz } })
  }
  // A máquina fica 0,15 m para o fundo do centro do balcão (ver coffeeStation em decor.ts).
  const machine = { x: coffee.x - 0.1, z: coffee.z - MACHINE_OFFSET }
  const machineX = coffee.x - 0.7
  poi('coffee', 0, { x: machineX, z: machine.z, yaw: FACE_RIGHT }, machine.x, 1.05, machine.z)
  for (let i = 1; i < QUEUE_LEN; i++) poi('queue', i, { x: machineX - i * QUEUE_STEP, z: machine.z, yaw: FACE_RIGHT }, machine.x, 1.05, machine.z)
  poi('shelf', 0, { x: shelf.x, z: z + 0.95, yaw: FACE_BACK }, shelf.x, 1, z + 0.3)
  windows.forEach((win, i) => poi('window', i, { x: win.x, z: z + 0.8, yaw: FACE_BACK }, win.x, 1.3, z))
  poi('plant', 0, { x: plants[0].x + 0.65, z: plants[0].z, yaw: FACE_LEFT }, plants[0].x, 0.55, plants[0].z)
  poi('plant', 1, { x: plants[1].x, z: plants[1].z + 0.65, yaw: FACE_BACK }, plants[1].x, 0.45, plants[1].z)
  poi('postit', 0, { x: board.x + 0.35, z: z + 0.8, yaw: FACE_BACK }, board.x + 0.35, 1.15, z)
  poi('pufe', 0, { x: pufe.x, z: z + d - 0.82, yaw: FACE_CAMERA }, pufe.x, 0.3, pufe.z)
  // Pares de conversa: um de frente para o outro (no tapete e no corredor do fundo).
  poi('chat', 0, { x: cx - 0.2, z: z + d - 1.35, yaw: FACE_RIGHT }, cx + 0.8, 1.25, z + d - 1.35)
  poi('chat', 1, { x: cx + 0.8, z: z + d - 1.35, yaw: FACE_LEFT }, cx - 0.2, 1.25, z + d - 1.35)
  poi('chat', 2, { x: cx - 0.5, z: z + 1.6, yaw: FACE_RIGHT }, cx + 0.5, 1.25, z + 1.6)
  poi('chat', 3, { x: cx + 0.5, z: z + 1.6, yaw: FACE_LEFT }, cx - 0.5, 1.25, z + 1.6)

  const obstacles: Rect[] = []
  for (const desk of r.desks) {
    obstacles.push({ x0: desk.x - 0.8, z0: desk.z - 0.45, x1: desk.x + 0.8, z1: desk.z + 0.4 })
    obstacles.push({ x0: desk.x - 0.27, z0: desk.z + SEAT_FRONT - 0.27, x1: desk.x + 0.27, z1: desk.z + SEAT_FRONT + 0.29 })
  }
  obstacles.push(
    { x0: shelf.x - 0.72, z0: z, x1: shelf.x + 0.72, z1: z + 0.5 },
    rect(plants[0].x, plants[0].z, 0.25, 0.25),
    rect(plants[1].x, plants[1].z, 0.22, 0.22),
    ...lamps.map((l) => rect(l.x, l.z, 0.16, 0.16)),
    { x0: coffee.x - 0.27, z0: coffee.z - 0.47, x1: x + w, z1: coffee.z + 0.47 },
    rect(pufe.x, pufe.z, PUFE_RADIUS, PUFE_RADIUS),
    // Paredes: fundo (com os peitoris), laterais (a esquerda com o vão da porta) e a borda da frente.
    { x0: x, z0: z, x1: x + w, z1: z + 0.2 },
    { x0: x, z0: z, x1: x + 0.08, z1: door.z - DOOR_WIDTH / 2 },
    { x0: x, z0: door.z + DOOR_WIDTH / 2, x1: x + 0.08, z1: z + d },
    { x0: x + w - 0.08, z0: z, x1: x + w, z1: z + d },
    { x0: x, z0: z + d - 0.02, x1: x + w, z1: z + d }
  )

  return {
    roomId: id,
    windows,
    board,
    shelf,
    plants,
    lamps,
    coffee,
    rug,
    pufe,
    door,
    doorIn: { x: x + 0.65, z: door.z, yaw: FACE_RIGHT },
    doorOut: { x: x - 1.05, z: door.z, yaw: FACE_RIGHT },
    pois,
    obstacles
  }
}
