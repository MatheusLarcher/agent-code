/**
 * Planta do escritório ÚNICO — PURA (sem three) e fonte única de onde fica cada
 * coisa: furniture.ts tira daqui os pontos de interesse e os obstáculos da
 * navegação, decor*.ts desenha a partir daqui e layout.ts usa as estações. Mudar
 * um número aqui muda o desenho, a grade de navegação e as mesas juntos.
 *
 * Eixos como no resto do 3D: X à direita, Z para a câmera, Y para cima; metros
 * já na escala dos bonecos (o mockup v2 × 0,85 na planta; tampo a 0,75 m e
 * assento perto de 0,36 m). A frente (z alto) é aberta, como maquete.
 *
 * Arranjo em praça: 4 ilhas retas de 4 estações (ordem fixa de reserva:
 * frente-esquerda, frente-direita, trás-esquerda, trás-direita), o console da
 * Central no cruzamento, o lounge no fundo à esquerda, o kanban no centro da
 * parede do fundo, a sala de reunião de vidro no fundo à direita e, na parede
 * da direita (de trás para a frente), café, estante de Memórias, porta e quadro
 * de energia. A parede da esquerda é de vidro (o céu da hora atrás dele).
 *
 * Estação `dir +1` (a "frente"): o monitor olha para +Z (tela virada para a
 * câmera) e quem senta fica em z + SEAT_FRONT, de costas para ela. `dir −1` (o
 * "fundo"): espelhada em z. `out` é o lado de fora da ilha (−1 esquerda, +1
 * direita): o gaveteiro e o lugar em pé ao lado da cadeira ficam nele.
 */

export const OFFICE_ID = 'office'

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** O piso inteiro. */
export const OFFICE: Readonly<Rect> = { x0: -8.5, z0: -7.65, x1: 8.5, z1: 9.85 }
export const OFFICE_W = OFFICE.x1 - OFFICE.x0
export const OFFICE_D = OFFICE.z1 - OFFICE.z0

// ── casca ──────────────────────────────────────────────────────────────────

export const WALL_T = 0.15
/** Parede do fundo: centro em OFFICE.z0; a face de dentro em BACK_FACE_Z. */
export const BACK_WALL_H = 2.8
export const BACK_FACE_Z = OFFICE.z0 + WALL_T / 2
/** Parede de vidro (esquerda): peitoril sólido, montantes, painéis e a viga do alto. */
export const GLASS_X = OFFICE.x0 + 0.07
export const GLASS_SILL_H = 0.45
export const GLASS_TOP = 2.6
export const GLASS_H = 2.8
/** Montantes da parede de vidro (z). */
export const GLASS_MULLIONS: readonly number[] = [-7.4, -4.68, -1.96, 0.76, 3.48, 6.2, 8.92]
/** Parede da direita: centro em RIGHT_X, face de dentro em RIGHT_FACE_X, até RIGHT_WALL_Z1. */
export const RIGHT_X = OFFICE.x1 - 0.08
export const RIGHT_FACE_X = RIGHT_X - WALL_T / 2
export const RIGHT_WALL_H = 2.2
export const RIGHT_WALL_Z1 = 6.2

// ── estações e ilhas ───────────────────────────────────────────────────────

/** Tampo: altura do centro, largura (x) e profundidade (z). */
export const DESK_HEIGHT = 0.75
export const DESK_W = 1.55
export const DESK_D = 1.2
/** Monitor: centro da tela e recuo para trás do centro da mesa. */
export const MONITOR_Y = 1.12
export const MONITOR_BACK = 0.3
/**
 * Onde fica o quadril de quem senta (e o centro da cadeira), a partir do centro
 * da mesa: 0,21 m atrás da borda do tampo — os joelhos ficam sob o tampo e o
 * peito não encosta nele (poses.ts, pose da estação).
 */
export const SEAT_FRONT = 0.81
/** Teclado, a partir do centro da mesa: 0,40 m para dentro da borda (o alcance dos braços estendidos sobre ele). */
export const KEYBOARD_FRONT = 0.2

export type ZoneId = 'island0' | 'island1' | 'island2' | 'island3' | 'plaza' | 'lounge' | 'meeting' | 'shell'

export interface IslandPlace {
  index: number
  x: number
  z: number
  zone: ZoneId
}

/** Ordem fixa de reserva: frente-esquerda, frente-direita, trás-esquerda, trás-direita. */
export const ISLANDS: readonly IslandPlace[] = [
  { index: 0, x: -4.25, z: 6.46, zone: 'island0' },
  { index: 1, x: 4.25, z: 6.46, zone: 'island1' },
  { index: 2, x: -4.25, z: 0.85, zone: 'island2' },
  { index: 3, x: 4.25, z: 0.85, zone: 'island3' }
]

