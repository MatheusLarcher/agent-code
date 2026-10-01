// Layout mínimo de duas salas para os testes do motor (não é usado pelo app).
//
//   col: 0........9 10 11.......20
//   row 0  ##########  ##########     # parede, . piso, D porta
//   row 1  #........#  #........#     sala A: col 0–9, row 0–8, porta (4,8)
//   ...                               sala B: col 11–20, row 0–8, porta (15,8)
//   row 8  ####D#####  ####D#####     corredor: rows 9–10
//   row 9  #...................#
//   row 10 #...................#
//   row 11 #####################

import { OfficeState } from './officeState'
import { Direction, TileType } from './types'
import type { Character, CharacterLook, OfficeLayout, TileType as Tile } from './types'

export const LOOK: CharacterLook = { hair: '#6b4423', skin: '#f1c27d', outfit: '#4a7bd0', legs: '#2b2b3a' }

export const ROOM_A = { id: 'A', projectKey: 'proj-a', name: 'Projeto A', col: 0, row: 0, w: 10, h: 9, doorCol: 4, doorRow: 8 }
export const ROOM_B = { id: 'B', projectKey: 'proj-b', name: 'Projeto B', col: 11, row: 0, w: 10, h: 9, doorCol: 15, doorRow: 8 }

function paintRoom(tiles: Tile[], cols: number, r: typeof ROOM_A): void {
  for (let row = r.row; row < r.row + r.h; row++) {
    for (let col = r.col; col < r.col + r.w; col++) {
      const edge = row === r.row || row === r.row + r.h - 1 || col === r.col || col === r.col + r.w - 1
      tiles[row * cols + col] = edge ? TileType.WALL : TileType.FLOOR
    }
  }
  tiles[r.doorRow * cols + r.doorCol] = TileType.FLOOR
}

export function twoRoomLayout(): OfficeLayout {
  const cols = 21
  const rows = 12
  const tiles: Tile[] = new Array<Tile>(cols * rows).fill(TileType.VOID)
  paintRoom(tiles, cols, ROOM_A)
  paintRoom(tiles, cols, ROOM_B)
  for (let row = 9; row <= 11; row++) {
    for (let col = 0; col < cols; col++) {
      const edge = row === 11 || col === 0 || col === cols - 1
      tiles[row * cols + col] = edge ? TileType.WALL : TileType.FLOOR
    }
  }
  return {
    cols,
    rows,
    tiles,
    furniture: [
      { uid: 'deskA1', kind: 'mesa', col: 3, row: 2, w: 2, h: 1, blocks: true, roomId: 'A' },
      { uid: 'chairA1', kind: 'cadeira', col: 3, row: 3, w: 1, h: 1, blocks: true, roomId: 'A' },
      { uid: 'deskA2', kind: 'mesa', col: 6, row: 2, w: 2, h: 1, blocks: true, roomId: 'A', deskOfSeat: 'A2' },
      { uid: 'deskB1', kind: 'mesa', col: 14, row: 2, w: 2, h: 1, blocks: true, roomId: 'B' },
      { uid: 'matA', kind: 'entrada', col: 4, row: 7, w: 1, h: 1, blocks: false, roomId: 'A' }
    ],
    seats: [
      { uid: 'A1', col: 3, row: 3, facingDir: Direction.UP, roomId: 'A', kind: 'principal', deskUid: 'deskA1' },
      { uid: 'A2', col: 6, row: 3, facingDir: Direction.UP, roomId: 'A', kind: 'especialista', slot: 'executor' },
      { uid: 'B1', col: 14, row: 3, facingDir: Direction.UP, roomId: 'B', kind: 'principal', deskUid: 'deskB1' }
    ],
    rooms: [ROOM_A, ROOM_B],
    destinations: [
      // Na parede: o motor leva até o vizinho andável (5,1).
      { papel: 'kanban', roomId: 'A', col: 5, row: 0 },
      { papel: 'copa', roomId: null, col: 10, row: 10 }
    ]
  }
}

export function newOffice(): OfficeState {
  return new OfficeState(twoRoomLayout())
}

/** Roda o tique até `done` ser verdade (ou estourar o tempo de jogo). */
export function runUntil(state: OfficeState, done: () => boolean, maxSec = 60, dt = 0.05): boolean {
  for (let t = 0; t < maxSec; t += dt) {
    if (done()) return true
    state.update(dt)
  }
  return done()
}

export function inRect(ch: Character, r: typeof ROOM_A): boolean {
  return ch.tileCol >= r.col && ch.tileCol < r.col + r.w && ch.tileRow >= r.row && ch.tileRow < r.row + r.h
}
