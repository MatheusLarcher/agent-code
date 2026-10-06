/**
 * Planta do escritório ÚNICO — PURA (sem three) e fonte única de onde fica cada
 * coisa: furniture.ts tira daqui os pontos de interesse e os obstáculos da
 * navegação, decor*.ts desenha a partir daqui e layout.ts usa as estações. Mudar
 * um número aqui muda o desenho, a grade de navegação e as mesas juntos.
 *
 * Eixos como no resto do 3D: X à direita, Z para a câmera, Y para cima; metros
 * já na escala dos bonecos (o mockup v2 × 0,85 na planta; tampo a 0,75 m e
 * assento da cadeira a 0,46 m, no padrão). A frente (z alto) é aberta, como maquete.
 *
 * Arranjo em praça: 4 ilhas em U de 6 estações (ordem fixa de reserva:
 * frente-esquerda, frente-direita, trás-esquerda, trás-direita), o console da
 * Central no cruzamento, o lounge no fundo à esquerda, o kanban no centro da
 * parede do fundo, a sala de reunião de vidro no fundo à direita e, na parede
 * da direita (de trás para a frente), café, estante de Memórias, porta e quadro
 * de energia. A parede da esquerda é de vidro (o céu da hora atrás dele).
 *
 * Um U: 2 mesas no fundo e 2 em cada braço, os braços girados para dentro;
 * todas as telas olham para a câmera. Cada estação tem um `yaw` (o mesmo
 * `rotation.y` do three: positivo gira a tela para +X); no referencial dela o
 * monitor fica em −Z e quem senta em +Z (SEAT_FRONT), olhando para o monitor
 * com o mesmo yaw. `deskPoint` leva um ponto da mesa para o mundo. `out` é o
 * lado (no X da mesa) onde fica o gaveteiro e o lugar em pé ao lado da
 * cadeira: para fora do U no fundo, para dentro do U nos braços.
 */

export const OFFICE_ID = 'office'

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** O piso inteiro (19,95 × 23,81 m: 4 ilhas em U, corredores de 2,8 m no meio e 1,8 m no cruzado). */
export const OFFICE: Readonly<Rect> = { x0: -9.94, z0: -7.65, x1: 10.02, z1: 16.16 }
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
export const GLASS_MULLIONS: readonly number[] = Array.from({ length: 9 }, (_, i) => -7.4 + i * 2.83)
/** Parede da direita: centro em RIGHT_X, face de dentro em RIGHT_FACE_X, até RIGHT_WALL_Z1 (o fim das ilhas da frente). */
export const RIGHT_X = OFFICE.x1 - 0.08
export const RIGHT_FACE_X = RIGHT_X - WALL_T / 2
export const RIGHT_WALL_H = 2.2
export const RIGHT_WALL_Z1 = 14.16

// ── estações e ilhas ───────────────────────────────────────────────────────

/** Tampo: altura do centro, largura (x) e profundidade (z). */
export const DESK_HEIGHT = 0.75
export const DESK_W = 1.55
export const DESK_D = 1.2
/** Monitor: centro da tela e recuo para trás do centro da mesa. */
export const MONITOR_Y = 1.12
export const MONITOR_BACK = 0.3
/**
 * Onde fica o quadril de quem senta, a partir do centro da mesa: 0,35 m atrás
 * da borda do tampo. Os braços da cadeira (chairModel.ts) ficam abaixo do tampo
 * e a frente deles para perto da borda; os joelhos ficam sob o tampo.
 */
export const SEAT_FRONT = 0.95
/** Teclado, a partir do centro da mesa: 0,15 m para dentro da borda (ao alcance de quem senta). */
export const KEYBOARD_FRONT = 0.45
/** Quanto a cadeira recua (m), ao longo do eixo da mesa, no meio do sentar/levantar. */
export const CHAIR_PULL = 0.45