/** Estação dentro da ilha: meia distância em x entre as duas colunas e em z entre as duas fileiras. */
export const STATION_DX = 0.8
export const STATION_DZ = 0.62
/** Estante com planta na ponta da ilha (z local), placa no chão e o tapete arredondado. */
export const ISLAND_SHELF_Z = 1.8
export const ISLAND_PLAQUE_Z = 2.75
export const ISLAND_RUG = { rx: 2.3, rz: 2.4, dz: 0.1 } as const
export const STATIONS_PER_ISLAND = 4

export interface StationPlace {
  index: number
  island: number
  x: number
  z: number
  /** +1: monitor olha para +Z (a "frente"); −1: espelhada. */
  dir: 1 | -1
  /** Lado de fora da ilha (−1 esquerda, +1 direita). */
  out: 1 | -1
  front: boolean
  zone: ZoneId
}

/** As 16 estações; índice = ilha · 4 + k (k: 0 frente-esq., 1 frente-dir., 2 fundo-esq., 3 fundo-dir.). */
export const STATIONS: readonly StationPlace[] = ISLANDS.flatMap((isl) =>
  ([0, 1, 2, 3] as const).map((k): StationPlace => {
    const out: 1 | -1 = k % 2 === 0 ? -1 : 1
    const dir: 1 | -1 = k < 2 ? 1 : -1
    return { index: isl.index * STATIONS_PER_ISLAND + k, island: isl.index, x: isl.x + out * STATION_DX, z: isl.z + dir * STATION_DZ, dir, out, front: dir === 1, zone: isl.zone }
  })
)

// ── praça e Central ────────────────────────────────────────────────────────

/** Console da Central (o cruzamento da praça) e quem o opera, de pé olhando a tela inclinada (yaw 0). */
export const CONSOLE = { x: 0, z: 3.66, r: 0.67, top: 0.6 } as const
export const CENTRAL_SPOT = { x: 0, z: CONSOLE.z + 0.95, yaw: 0 } as const
export const PLAZA_RUG = { x: 0, z: CONSOLE.z, r: 1.4 } as const
export const FRONT_PLANT = { x: 0, z: 9.15, scale: 1.9 } as const

// ── fundo: kanban, lounge e sala de reunião ────────────────────────────────

/** Centro (x) do kanban na parede do fundo. */
export const BOARD_X = -0.17

export const LOUNGE = {
  sideboard: { x: -5.5, z: BACK_FACE_Z + 0.33, w: 4.4, h: 0.62, d: 0.65 },
  rug: { x: -5.1, z: -5.35, rx: 2.1, rz: 1.5 },
  sofa: { x: -5.2, z: -6.3, w: 2.6, d: 0.85, seatY: 0.34 },
  /** Os 3 lugares do sofá (x), virados para +Z (yaw π). */
  sofaSeats: [-6.05, -5.2, -4.35] as readonly number[],
  table: { x: -5.2, z: -4.85, r: 0.42, h: 0.34 },
  armchair: { x: -3.55, z: -5.05, yaw: 1.95 },
  lamp: { x: -7.35, z: -6.0 },
  pendant: { x: -5.1, y: 2.4, z: -5.3 },
  art: [-5.95, -4.55] as readonly number[],
  plant: { x: -2.25, z: -7.15, scale: 1 }
} as const

/** Sala de reunião de vidro: o retângulo, o vão da porta de vidro (x na frente), a mesa e a TV. */
export const MEETING = {
  x0: 1.76,
  x1: RIGHT_FACE_X,
  z0: BACK_FACE_Z,
  z1: -3.22,
  door: { x0: 3.1, x1: 4.1 },
  table: { x: 5.05, z: -5.4, w: 2.93, d: 1.21 },
  tv: { x: 5.05, y: 1.6, w: 2.25, h: 1.13 }
} as const

// ── parede da direita ──────────────────────────────────────────────────────

/** Balcão do café (o grupo gira −π/2: a máquina olha para −X); a fila cresce para −X. */
export const COFFEE = { x: RIGHT_FACE_X - 0.27, z: -2.5 } as const
export const MEMORY_SHELF = { x: RIGHT_FACE_X - 0.18, z: 2.0, w: 1.27, h: 1.0, d: 0.36 } as const
/** Lugares de pé diante da estante de Memórias (x) e o de espera atrás. */
export const MEMORY_SPOT_X = 7.45
export const MEMORY_SPOTS_Z: readonly number[] = [1.6, 2.0, 2.4]
export const MEMORY_WAIT = { x: 6.8, z: 2.0 } as const
export const DOOR = { x: RIGHT_X, z: CONSOLE.z, width: 1, height: 1.9 } as const
export const ENERGY_PANEL = { x: RIGHT_FACE_X - 0.125, z: 5.05, w: 0.7, h: 1.5, d: 0.25, y0: 0.45 } as const

// ── parede de vidro e plantas ──────────────────────────────────────────────

