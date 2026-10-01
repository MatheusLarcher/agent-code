// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

/**
 * Escolha de assento, pura: tipos estruturais para dar para testar sem a
 * classe OfficeState (o Seat de verdade satisfaz SeatLike).
 */

import type { SeatKind } from './types'

export interface SeatLike {
  col: number
  row: number
  assigned: boolean
  roomId: string
  kind: SeatKind
  slot?: string
}

export interface AnchorLike {
  seatId: string | null
  tileCol: number
  tileRow: number
}

/**
 * Tile em volta do qual agrupar alguém: o ASSENTO da âncora quando ela tem um,
 * senão o tile onde ela está. A âncora pode ainda estar andando até o assento;
 * usar o assento (estável) em vez do tile de passagem deixa o agrupamento
 * determinístico.
 */
export function anchorTile(
  anchor: AnchorLike | undefined,
  seats: ReadonlyMap<string, SeatLike>
): { col: number; row: number } | undefined {
  if (!anchor) return undefined
  const seat = anchor.seatId ? seats.get(anchor.seatId) : undefined
  return seat ? { col: seat.col, row: seat.row } : { col: anchor.tileCol, row: anchor.tileRow }
}

/** Assento livre mais perto (Manhattan) de um tile, opcionalmente só de uma sala. */
export function closestFreeSeat(
  seats: ReadonlyMap<string, SeatLike>,
  col: number,
  row: number,
  roomId?: string
): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const [uid, seat] of seats) {
    if (seat.assigned) continue
    if (roomId !== undefined && seat.roomId !== roomId) continue
    const d = Math.abs(seat.col - col) + Math.abs(seat.row - row)
    if (d < bestDist) {
      best = uid
      bestDist = d
    }
  }
  return best
}

export interface SeatRequest {
  roomId: string | null
  seatKind?: SeatKind
  slot?: string
  preferredSeatId?: string
}

/**
 * Assento livre para um agente, SEMPRE da sala pedida — salas são projetos e um
 * agente nunca senta na sala de outro.
 *
 * Ordem: o preferido (se livre e da sala) → a vaga pedida (entre os tipos
 * aceitos) → o primeiro livre de cada tipo aceito. Sem tipo pedido, vale 'principal' e depois 'especialista';
 * assento de 'reuniao' nunca é casa de ninguém. Com tipo explícito não há
 * troca de tipo: um especialista a mais não toma a cadeira do principal.
 * Dentro de cada etapa vale a ordem do layout (determinística, ao contrário do
 * sorteio do original).
 */
export function pickSeat(seats: ReadonlyMap<string, SeatLike>, req: SeatRequest): string | null {
  if (req.roomId === null) return null
  const inRoom: Array<[string, SeatLike]> = []
  for (const entry of seats) {
    if (!entry[1].assigned && entry[1].roomId === req.roomId) inRoom.push(entry)
  }
  if (req.preferredSeatId && inRoom.some(([uid]) => uid === req.preferredSeatId)) return req.preferredSeatId

  const kinds: SeatKind[] = req.seatKind ? [req.seatKind] : ['principal', 'especialista']
  if (req.slot) {
    const slotted = inRoom.find(([, s]) => kinds.includes(s.kind) && s.slot === req.slot)
    if (slotted) return slotted[0]
  }
  for (const kind of kinds) {
    const first = inRoom.find(([, s]) => s.kind === kind)
    if (first) return first[0]
  }
  return null
}