export type ZoneId = 'island0' | 'island1' | 'island2' | 'island3' | 'plaza' | 'lounge' | 'meeting' | 'shell'

export interface IslandPlace {
  index: number
  x: number
  z: number
  zone: ZoneId
}

/**
 * Ordem fixa de reserva: frente-esquerda, frente-direita, trás-esquerda, trás-direita. A origem
 * de cada ilha é o centro da fileira do fundo do U (+Z: para a boca do U e a câmera).
 */
export const ISLANDS: readonly IslandPlace[] = [
  { index: 0, x: -4.93, z: 7.83, zone: 'island0' },
  { index: 1, x: 4.93, z: 7.83, zone: 'island1' },
  { index: 2, x: -4.93, z: -0.9, zone: 'island2' },
  { index: 3, x: 4.93, z: -0.9, zone: 'island3' }
]

/** Um ponto e um rumo no chão: a mesa (centro do tampo) com o giro dela. */
export interface Placed {
  x: number
  z: number
  yaw: number
}

/** Ponto (lx, lz) no referencial de quem tem o giro `yaw` (rotation.y do three) levado para o mundo. */
export function deskPoint(d: Placed, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(d.yaw)
  const s = Math.sin(d.yaw)
  return { x: d.x + lx * c + lz * s, z: d.z - lx * s + lz * c }
}

/**
 * As 6 mesas de um U no referencial da ilha (k = ordem de ocupação): fundo-esq., fundo-dir.,
 * braço-trás-esq., braço-trás-dir., braço-frente-esq., braço-frente-dir. Os braços giram para
 * dentro; `out` = o lado de pé ao lado da cadeira (fora do U no fundo, dentro do U nos braços).
 */
export const U_DESKS: ReadonlyArray<{ x: number; z: number; yaw: number; out: 1 | -1 }> = [
  { x: -0.8, z: 0, yaw: 0, out: -1 },
  { x: 0.8, z: 0, yaw: 0, out: 1 },
  { x: -2.5, z: 2.0, yaw: 0.28, out: 1 },
  { x: 2.5, z: 2.0, yaw: -0.28, out: -1 },
  { x: -2.6, z: 4.6, yaw: 0.34, out: 1 },
  { x: 2.6, z: 4.6, yaw: -0.34, out: -1 }
]
export const STATIONS_PER_ISLAND = U_DESKS.length
/** Extensão do U (referencial da ilha) com as cadeiras recuadas e os lugares de pé: 7,06 × 6,93 m. */
export const U_EXTENT = { x0: -3.53, x1: 3.53, z0: -0.6, z1: 6.33 } as const
/** Divisória de feltro atrás de cada mesa (z da mesa, para trás do monitor). */
export const PARTITION_BACK = 0.625
/** Placa do projeto no chão, na boca do U (z da ilha), e o tapete arredondado sob o U inteiro. */
export const ISLAND_PLAQUE_Z = 5.9
export const ISLAND_RUG = { rx: 3.55, rz: 3.6, dz: 2.85 } as const
/** Estante com planta: na ponta de fora do braço da frente do lado da parede (x da ilha × lado, z), girada com o braço. */
export const ISLAND_SHELF = { x: 3.43, z: 5.69, w: 0.62, d: 0.3 } as const

export interface StationPlace extends Placed {
  index: number
  island: number
  /** Posição no U (0..5, ver U_DESKS). */
  k: number
  /** Lado (no X da mesa) do gaveteiro e do lugar de pé ao lado da cadeira. */
  out: 1 | -1
  zone: ZoneId
}

/** As 24 estações; índice = ilha · 6 + k. */
export const STATIONS: readonly StationPlace[] = ISLANDS.flatMap((isl) =>
  U_DESKS.map((u, k): StationPlace => ({ index: isl.index * STATIONS_PER_ISLAND + k, island: isl.index, k, x: isl.x + u.x, z: isl.z + u.z, yaw: u.yaw, out: u.out, zone: isl.zone }))
)