/** Floreira junto do vidro, alinhada com a porta pelo corredor cruzado (comprida em z). */
export const GLASS_PLANTER = { x: GLASS_X + 0.47, z: CONSOLE.z, len: 2.8, d: 0.78, h: 0.66 } as const
/** Lugares para olhar pela parede de vidro (z), de frente para −X. */
export const WINDOW_SPOTS_Z: readonly number[] = [-1.0, 1.75, 6.0]
export const WINDOW_SPOT_X = GLASS_X + 0.85
/** Plantas grandes no chão (a da frente e as dos cantos). */
export const FLOOR_PLANTS: ReadonlyArray<{ x: number; z: number; scale: number }> = [
  FRONT_PLANT,
  { x: -7.6, z: 9.0, scale: 1.5 },
  { x: 7.6, z: 9.0, scale: 1.6 },
  LOUNGE.plant
]

// ── lugares fixos de gente ─────────────────────────────────────────────────

export interface SeatPlace {
  /** Onde o quadril fica sentado e para onde olha. */
  x: number
  z: number
  yaw: number
  /** Em pé, na frente do assento (de onde senta e para onde levanta). */
  standX: number
  standZ: number
}

/** Os 4 lugares do lounge: os 3 do sofá (virados para +Z) e a poltrona. */
export const LOUNGE_SEATS: readonly SeatPlace[] = [
  ...LOUNGE.sofaSeats.map((x): SeatPlace => ({ x, z: LOUNGE.sofa.z + 0.1, yaw: Math.PI, standX: x, standZ: -5.55 })),
  { x: LOUNGE.armchair.x, z: LOUNGE.armchair.z, yaw: LOUNGE.armchair.yaw, standX: LOUNGE.armchair.x - 0.5, standZ: LOUNGE.armchair.z + 0.2 }
]

/** Lugares do PO à esquerda do kanban, de frente para a parede do fundo. */
export const PO_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -2.05, z: -6.4 },
  { x: -2.65, z: -6.4 },
  { x: -2.05, z: -5.75 },
  { x: -2.65, z: -5.75 }
]

/** De pé ao lado de uma ilha (quem ficou sem mesa e sem lugar no lounge): 2 de cada lado, olhando para a ilha. */
export function islandSideSpots(island: number): Array<{ x: number; z: number; yaw: number }> {
  const isl = ISLANDS[island]
  const out: Array<{ x: number; z: number; yaw: number }> = []
  for (const side of [-1, 1] as const) for (const dz of [-0.45, 0.45]) out.push({ x: isl.x + side * 2.15, z: isl.z + dz, yaw: side * (Math.PI / 2) })
  return out
}

/** Sobra das sobras: de pé na praça, perto do console. */
export const PLAZA_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -1.0, z: 1.7 },
  { x: 1.0, z: 1.7 },
  { x: -1.0, z: 5.7 },
  { x: 1.0, z: 5.7 }
]

// ── zonas ──────────────────────────────────────────────────────────────────

export interface ZonePlace {
  id: ZoneId
  /** Parte do piso desta zona (as zonas particionam o piso; a 'shell' cobre tudo). */
  rect: Rect
}

const SPLIT_X = 1.75
const BACK_Z = -2.0
const MID_Z = 3.2

/** As zonas do piso (sem a 'shell'), na ordem do desenho. */
export const ZONES: readonly ZonePlace[] = [
  { id: 'lounge', rect: { x0: OFFICE.x0, z0: OFFICE.z0, x1: -SPLIT_X, z1: BACK_Z } },
  { id: 'plaza', rect: { x0: -SPLIT_X, z0: OFFICE.z0, x1: SPLIT_X, z1: OFFICE.z1 } },
  { id: 'meeting', rect: { x0: SPLIT_X, z0: OFFICE.z0, x1: OFFICE.x1, z1: BACK_Z } },
  { id: 'island2', rect: { x0: OFFICE.x0, z0: BACK_Z, x1: -SPLIT_X, z1: MID_Z } },
  { id: 'island3', rect: { x0: SPLIT_X, z0: BACK_Z, x1: OFFICE.x1, z1: MID_Z } },
  { id: 'island0', rect: { x0: OFFICE.x0, z0: MID_Z, x1: -SPLIT_X, z1: OFFICE.z1 } },
  { id: 'island1', rect: { x0: SPLIT_X, z0: MID_Z, x1: OFFICE.x1, z1: OFFICE.z1 } }
]

/** Todas as zonas, com a casca primeiro. */
export const ZONE_IDS: readonly ZoneId[] = ['shell', ...ZONES.map((z) => z.id)]

/** A zona do piso que contém (x, z); fora do piso, a mais perto. Nunca 'shell'. */
export function zoneAt(x: number, z: number): ZoneId {
  const cx = Math.min(OFFICE.x1, Math.max(OFFICE.x0, x))
  const cz = Math.min(OFFICE.z1, Math.max(OFFICE.z0, z))
  if (cx < -SPLIT_X) return cz < BACK_Z ? 'lounge' : cz < MID_Z ? 'island2' : 'island0'
  if (cx > SPLIT_X) return cz < BACK_Z ? 'meeting' : cz < MID_Z ? 'island3' : 'island1'
  return 'plaza'
}
