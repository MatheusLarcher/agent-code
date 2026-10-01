// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  POSE_FRAMES,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  TILE_SIZE,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC
} from './constants'
import { findPath } from './tileMap'
import { CharacterState, Direction } from './types'
import type { Character, CharacterLook, CharacterPose, Pose, Seat, TilePos, TileType } from './types'
import { startWalk, tileCenter } from './world'

/** O que o FSM de um personagem enxerga do escritório a cada tique. */
export interface CharacterContext {
  seats: Map<string, Seat>
  tileMap: TileType[][]
  /** Já com o assento do próprio personagem desbloqueado. */
  blockedTiles: Set<string>
  /** Onde perambular: os tiles andáveis da sala do personagem. */
  wanderTiles: TilePos[]
  /** Gancho de lazer: devolvendo true, assume este tique no lugar do perambular. */
  idle?: (ch: Character, dt: number) => boolean
}

function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (dc > 0) return Direction.RIGHT
  if (dc < 0) return Direction.LEFT
  if (dr > 0) return Direction.DOWN
  return Direction.UP
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** Personagem parado em `at`. Nasce ativo e "digitando", como no original. */
export function createCharacter(
  id: number,
  look: CharacterLook,
  roomId: string | null,
  at: TilePos,
  dir: Direction = Direction.DOWN
): Character {
  const center = tileCenter(at.col, at.row)
  return {
    id,
    roomId,
    state: CharacterState.TYPE,
    dir,
    x: center.x,
    y: center.y,
    tileCol: at.col,
    tileRow: at.row,
    path: [],
    moveProgress: 0,
    activity: null,
    isActive: true,
    seatId: null,
    look,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    idleSince: 0,
    bubble: null,
    bubbleTimer: 0,
    prop: null,
    propTint: null,
    caption: null,
    captionTimer: 0,
    pinned: false,
    reaction: null,
    reactionTimer: 0,
    reactionOnArrive: null,
    isSubagent: false,
    parentAgentId: null,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    leaving: false,
    seatTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
  }
}

function sitDown(ch: Character, seat: Seat): void {
  ch.state = CharacterState.TYPE
  ch.dir = seat.facingDir
  ch.frame = 0
  ch.frameTimer = 0
}

function pathToSeat(ch: Character, seat: Seat, ctx: CharacterContext): TilePos[] {
  return findPath(ch.tileCol, ch.tileRow, seat.col, seat.row, ctx.tileMap, ctx.blockedTiles)
}

/** Avança no caminho. true = chegou ao fim (já centrado no último tile). */
function stepAlongPath(ch: Character, dt: number): boolean {
  if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
    ch.frameTimer -= WALK_FRAME_DURATION_SEC
    ch.frame = (ch.frame + 1) % 4
  }
  if (ch.path.length === 0) {
    const c = tileCenter(ch.tileCol, ch.tileRow)
    ch.x = c.x
    ch.y = c.y
    return true
  }
  const next = ch.path[0]
  ch.dir = directionBetween(ch.tileCol, ch.tileRow, next.col, next.row)
  ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt
  const from = tileCenter(ch.tileCol, ch.tileRow)
  const to = tileCenter(next.col, next.row)
  const t = Math.min(ch.moveProgress, 1)
  ch.x = from.x + (to.x - from.x) * t
  ch.y = from.y + (to.y - from.y) * t
  if (ch.moveProgress >= 1) {
    ch.tileCol = next.col
    ch.tileRow = next.row
    ch.x = to.x
    ch.y = to.y
    ch.path.shift()
    ch.moveProgress = 0
  }
  return false
}

/** Chegou ao fim do caminho: senta, digita no lugar ou volta a perambular. */
function arrive(ch: Character, ctx: CharacterContext): void {
  if (ch.pinned) {
    // Numa animação: para onde chegou; quem conduz decide o próximo passo.
    ch.state = CharacterState.IDLE
    ch.frame = 0
    ch.frameTimer = 0
    return
  }
  const seat = ch.seatId ? ctx.seats.get(ch.seatId) : undefined
  const atSeat = !!seat && ch.tileCol === seat.col && ch.tileRow === seat.row
  if (ch.isActive) {
    if (!ch.seatId) ch.state = CharacterState.TYPE
    else if (atSeat && seat) {
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
    } else ch.state = CharacterState.IDLE
  } else if (atSeat && seat) {
    // Voltou ao assento para descansar antes de perambular de novo. seatTimer < 0
    // é o sinal de setAgentActive(false) ("o turno acabou de terminar"): sem o
    // descanso longo, levanta já.
    sitDown(ch, seat)
    ch.seatTimer = ch.seatTimer < 0 ? 0 : randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC)
    ch.wanderCount = 0
    ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
    return
  } else {
    ch.state = CharacterState.IDLE
    ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
  }
  ch.frame = 0
  ch.frameTimer = 0
}

