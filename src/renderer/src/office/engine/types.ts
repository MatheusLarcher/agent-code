// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

/**
 * Tipos do motor do escritório. Estes nomes são contrato: o layout, a arte e o
 * painel importam daqui, então mudar um nome aqui quebra os três.
 */

export const TileType = {
  WALL: 0,
  FLOOR: 1,
  /** Segundo tom de piso (o xadrez do protótipo) — andável como FLOOR. */
  FLOOR_ALT: 2,
  /** Fora do mapa: não desenha e não anda. */
  VOID: 255
} as const
export type TileType = (typeof TileType)[keyof typeof TileType]

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3
} as const
export type Direction = (typeof Direction)[keyof typeof Direction]

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  /** Sentado no assento (trabalhando ou descansando) ou, sem assento, parado no lugar. */
  TYPE: 'type'
} as const
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState]

/** Matriz [linha][coluna] de cores hex; '' = transparente. */
export type SpriteData = string[][]

/** Cores (hex) que a arte usa para pintar um personagem. */
export interface CharacterLook {
  hair: string
  skin: string
  outfit: string
  legs: string
}

export type Pose = 'stand' | 'walk' | 'walkBack' | 'sit' | 'sitType' | 'sitRead'

/** O que a arte precisa para escolher o quadro: a pose e o índice dentro dela. */
export interface CharacterPose {
  pose: Pose
  /** 0 ≤ frame < POSE_FRAMES[pose]. */
  frame: number
}

/** Ferramenta em uso: digitando (Edit/Bash…) ou lendo (Read/Grep…). */
export type Activity = 'type' | 'read' | null

export type BubbleKind = 'permissao' | 'pergunta' | 'ok' | 'erro' | 'ampulheta'

export type PropKind =
  | 'celular'
  | 'zzz'
  | 'lupa'
  // F4·1-3: adereços das animações do catálogo.
  | 'pasta'
  | 'pasta-ok'
  | 'pasta-erro'
  | 'prancheta'
  | 'prancheta-ok'
  | 'prancheta-erro'
  | 'mao'
  | 'ficha'
  // F4·4-5: café na copa e troca de crachá.
  | 'xicara'
  | 'cracha'

/** Reação emotiva (behavior/reactions): balão + adereço sobreposto, 1 a 3 s. */
export type ReactionKind =
  | 'irritado'
  | 'surpreso'
  | 'sonolento'
  | 'feliz'
  | 'comemora'
  | 'nervoso'
  | 'frustrado'
  | 'aliviado'

export const REACTION_KINDS: readonly ReactionKind[] = [
  'irritado',
  'surpreso',
  'sonolento',
  'feliz',
  'comemora',
  'nervoso',
  'frustrado',
  'aliviado'
]

/** Sprites de uma reação: o balão e o adereço desenhado ao lado da cabeça. */
export interface ReactionSprites {
  bubble: SpriteData
  prop: SpriteData | null
}

export type FurnitureKind =
  | 'mesa'
  | 'cadeira'
  | 'mesa-reuniao'
  | 'cadeira-reuniao'
  | 'divisoria'
  | 'quadro-kanban'
  | 'impressora'
  | 'porta'
  | 'copa'
  | 'arquivo-memorias'
  | 'entrada'
  | 'planta'

/** Papel de um ponto do mapa para onde um personagem pode ser mandado. */
export type DestinationRole =
  | 'porta'
  | 'kanban'
  | 'impressora'
  | 'reuniao'
  | 'reuniao-cabeceira'
  | 'copa'
  | 'arquivo-memorias'
  | 'entrada'

export type SeatKind = 'principal' | 'especialista' | 'reuniao'

export interface PlacedFurniture {
  uid: string
  kind: FurnitureKind
  /** Canto superior esquerdo do footprint, em tiles. */
  col: number
  row: number
  /** Footprint em tiles. O sprite pode ser mais alto (cresce para cima a partir da base). */
  w: number
  h: number
  /** true = o footprint entra nos tiles bloqueados. */
  blocks: boolean
  /** Sala dona do móvel; null = corredor/área comum. */
  roomId: string | null
  papel?: DestinationRole
  /** Assento cujo dono, quando ativo, "liga" este móvel (monitor da mesa). */
  deskOfSeat?: string
}

export interface SeatDef {
  uid: string
  col: number
  row: number
  facingDir: Direction
  roomId: string
  kind: SeatKind
  /** Vaga nomeada dentro do tipo (ex.: 'executor'). */
  slot?: string
  /** Mesa deste assento: liga quando o dono está ativo. */
  deskUid?: string
}

