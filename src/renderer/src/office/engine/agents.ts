// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { INACTIVE_SEAT_TIMER_MIN_SEC, INACTIVE_SEAT_TIMER_RANGE_SEC } from './constants'
import { createCharacter, isSeated } from './characters'
import { pickSeat, type SeatRequest } from './seatPlacement'
import { findPath, isWalkable } from './tileMap'
import { CharacterState } from './types'
import type { Activity, Character, CharacterLook, DestinationRole, SeatKind, TilePos } from './types'
import {
  closestFreeTile,
  findRoom,
  forgetCharacter,
  pathToward,
  placeAt,
  roomTiles,
  startWalk,
  withOwnSeatUnblocked,
  type OfficeWorld
} from './world'

export interface AddAgentOptions {
  roomId: string | null
  look: CharacterLook
  seatKind?: SeatKind
  slot?: string
  preferredSeatId?: string
  label?: string
}

function randomOf<T>(list: T[]): T | undefined {
  return list.length > 0 ? list[Math.floor(Math.random() * list.length)] : undefined
}

/** Toma um assento da sala (se houver) e anda até ele; sem assento, entra na sala e fica de pé. */
function claimSeatAndGo(world: OfficeWorld, ch: Character, req: SeatRequest): void {
  const seatId = pickSeat(world.seats, req)
  ch.seatId = seatId
  if (seatId) {
    const seat = world.seats.get(seatId)!
    seat.assigned = true
    const path = pathToward(world, ch, seat.col, seat.row)
    if (path && path.length > 0) startWalk(ch, path)
    else ch.state = CharacterState.IDLE // o FSM tenta de novo (ou senta onde está)
    return
  }
  const target = randomOf(roomTiles(world, req.roomId))
  const path = target ? pathToward(world, ch, target.col, target.row) : null
  if (path && path.length > 0) startWalk(ch, path)
}

/**
 * Entra pela porta da sala e anda até o assento livre dela. Sem sala conhecida
 * não há porta: nasce num tile andável qualquer da área comum.
 */
export function addAgent(world: OfficeWorld, id: number, opts: AddAgentOptions): void {
  // Ids <= 0 são dos subagentes (negativos) ou inválidos: aceitar faria dois
  // personagens dividirem o mesmo id. É erro de quem chama, então lança.
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RangeError(`addAgent: id precisa ser inteiro positivo (recebido ${String(id)})`)
  }
  const req: SeatRequest = {
    roomId: opts.roomId,
    seatKind: opts.seatKind,
    slot: opts.slot,
    preferredSeatId: opts.preferredSeatId
  }
  const existing = world.characters.get(id)
  if (existing) {
    // Voltou antes de sair pela porta: dá meia-volta em vez de duplicar.
    if (!existing.leaving) return
    existing.leaving = false
    existing.isActive = true
    // Readicionado em outra sala: passa a pertencer à sala nova (assento,
    // perambular e porta de saída vêm dela). Anda de onde está até lá.
    existing.roomId = opts.roomId
    existing.look = opts.look
    if (opts.label !== undefined) existing.label = opts.label
    world.seatRequests.set(id, req)
    claimSeatAndGo(world, existing, req)
    return
  }

  const room = findRoom(world, opts.roomId)
  const spawn: TilePos = room
    ? { col: room.doorCol, row: room.doorRow }
    : (randomOf(roomTiles(world, opts.roomId)) ?? randomOf(world.walkableTiles) ?? { col: 0, row: 0 })
  const ch = createCharacter(id, opts.look, opts.roomId, spawn)
  if (opts.label !== undefined) ch.label = opts.label
  world.characters.set(id, ch)
  world.seatRequests.set(id, req)
  claimSeatAndGo(world, ch, req)
}

/**
 * Libera o assento na hora (outro agente já pode pegá-lo) e manda o
 * personagem andar até a porta da sala; ele só sai do mapa ao chegar
 * (OfficeState.update). Sem sala/porta não há para onde andar: sai já.
 */
export function removeAgent(world: OfficeWorld, id: number): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return
  // Subagente não tem porta própria: sai na hora, como removeSubagent
  // (forgetCharacter limpa o registro de subagentes).
  if (ch.isSubagent) {
    forgetCharacter(world, id)
    return
  }
  if (ch.seatId) {
    const seat = world.seats.get(ch.seatId)
    if (seat) seat.assigned = false
    ch.seatId = null
  }
  ch.leaving = true
  ch.isActive = false
  ch.activity = null
  ch.bubble = null
  ch.bubbleTimer = 0
  ch.prop = null
  ch.propTint = null
  ch.caption = null
  ch.pinned = false
  ch.idleSince = 0
  sendToDoor(world, ch)
}

/** Caminho até a porta; se não houver (sala sumiu, porta murada), sai na hora. */
export function sendToDoor(world: OfficeWorld, ch: Character): void {
  const room = findRoom(world, ch.roomId)
  const path = room ? pathToward(world, ch, room.doorCol, room.doorRow) : null
  if (path && path.length > 0) {
    startWalk(ch, path)
    return
  }
  if (!room) {
    forgetCharacter(world, ch.id)
    return
  }
  // Já na porta (ou inalcançável): IDLE sem caminho, o próximo update o tira.
  ch.state = CharacterState.IDLE
  ch.path = []
}

