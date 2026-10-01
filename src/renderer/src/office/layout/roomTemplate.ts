/**
 * Modelo de UMA sala de projeto, em coordenadas locais (tiles de 8 px, a
 * parede de cima/esquerda é a linha/coluna 0). Traduz o protótipo aprovado
 * (midia/44ea8e-escritorio-estilo.html) para a grade do motor: o HTML tem
 * paredes de 2 tiles e mesas em px soltos; aqui as paredes têm 1 tile (salas
 * vizinhas dividem a parede) e tudo cai em tile inteiro, mantendo a leitura —
 * mesas à esquerda, divisória com passagem, reunião à direita.
 */

import { Direction } from '../engine/types'
import type { Destination, PlacedFurniture, SeatDef } from '../engine/types'

/** Largura fixa da sala (paredes inclusas): salas lado a lado nunca se sobrepõem. */
export const ROOM_W = 37
/** Mesas por fileira, como no protótipo. */
export const DESKS_PER_ROW = 4
/** Principais do modelo base (2 fileiras); acima disso a sala ganha fileiras. */
export const BASE_PRINCIPALS = 8
export const SPECIALIST_SLOTS = ['executor', 'critico', 'navegador-de-codigo', 'reforco'] as const

const DESK_COL0 = 2
const DESK_STEP = 6
const DESK_W = 4
/** Cadeira centrada sob a mesa, como o `d.x + 14` do protótipo. */
const CHAIR_DX = 2
const DESK_ROW0 = 3
/** Mesa, cadeira e duas linhas de corredor entre fileiras. */
const ROW_STEP = 4
const DIVIDER_COL = 27
/** Passagem na divisória (linhas inclusas), na altura da mesa de reunião. */
const PASSAGE = { from: 6, to: 9 }
const TABLE = { col: 31, row: 4, w: 2, h: 8 }
const MEETING_CHAIR_ROWS = [4, 6, 8, 10]
const KANBAN = { col: 10, w: 3 }
const PRINTER_COL = 23
const DOOR_COL = 3

export function deskRowCount(principals: number): number {
  const extra = Math.max(0, Math.ceil((principals - BASE_PRINCIPALS) / DESKS_PER_ROW))
  return 3 + extra
}

/** Altura da sala (paredes inclusas) para n fileiras de mesa. */
export function roomHeight(rows: number): number {
  return DESK_ROW0 + rows * ROW_STEP + 1
}

export interface RoomContent {
  furniture: PlacedFurniture[]
  seats: SeatDef[]
  destinations: Destination[]
  /** Porta na parede de baixo (abre para o corredor). */
  door: { col: number; row: number }
  /** Altura da sala (paredes inclusas): o prédio alinha todas pela base. */
  h: number
}

/**
 * Conteúdo da sala já transladado para (ox, oy). Os uids levam o roomId para
 * ficarem estáveis entre gerações: o motor reencontra o assento do agente pelo
 * uid depois de trocar o layout (reseatAfterLayout).
 */