/** A estante com planta da ilha: do lado da parede (a ilha da esquerda à esquerda), longe do corredor do meio. */
export function islandShelf(island: number): Placed {
  const isl = ISLANDS[island]
  const side = isl.x < 0 ? -1 : 1
  return { x: isl.x + side * ISLAND_SHELF.x, z: isl.z + ISLAND_SHELF.z, yaw: side * U_DESKS[5].yaw }
}

// ── praça e Central ────────────────────────────────────────────────────────

/** Console da Central (o cruzamento da praça) e quem o opera, de pé olhando a tela inclinada (yaw 0). */
export const CONSOLE = { x: 0, z: 6.33, r: 0.67, top: 0.6 } as const
export const CENTRAL_SPOT = { x: 0, z: CONSOLE.z + 0.95, yaw: 0 } as const
/**
 * O teclado da Central: num suporte na borda do console, do lado de quem opera, na altura de
 * digitar em pé (o tampo do console, a 0,6 m, fica fora do alcance de quem está de pé).
 * `y` = topo das teclas; `d` = profundidade; `tilt` = inclinação da bandeja para quem digita.
 */
export const CONSOLE_KEYS = { x: 0, z: CONSOLE.z + CONSOLE.r - 0.12, y: 1.04, d: 0.15, tilt: 0.16 } as const
export const PLAZA_RUG = { x: 0, z: CONSOLE.z, r: 1.4 } as const
export const FRONT_PLANT = { x: 0, z: OFFICE.z1 - 0.7, scale: 1.9 } as const

// ── fundo: kanban, lounge e sala de reunião ────────────────────────────────

/** Centro (x) do kanban na parede do fundo. */
export const BOARD_X = -0.17

export const LOUNGE = {
  sideboard: { x: -5.5, z: BACK_FACE_Z + 0.33, w: 4.4, h: 0.62, d: 0.65 },
  rug: { x: -5.1, z: -5.35, rx: 2.1, rz: 1.5 },
  sofa: { x: -5.2, z: -6.3, w: 2.6, d: 0.95, seatY: 0.6 },
  /** Os 3 lugares do sofá (x), virados para +Z (yaw π). */
  sofaSeats: [-6.05, -5.2, -4.35] as readonly number[],
  table: { x: -5.2, z: -4.85, r: 0.42, h: 0.45 },
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
  /** Mesa e TV recentradas na sala (que vai até a parede da direita). */
  table: { x: 6.11, z: -5.4, w: 2.93, d: 1.21 },
  tv: { x: 6.11, y: 1.6, w: 2.25, h: 1.13 }
} as const

// ── parede da direita ──────────────────────────────────────────────────────

/** Balcão do café (o grupo gira −π/2: a máquina olha para −X); a fila cresce para −X. */
export const COFFEE = { x: RIGHT_FACE_X - 0.27, z: -2.5 } as const
export const MEMORY_SHELF = { x: RIGHT_FACE_X - 0.18, z: 2.0, w: 1.27, h: 1.0, d: 0.36 } as const
/** Lugares de pé diante da estante de Memórias (x) e o de espera atrás. */
export const MEMORY_SPOT_X = RIGHT_FACE_X - 0.9
export const MEMORY_SPOTS_Z: readonly number[] = [1.6, 2.0, 2.4]
export const MEMORY_WAIT = { x: MEMORY_SPOT_X - 0.65, z: 2.0 } as const
export const DOOR = { x: RIGHT_X, z: CONSOLE.z, width: 1, height: 2.02 } as const
/** Ao lado da ilha 1 (frente-direita): o armário cinza claro com a tomada e a doca das contas (largura fixa). */
export const ENERGY_PANEL = { x: RIGHT_FACE_X - 0.125, z: 9.43, w: 1.3, h: 1.5, d: 0.25, y0: 0.45 } as const

// ── parede de vidro e plantas ──────────────────────────────────────────────