export function setAgentActive(world: OfficeWorld, id: number, active: boolean): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return
  const wasActive = ch.isActive
  ch.isActive = active
  // Numa animação o caminho é dela: ligar/desligar o trabalho não o mexe.
  if (ch.pinned) return
  if (active) {
    ch.idleSince = 0
    // Ficou ativo no meio do passeio: volta para o assento agora.
    if (!wasActive && ch.state === CharacterState.WALK && ch.seatId) {
      const seat = world.seats.get(ch.seatId)
      const path = seat ? pathToward(world, ch, seat.col, seat.row) : null
      if (path && path.length > 0) startWalk(ch, path)
    }
    return
  }
  // -1: "o turno acabou de terminar" — ao chegar no assento não descansa
  // 2–4 min antes de levantar (ver characters.arrive).
  ch.seatTimer = -1
  ch.path = []
  ch.moveProgress = 0
}

export function setAgentTool(world: OfficeWorld, id: number, activity: Activity): void {
  const ch = world.characters.get(id)
  if (ch) ch.activity = activity
}

export function sendToSeat(world: OfficeWorld, id: number): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving || !ch.seatId) return
  const seat = world.seats.get(ch.seatId)
  if (!seat) return
  const path = withOwnSeatUnblocked(world, ch, () =>
    findPath(ch.tileCol, ch.tileRow, seat.col, seat.row, world.tileMap, world.blockedTiles)
  )
  if (path.length > 0) {
    startWalk(ch, path)
    return
  }
  ch.state = CharacterState.TYPE
  ch.dir = seat.facingDir
  ch.frame = 0
  ch.frameTimer = 0
  if (!ch.isActive) ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
}

/** Anda até um tile andável (ou o próprio assento). false = não dá para chegar. */
export function walkToTile(world: OfficeWorld, id: number, col: number, row: number): boolean {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return false
  const seat = ch.seatId ? world.seats.get(ch.seatId) : undefined
  const ownSeat = !!seat && seat.col === col && seat.row === row
  if (!ownSeat && !isWalkable(col, row, world.tileMap, world.blockedTiles)) return false
  const path = withOwnSeatUnblocked(world, ch, () =>
    findPath(ch.tileCol, ch.tileRow, col, row, world.tileMap, world.blockedTiles)
  )
  if (path.length === 0) return false
  startWalk(ch, path)
  return true
}

/**
 * Anda até o destino daquele papel na sala do personagem; sem um na sala, vale
 * o destino comum (roomId null). Nenhum dos dois, ou inalcançável → false e o
 * personagem segue como estava.
 */
export function walkToDestination(world: OfficeWorld, id: number, papel: DestinationRole): boolean {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return false
  const candidates = world.layout.destinations.filter((d) => d.papel === papel)
  const dest = candidates.find((d) => d.roomId !== null && d.roomId === ch.roomId) ?? candidates.find((d) => d.roomId === null)
  if (!dest) return false
  const path = pathToward(world, ch, dest.col, dest.row)
  if (path === null) return false
  if (path.length > 0) startWalk(ch, path)
  return true
}

/**
 * Depois de trocar o layout: quem ainda tem o assento (mesmo uid, mesma sala)
 * fica com ele; quem perdeu pede outro com o mesmo pedido de addAgent; quem
 * ficou dentro de parede/móvel vai para o tile andável mais perto da sala; quem
 * estava saindo recalcula o caminho até a porta.
 */
export function reseatAfterLayout(world: OfficeWorld): void {
  const leaving: Character[] = []
  for (const ch of world.characters.values()) {
    if (ch.leaving) {
      leaving.push(ch)
      continue
    }
    const seat = ch.seatId ? world.seats.get(ch.seatId) : undefined
    if (seat && !seat.assigned && seat.roomId === ch.roomId) {
      seat.assigned = true
      if (isSeated(ch)) {
        placeAt(ch, seat.col, seat.row)
        ch.dir = seat.facingDir
        continue
      }
    } else {
      ch.seatId = null
    }
    // O caminho antigo pode atravessar paredes novas: para no tile atual e
    // deixa o FSM decidir de novo.
    placeAt(ch, ch.tileCol, ch.tileRow)
    ch.state = CharacterState.IDLE
  }

  for (const ch of world.characters.values()) {
    if (ch.leaving || ch.seatId || ch.isSubagent) continue
    const req = world.seatRequests.get(ch.id)
    const seatId = pickSeat(world.seats, { ...req, roomId: ch.roomId, preferredSeatId: undefined })
    if (seatId) {
      world.seats.get(seatId)!.assigned = true
      ch.seatId = seatId
    }
  }

  for (const ch of world.characters.values()) {
    if (ch.leaving || isSeated(ch)) continue
    if (isWalkable(ch.tileCol, ch.tileRow, world.tileMap, world.blockedTiles)) continue
    const tiles = roomTiles(world, ch.roomId)
    const to = closestFreeTile(world, tiles.length > 0 ? tiles : world.walkableTiles, ch.tileCol, ch.tileRow)
    if (to) placeAt(ch, to.col, to.row)
  }

  for (const ch of leaving) sendToDoor(world, ch)
}