function wander(ch: Character, dt: number, ctx: CharacterContext): void {
  ch.wanderTimer -= dt
  if (ch.wanderTimer > 0) return
  // Já perambulou o bastante: volta ao assento para descansar.
  if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
    const seat = ctx.seats.get(ch.seatId)
    const path = seat ? pathToSeat(ch, seat, ctx) : []
    if (path.length > 0) {
      startWalk(ch, path)
      return
    }
  }
  if (ctx.wanderTiles.length > 0) {
    const target = ctx.wanderTiles[Math.floor(Math.random() * ctx.wanderTiles.length)]
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, ctx.tileMap, ctx.blockedTiles)
    if (path.length > 0) {
      startWalk(ch, path)
      ch.wanderCount++
    }
  }
  ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
}

export function updateCharacter(ch: Character, dt: number, ctx: CharacterContext): void {
  ch.frameTimer += dt

  // Saindo: só anda até a porta. Nada de sentar, perambular ou reagir a atividade;
  // ao chegar fica IDLE e o OfficeState o tira do mapa.
  if (ch.leaving) {
    if (ch.state === CharacterState.WALK && stepAlongPath(ch, dt)) {
      ch.state = CharacterState.IDLE
      ch.frame = 0
    }
    return
  }

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 2
      }
      if (ch.isActive || ch.pinned) break
      if (ctx.idle?.(ch, dt)) break
      // Inativo: espera o descanso acabar, levanta e começa a perambular.
      if (ch.seatTimer > 0) {
        ch.seatTimer -= dt
        break
      }
      ch.seatTimer = 0
      ch.state = CharacterState.IDLE
      ch.frame = 0
      ch.frameTimer = 0
      ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
      ch.wanderCount = 0
      ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
      break
    }

    case CharacterState.IDLE: {
      ch.frame = 0
      if (ch.seatTimer < 0) ch.seatTimer = 0
      // Numa animação: fica de pé onde está até ser solto.
      if (ch.pinned) break
      if (ch.isActive) {
        if (!ch.seatId) {
          // Sem assento (subagente, sala cheia): trabalha onde está.
          ch.state = CharacterState.TYPE
          ch.frameTimer = 0
          break
        }
        const seat = ctx.seats.get(ch.seatId)
        if (!seat) break
        const path = pathToSeat(ch, seat, ctx)
        // Caminho vazio = já está no assento ou não há como chegar: senta onde está.
        if (path.length > 0) startWalk(ch, path)
        else sitDown(ch, seat)
        break
      }
      if (ctx.idle?.(ch, dt)) break
      wander(ch, dt, ctx)
      break
    }

    case CharacterState.WALK: {
      // O original refazia aqui, a cada tique, o caminho de quem estava ativo
      // para o assento — o que anulava qualquer walkToDestination de agente
      // trabalhando. O "ficou ativo no meio do passeio" agora é tratado uma vez,
      // na transição (agents.setAgentActive).
      if (stepAlongPath(ch, dt)) arrive(ch, ctx)
      break
    }
  }
}

/**
 * Pose e quadro que a arte deve desenhar. O motor não escolhe sprite: só diz o
 * que o personagem está fazendo; frame já vem reduzido a POSE_FRAMES[pose].
 */
export function characterPose(ch: Character): CharacterPose {
  let pose: Pose
  if (ch.state === CharacterState.WALK) {
    pose = ch.dir === Direction.UP ? 'walkBack' : 'walk'
  } else if (ch.state === CharacterState.TYPE && ch.seatId !== null) {
    if (!ch.isActive) pose = 'sit'
    else pose = ch.activity === 'read' ? 'sitRead' : 'sitType'
  } else {
    pose = 'stand'
  }
  return { pose, frame: ch.frame % POSE_FRAMES[pose] }
}

/** Sentado na cadeira — o renderer desce o sprite e o balão nesse caso. */
export function isSeated(ch: Character): boolean {
  return ch.state === CharacterState.TYPE && ch.seatId !== null
}