/** Floreira junto do vidro, alinhada com a porta pelo corredor cruzado (comprida em z). */
export const GLASS_PLANTER = { x: GLASS_X + 0.47, z: CONSOLE.z, len: 2.8, d: 0.78, h: 0.66 } as const
/** Lugares para olhar pela parede de vidro (z), de frente para −X. */
export const WINDOW_SPOTS_Z: readonly number[] = [-1.2, 2.3, 8.83, 12.43]
export const WINDOW_SPOT_X = GLASS_X + 0.85
/** Plantas grandes no chão (a da frente e as dos cantos). */
export const FLOOR_PLANTS: ReadonlyArray<{ x: number; z: number; scale: number }> = [
  FRONT_PLANT,
  { x: OFFICE.x0 + 0.9, z: OFFICE.z1 - 0.85, scale: 1.5 },
  { x: OFFICE.x1 - 0.9, z: OFFICE.z1 - 0.85, scale: 1.6 },
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

/**
 * Os 3 lugares do lounge, os do sofá (virados para +Z): é nele que se cochila (a poltrona ao lado saiu). O
 * quadril fica longe o bastante do encosto (e das almofadas soltas) para quem cochila reclinado não atravessar o estofado.
 */
export const LOUNGE_SEATS: readonly SeatPlace[] = LOUNGE.sofaSeats.map((x): SeatPlace => ({ x, z: LOUNGE.sofa.z + 0.15, yaw: Math.PI, standX: x, standZ: -5.55 }))

/** Lugares do PO à esquerda do kanban, de frente para a parede do fundo. */
export const PO_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -2.05, z: -6.4 },
  { x: -2.65, z: -6.4 },
  { x: -2.05, z: -5.75 },
  { x: -2.65, z: -5.75 }
]

/**
 * De pé numa ilha (quem ficou sem mesa e sem lugar no lounge): 4 lugares dentro do U, perto da
 * boca e no miolo (os lugares de pé das cadeiras dos braços ficam mais para fora), olhando para o fundo do U.
 */
export function islandSideSpots(island: number): Array<{ x: number; z: number; yaw: number }> {
  const isl = ISLANDS[island]
  const out: Array<{ x: number; z: number; yaw: number }> = []
  for (const dz of [3.4, 4.3]) for (const side of [-1, 1] as const) out.push({ x: isl.x + side * 0.55, z: isl.z + dz, yaw: 0 })
  return out
}

/** Sobra das sobras: de pé na praça (o corredor do meio), atrás e na frente do console. */
export const PLAZA_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -0.9, z: CONSOLE.z - 2.8 },
  { x: 0.9, z: CONSOLE.z - 2.8 },
  { x: -0.9, z: CONSOLE.z + 2.8 },
  { x: 0.9, z: CONSOLE.z + 2.8 }
]

/**
 * A frente do escritório (z alto, aberta para a câmera): quem pede permissão vem para cá com a
 * plaquinha "Posso?", virado para a câmera, e volta quando o usuário responde. Fora da planta do meio.
 */
export const FRONT_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -1.0, z: OFFICE.z1 - 1.15 },
  { x: 1.0, z: OFFICE.z1 - 1.15 },
  { x: -1.6, z: OFFICE.z1 - 1.75 },
  { x: 1.6, z: OFFICE.z1 - 1.75 },
  { x: 0, z: OFFICE.z1 - 2.05 }
]

// ── zonas ──────────────────────────────────────────────────────────────────

export interface ZonePlace {
  id: ZoneId
  /** Parte do piso desta zona (as zonas particionam o piso; a 'shell' cobre tudo). */
  rect: Rect
}

/** Cortes: o corredor do meio (|x| < 1,4), o fundo (z < −2) e o corredor cruzado no z do console. */
const SPLIT_X = 1.4
const BACK_Z = -2.0
const MID_Z = CONSOLE.z

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
