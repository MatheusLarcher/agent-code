/**
 * Medidas do kanban na parede do fundo e onde cada papel fica — PURO (sem
 * three). furniture.ts (POIs, obstáculos), layout.ts (lugar do PO), a malha
 * (boardView.ts) e o arrasto leem daqui: mudar o quadro muda tudo junto.
 *
 * Posições da sala em metros a partir do canto `x`/`z` da sala; as do quadro
 * em coordenadas LOCAIS da face (origem no centro da face, X à direita, Y para
 * cima). Colunas A fazer · Fazendo · Concluído; cada uma mostra até
 * BOARD_ROWS papéis, na ordem do Quadro — passou disso, os BOARD_ROWS − 1
 * primeiros e uma pilha "+K" no último lugar.
 */
import type { BoardItemStatus } from '@shared/ipc'
import { BOARD_COLUMNS, columnIndex, type BoardCard } from './boardModel'

/** Quadro na parede (a partir do canto da sala): x de 0,30 a 2,95 e altura de 0,38 a 1,54 m. */
export const BOARD_X0 = 0.3
export const BOARD_X1 = 2.95
export const BOARD_Y0 = 0.38
export const BOARD_Y1 = 1.54
export const BOARD_W = BOARD_X1 - BOARD_X0
export const BOARD_H = BOARD_Y1 - BOARD_Y0
/** Centro do quadro (x a partir do canto da sala; y do chão). */
export const BOARD_CX = (BOARD_X0 + BOARD_X1) / 2
export const BOARD_CY = (BOARD_Y0 + BOARD_Y1) / 2
/** Moldura em volta da face. */
export const BOARD_FRAME = 0.05
/** Face (onde ficam cabeçalhos e papéis). */
export const FACE_W = BOARD_W - BOARD_FRAME * 2
export const FACE_H = BOARD_H - BOARD_FRAME * 2
export const COL_W = FACE_W / BOARD_COLUMNS.length
export const HEADER_H = 0.12
/** Papel e o passo entre as linhas. */
export const PAPER_W = 0.74
export const PAPER_H = 0.17
export const ROW_PITCH = 0.18
export const BOARD_ROWS = 5
/** Profundidade (a partir do plano da parede, z da sala): face, papel e papel erguido (hover/arrasto). */
export const FACE_Z = 0.112
export const PAPER_Z = 0.117
export const LIFT_Z = 0.15

/** Bloquinho (na ponta esquerda da canaleta) e cesto (no chão, à direita do quadro), a partir do canto da sala. */
export const PAD_SPOT = { x: BOARD_X0 + 0.18, y: BOARD_Y0 + 0.01, z: 0.17 }
export const BIN_SPOT = { x: BOARD_X1 - 0.17, z: 0.36, r: 0.13, h: 0.3 }
/** O PO fica de pé à esquerda, um passo atrás dos lugares das colunas. */
export const PO_SPOT = { x: 0.55, z: 1.4 }
/** Lugar de quem vai a uma coluna do quadro (z a partir do fundo da sala). */
export const COLUMN_SPOT_Z = 0.78

/** Centro X (local) da coluna. */
export function columnX(col: number): number {
  return -FACE_W / 2 + COL_W * (col + 0.5)
}

/** Centro do papel da linha `row` da coluna `col` (local). */
export function slotPos(col: number, row: number): { x: number; y: number } {
  return { x: columnX(col), y: FACE_H / 2 - HEADER_H - 0.02 - PAPER_H / 2 - row * ROW_PITCH }
}

/** Centro (local) do cabeçalho da coluna. */
export function headerPos(col: number): { x: number; y: number } {
  return { x: columnX(col), y: FACE_H / 2 - HEADER_H / 2 }
}

/** Coluna sob o ponto local da face; null fora dela. */
export function columnAt(x: number, y: number): number | null {
  if (Math.abs(x) > FACE_W / 2 || Math.abs(y) > FACE_H / 2) return null
  return Math.min(BOARD_COLUMNS.length - 1, Math.max(0, Math.floor((x + FACE_W / 2) / COL_W)))
}

/** Prende o ponto dentro da face (o papel arrastado não sai do quadro). */
export function clampToFace(x: number, y: number): { x: number; y: number } {
  const hx = FACE_W / 2 - PAPER_W / 2
  const hy = FACE_H / 2 - PAPER_H / 2
  return { x: Math.max(-hx, Math.min(hx, x)), y: Math.max(-hy, Math.min(hy, y)) }
}

/** Torto de leve e estável por cartão (papel pregado à mão). */
export function wobble(id: string): { dx: number; dy: number; rz: number } {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const u = h >>> 0
  const f = (shift: number): number => (((u >>> shift) & 0xff) / 255) * 2 - 1
  return { dx: f(0) * 0.012, dy: f(8) * 0.006, rz: f(16) * 0.035 }
}

export interface BoardColumnLayout {
  status: BoardItemStatus
  /** Todos os cartões da coluna (o contador do cabeçalho). */
  count: number
  /** Os que têm papel na parede, na ordem (linha = índice). */
  cards: BoardCard[]
  /** Os que ficaram na pilha. */
  hidden: BoardCard[]
  /** K da pilha "+K" (0 sem pilha). */
  pile: number
}

/** Distribui a parede nas colunas: até `rows` papéis; passou, `rows − 1` papéis e a pilha "+K". */
export function boardColumns(shown: readonly BoardCard[], rows = BOARD_ROWS): BoardColumnLayout[] {
  const cols: BoardColumnLayout[] = BOARD_COLUMNS.map((c) => ({ status: c.status, count: 0, cards: [], hidden: [], pile: 0 }))
  for (const card of shown) {
    const col = cols[columnIndex(card.status)]
    col.count++
    col.cards.push(card)
  }
  for (const col of cols) {
    if (col.count <= rows) continue
    col.hidden = col.cards.slice(rows - 1)
    col.cards = col.cards.slice(0, rows - 1)
    col.pile = col.hidden.length
  }
  return cols
}

/** Chave de pick do papel e da pilha de uma coluna. */
export const CARD_KEY = 'card:'
export const PILE_KEY = 'pile:'

export function pileKey(roomId: string, status: BoardItemStatus): string {
  return `${PILE_KEY}${roomId}|${status}`
}

/** `pile:<sala>|<status>` → partes; null se não for chave de pilha. */
export function parsePileKey(key: string): { roomId: string; status: BoardItemStatus } | null {
  if (!key.startsWith(PILE_KEY)) return null
  const bar = key.lastIndexOf('|')
  const status = key.slice(bar + 1)
  if (bar <= PILE_KEY.length || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return null
  return { roomId: key.slice(PILE_KEY.length, bar), status }
}
