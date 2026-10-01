// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { TileType, type TilePos } from './types'

/** Chave de tile usada no conjunto de bloqueados ("col,row"). */
export function tileKey(col: number, row: number): string {
  return `${col},${row}`
}

/** Andável = dentro do mapa, piso, e sem móvel bloqueando. */
export function isWalkable(col: number, row: number, tileMap: TileType[][], blockedTiles: Set<string>): boolean {
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false
  const t = tileMap[row][col]
  if (t === TileType.WALL || t === TileType.VOID) return false
  return !blockedTiles.has(tileKey(col, row))
}

export function getWalkableTiles(tileMap: TileType[][], blockedTiles: Set<string>): TilePos[] {
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  const tiles: TilePos[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) tiles.push({ col: c, row: r })
    }
  }
  return tiles
}

const DIRS = [
  { dc: 0, dr: -1 },
  { dc: 0, dr: 1 },
  { dc: -1, dr: 0 },
  { dc: 1, dr: 0 }
]

/**
 * BFS em grade 4-conectada. Devolve o caminho SEM o início e COM o fim; [] se
 * início = fim, se o fim não é andável ou se não há caminho. O início não
 * precisa ser andável (quem nasce na porta ou levanta da cadeira sai dele).
 *
 * A fila é um array lido por índice: `shift()` é O(n) e o BFS do original
 * ficava quadrático em mapas grandes. Visitados/pais em typed arrays pelo
 * mesmo motivo — nada de string por vizinho.
 */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>
): TilePos[] {
  if (startCol === endCol && startRow === endRow) return []
  if (!isWalkable(endCol, endRow, tileMap, blockedTiles)) return []
  const rows = tileMap.length
  const cols = rows > 0 ? tileMap[0].length : 0
  if (startRow < 0 || startRow >= rows || startCol < 0 || startCol >= cols) return []

  const start = startRow * cols + startCol
  const end = endRow * cols + endCol
  const parent = new Int32Array(rows * cols).fill(-1)
  const visited = new Uint8Array(rows * cols)
  const queue: number[] = [start]
  visited[start] = 1

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur === end) {
      const path: TilePos[] = []
      for (let k = end; k !== start; k = parent[k]) {
        path.push({ col: k % cols, row: Math.floor(k / cols) })
      }
      return path.reverse()
    }
    const cc = cur % cols
    const cr = Math.floor(cur / cols)
    for (const d of DIRS) {
      const nc = cc + d.dc
      const nr = cr + d.dr
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue
      const n = nr * cols + nc
      if (visited[n]) continue
      if (!isWalkable(nc, nr, tileMap, blockedTiles)) continue
      visited[n] = 1
      parent[n] = cur
      queue.push(n)
    }
  }
  return []
}
