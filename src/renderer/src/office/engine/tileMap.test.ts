import { describe, expect, it } from 'vitest'
import { findPath, getWalkableTiles, isWalkable } from './tileMap'
import { TileType } from './types'
import type { TilePos } from './types'

const F = TileType.FLOOR
const W = TileType.WALL

function grid(cols: number, rows: number, fill: TileType = F): TileType[][] {
  return Array.from({ length: rows }, () => new Array<TileType>(cols).fill(fill))
}

function isContiguous(start: TilePos, path: TilePos[]): boolean {
  let prev = start
  for (const p of path) {
    if (Math.abs(p.col - prev.col) + Math.abs(p.row - prev.row) !== 1) return false
    prev = p
  }
  return true
}

describe('findPath', () => {
  it('acha o caminho mínimo em grade aberta (Manhattan), sem o início e com o fim', () => {
    const map = grid(5, 5)
    const path = findPath(0, 0, 4, 4, map, new Set())
    expect(path).toHaveLength(8)
    expect(path[path.length - 1]).toEqual({ col: 4, row: 4 })
    expect(isContiguous({ col: 0, row: 0 }, path)).toBe(true)
  })

  it('contorna parede e móvel bloqueado pelo caminho mais curto', () => {
    // Parede na coluna 2 com passagem só na linha 4; (2,4) também bloqueado por móvel
    // até liberarmos — primeiro sem saída, depois o desvio exato.
    const map = grid(5, 5)
    for (let r = 0; r < 4; r++) map[r][2] = W
    expect(findPath(0, 0, 4, 0, map, new Set(['2,4']))).toEqual([])
    const path = findPath(0, 0, 4, 0, map, new Set())
    // 4 para descer, 4 para atravessar, 4 para subir.
    expect(path).toHaveLength(12)
    expect(path.some((p) => p.col === 2 && p.row !== 4)).toBe(false)
    expect(isContiguous({ col: 0, row: 0 }, path)).toBe(true)
  })

  it('destino inválido (parede, bloqueado, fora do mapa, VOID) devolve vazio', () => {
    const map = grid(4, 4)
    map[3][3] = W
    map[0][3] = TileType.VOID
    expect(findPath(0, 0, 3, 3, map, new Set())).toEqual([])
    expect(findPath(0, 0, 2, 2, map, new Set(['2,2']))).toEqual([])
    expect(findPath(0, 0, 9, 9, map, new Set())).toEqual([])
    expect(findPath(0, 0, -1, 0, map, new Set())).toEqual([])
    expect(findPath(0, 0, 3, 0, map, new Set())).toEqual([])
  })

  it('início igual ao fim devolve vazio; início bloqueado ainda sai (levantar da cadeira)', () => {
    const map = grid(3, 3)
    expect(findPath(1, 1, 1, 1, map, new Set())).toEqual([])
    expect(findPath(1, 1, 1, 2, map, new Set(['1,1']))).toEqual([{ col: 1, row: 2 }])
  })

  it('destino isolado por paredes não tem caminho', () => {
    const map = grid(5, 5)
    map[1][3] = W
    map[3][3] = W
    map[2][2] = W
    map[2][4] = W
    expect(findPath(0, 0, 3, 2, map, new Set())).toEqual([])
  })
})

describe('isWalkable / getWalkableTiles', () => {
  it('só piso fora de bloqueio conta', () => {
    const map = grid(3, 1)
    map[0][0] = W
    expect(isWalkable(0, 0, map, new Set())).toBe(false)
    expect(isWalkable(1, 0, map, new Set(['1,0']))).toBe(false)
    expect(getWalkableTiles(map, new Set(['1,0']))).toEqual([{ col: 2, row: 0 }])
  })
})