export function buildRoomContent(roomId: string, principals: number, ox: number, oy: number): RoomContent {
  const rows = deskRowCount(principals)
  const h = roomHeight(rows)
  const furniture: PlacedFurniture[] = []
  const seats: SeatDef[] = []
  const destinations: Destination[] = []
  const f = (p: Omit<PlacedFurniture, 'roomId' | 'col' | 'row'> & { col: number; row: number }): void => {
    furniture.push({ ...p, col: ox + p.col, row: oy + p.row, roomId })
  }
  const dest = (papel: Destination['papel'], col: number, row: number): void => {
    destinations.push({ papel, roomId, col: ox + col, row: oy + row })
  }

  // Fileiras 0 e 1 = principais; 2 = especialistas; 3+ = principais extras.
  // Os especialistas ficam na 3ª fileira mesmo quando a sala cresce: assim a
  // mesa do executor não muda de lugar porque entrou mais uma conversa.
  let principalIdx = 0
  for (let r = 0; r < rows; r++) {
    const deskRow = DESK_ROW0 + r * ROW_STEP
    for (let c = 0; c < DESKS_PER_ROW; c++) {
      const deskCol = DESK_COL0 + c * DESK_STEP
      const isSpecialist = r === 2
      const seatUid = isSpecialist ? `${roomId}:esp:${SPECIALIST_SLOTS[c]}` : `${roomId}:p${principalIdx++}`
      const deskUid = `${seatUid}:mesa`
      f({ uid: deskUid, kind: 'mesa', col: deskCol, row: deskRow, w: DESK_W, h: 1, blocks: true, deskOfSeat: seatUid })
      // A cadeira não bloqueia como móvel: o assento já bloqueia o tile para os outros.
      f({ uid: `${seatUid}:cadeira`, kind: 'cadeira', col: deskCol + CHAIR_DX, row: deskRow + 1, w: 1, h: 1, blocks: false })
      seats.push({
        uid: seatUid,
        col: ox + deskCol + CHAIR_DX,
        row: oy + deskRow + 1,
        facingDir: Direction.UP,
        roomId,
        kind: isSpecialist ? 'especialista' : 'principal',
        ...(isSpecialist ? { slot: SPECIALIST_SLOTS[c] } : {}),
        deskUid
      })
    }
  }

  // Divisória com passagem: dois trechos que bloqueiam, a abertura no meio.
  f({ uid: `${roomId}:divisoria:0`, kind: 'divisoria', col: DIVIDER_COL, row: 1, w: 1, h: PASSAGE.from - 1, blocks: true })
  f({ uid: `${roomId}:divisoria:1`, kind: 'divisoria', col: DIVIDER_COL, row: PASSAGE.to + 1, w: 1, h: h - 2 - PASSAGE.to, blocks: true })

  // Reunião: mesa comprida, cadeiras dos dois lados e cabeceira em cima.
  f({ uid: `${roomId}:reuniao`, kind: 'mesa-reuniao', ...TABLE, blocks: true, papel: 'reuniao' })
  for (const [i, row] of MEETING_CHAIR_ROWS.entries()) {
    for (const side of [
      { col: TABLE.col - 1, dir: Direction.RIGHT, tag: 'e' },
      { col: TABLE.col + TABLE.w, dir: Direction.LEFT, tag: 'd' }
    ]) {
      const uid = `${roomId}:reuniao:${side.tag}${i}`
      f({ uid: `${uid}:cadeira`, kind: 'cadeira-reuniao', col: side.col, row, w: 1, h: 1, blocks: false })
      seats.push({ uid, col: ox + side.col, row: oy + row, facingDir: side.dir, roomId, kind: 'reuniao' })
    }
  }
  const head = { col: TABLE.col, row: TABLE.row - 1 }
  f({ uid: `${roomId}:reuniao:cabeceira:cadeira`, kind: 'cadeira-reuniao', ...head, w: 1, h: 1, blocks: false, papel: 'reuniao-cabeceira' })
  seats.push({ uid: `${roomId}:reuniao:cabeceira`, ...{ col: ox + head.col, row: oy + head.row }, facingDir: Direction.DOWN, roomId, kind: 'reuniao', slot: 'cabeceira' })
  // Entre duas cadeiras da esquerda, encostado na mesa: lugar de pé de quem foi chamado.
  dest('reuniao', TABLE.col - 1, MEETING_CHAIR_ROWS[0] + 1)
  // Ao lado da cabeceira (a cadeira em si é assento e bloqueia).
  dest('reuniao-cabeceira', head.col + 1, head.row)

  // Quadro kanban embutido na parede de cima; o PO fica de pé logo abaixo.
  f({ uid: `${roomId}:kanban`, kind: 'quadro-kanban', col: KANBAN.col, row: 0, w: KANBAN.w, h: 1, blocks: true, papel: 'kanban' })
  dest('kanban', KANBAN.col + 1, 1)

  // Impressora encostada na parede de baixo, à direita das mesas.
  f({ uid: `${roomId}:impressora`, kind: 'impressora', col: PRINTER_COL, row: h - 2, w: 2, h: 1, blocks: true, papel: 'impressora' })
  dest('impressora', PRINTER_COL, h - 3)

  // Porta na parede de baixo, do lado das mesas (o protótipo a tem no canto).
  const door = { col: ox + DOOR_COL, row: oy + h - 1 }
  f({ uid: `${roomId}:porta`, kind: 'porta', col: DOOR_COL, row: h - 1, w: 1, h: 1, blocks: false, papel: 'porta' })
  dest('porta', DOOR_COL, h - 2)

  return { furniture, seats, destinations, door, h }
}