export interface RoomDef {
  id: string
  /** Projeto que esta sala representa. */
  projectKey: string
  name: string
  /** Retângulo da sala em tiles (paredes inclusas). */
  col: number
  row: number
  w: number
  h: number
  /** Tile da porta: onde o personagem nasce e por onde sai. */
  doorCol: number
  doorRow: number
}

export interface Destination {
  papel: DestinationRole
  /** null = destino comum, alcançável de qualquer sala. */
  roomId: string | null
  col: number
  row: number
}

export interface OfficeLayout {
  cols: number
  rows: number
  /** Linha a linha (row-major): tiles[row * cols + col]. */
  tiles: TileType[]
  furniture: PlacedFurniture[]
  seats: SeatDef[]
  rooms: RoomDef[]
  destinations: Destination[]
}

/** Assento em tempo de execução: a definição + se já tem dono. */
export interface Seat extends SeatDef {
  assigned: boolean
}

export interface TilePos {
  col: number
  row: number
}

export interface Character {
  /** Agente: id positivo dado pelo app. Subagente: negativo, dado pelo motor. */
  id: number
  roomId: string | null
  state: CharacterState
  dir: Direction
  /** Posição em pixels de mundo (centro do tile; os pés do sprite). */
  x: number
  y: number
  tileCol: number
  tileRow: number
  /** Passos restantes (sem o tile atual). */
  path: TilePos[]
  /** 0–1 entre o tile atual e o próximo. */
  moveProgress: number
  activity: Activity
  isActive: boolean
  seatId: string | null
  look: CharacterLook
  frame: number
  frameTimer: number
  wanderTimer: number
  /** Segundos de jogo acumulados desde que ficou ocioso (0 enquanto ativo ou saindo). */
  idleSince: number
  bubble: BubbleKind | null
  /** Segundos restantes do balão; Infinity = fica até ser limpo. */
  bubbleTimer: number
  prop: PropKind | null
  /** Cor do adereço (a pasta leva a cor do projeto); null = a da paleta. */
  propTint: string | null
  /** Texto curto sobre a cabeça ('3 cartões', '+1 memória'); null = nenhum. */
  caption: string | null
  /** Segundos restantes da legenda. */
  captionTimer: number
  /** Numa animação (behavior/animQueue): o FSM não o leva ao assento nem o faz perambular. */
  pinned: boolean
  /**
   * Reação emotiva por cima do balão. Nunca esconde '…' (permissao) nem '?'
   * (pergunta): com esses, o renderer não a desenha.
   */
  reaction: ReactionKind | null
  /** Segundos restantes da reação. */
  reactionTimer: number
  /** Troca para esta reação ao parar de andar (chegou à reunião). */
  reactionOnArrive: ReactionKind | null
  /** Lendo uma mensagem em voz (F4·5, animação 10): balão com ondas. */
  speaking?: boolean
  isSubagent: boolean
  parentAgentId: number | null
  contextTokens: number
  maxContextTokens: number
  /** Indo embora: anda até a porta e some ao chegar. */
  leaving: boolean
  label?: string
  // Internos do FSM de perambular (do original). Não são contrato.
  /** Descanso sentado restante; -1 = "o turno acabou de terminar", levanta já. */
  seatTimer: number
  wanderCount: number
  wanderLimit: number
}

export interface FurnitureArtContext {
  /** Dono do assento ligado a este móvel está ativo (monitor ligado). */
  active: boolean
  /** Segundos de jogo, para animação. */
  t: number
}

/**
 * A arte que o renderer desenha. O motor não importa sprite nenhum: quem monta
 * o escritório passa uma implementação disto.
 *
 * O cache de sprites é por IDENTIDADE do SpriteData: devolva a mesma referência
 * para a mesma entrada, senão cada quadro rasteriza tudo de novo.
 */
export interface OfficeArt {
  tileColor(tile: TileType, col: number, row: number): string
  /** null = não desenha (móvel só lógico). */
  furnitureSprite(f: PlacedFurniture, ctx: FurnitureArtContext): SpriteData | null
  characterSprite(look: CharacterLook, pose: Pose, frame: number): SpriteData
  bubbleSprite(kind: BubbleKind): SpriteData
  /** tint: cor do adereço (só a pasta usa); sem ela, a da paleta. */
  propSprite(kind: PropKind, tint?: string | null): SpriteData
  /** Opcional: sem ele, as reações não aparecem (artes antigas e testes). */
  reactionSprites?(kind: ReactionKind): ReactionSprites
  /** Opcional: balão com ondas de som, quadro 0..WAVE_FRAMES-1. */
  wavesSprite?(frame: number): SpriteData
}
