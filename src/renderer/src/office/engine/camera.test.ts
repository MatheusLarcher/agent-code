import { describe, expect, it } from 'vitest'
import {
  centerOn,
  clampPan,
  clampZoom,
  fitZoom,
  followStep,
  mapOffset,
  panToCenter,
  screenToWorld,
  worldToScreen
} from './camera'
import { PAN_MARGIN_FRACTION, TILE_SIZE, ZOOM_MAX, ZOOM_MIN } from './constants'

const MAP = { cols: 21, rows: 12 }
const VIEW = { width: 800, height: 600 }

describe('camera', () => {
  it('screen ↔ world vai e volta sem perder nada', () => {
    for (const zoom of [1, 3, 7]) {
      const offset = mapOffset(VIEW.width, VIEW.height, MAP.cols, MAP.rows, zoom, 13.4, -27.8)
      for (const p of [
        { x: 0, y: 0 },
        { x: 37.5, y: 12.25 },
        { x: MAP.cols * TILE_SIZE, y: MAP.rows * TILE_SIZE }
      ]) {
        const back = screenToWorld(worldToScreen(p, offset, zoom), offset, zoom)
        expect(back.x).toBeCloseTo(p.x, 10)
        expect(back.y).toBeCloseTo(p.y, 10)
      }
    }
  })

  it('mapOffset centraliza o mapa e soma o pan em pixels inteiros', () => {
    const o = mapOffset(800, 600, 10, 10, 2, 0.6, -0.4)
    expect(o).toEqual({ offsetX: Math.floor((800 - 160) / 2) + 1, offsetY: Math.floor((600 - 160) / 2) + 0 })
  })

  it('clampPan segura a borda do mapa a uma margem dentro do viewport', () => {
    const zoom = 2
    const mapW = MAP.cols * TILE_SIZE * zoom
    const mapH = MAP.rows * TILE_SIZE * zoom
    const maxX = mapW / 2 + VIEW.width / 2 - VIEW.width * PAN_MARGIN_FRACTION
    const maxY = mapH / 2 + VIEW.height / 2 - VIEW.height * PAN_MARGIN_FRACTION
    expect(clampPan({ x: 1e6, y: -1e6 }, VIEW, MAP, zoom)).toEqual({ x: maxX, y: -maxY })
    expect(clampPan({ x: 10, y: -5 }, VIEW, MAP, zoom)).toEqual({ x: 10, y: -5 })
  })

  it('clampZoom arredonda para inteiro dentro dos limites', () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN)
    expect(clampZoom(3.6)).toBe(4)
    expect(clampZoom(999)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN)
  })

  it('fitZoom devolve o maior zoom inteiro em que a sala cabe', () => {
    const room = { col: 0, row: 0, w: 10, h: 9 }
    // 800 / 80 = 10; 600 / 72 = 8.33 → 8
    expect(fitZoom(VIEW, room)).toBe(8)
    const z = fitZoom(VIEW, room)
    expect(room.w * TILE_SIZE * z).toBeLessThanOrEqual(VIEW.width)
    expect(room.h * TILE_SIZE * (z + 1)).toBeGreaterThan(VIEW.height)
    expect(fitZoom({ width: 10, height: 10 }, room)).toBe(ZOOM_MIN)
    expect(fitZoom({ width: 1e5, height: 1e5 }, { col: 0, row: 0, w: 1, h: 1 })).toBe(ZOOM_MAX)
  })

  it('centerOn põe o centro da sala no centro do viewport', () => {
    const room = { col: 11, row: 0, w: 10, h: 9 }
    const zoom = 4
    const pan = centerOn(room, MAP, zoom)
    const offset = mapOffset(VIEW.width, VIEW.height, MAP.cols, MAP.rows, zoom, pan.x, pan.y)
    const c = worldToScreen({ x: (room.col + room.w / 2) * TILE_SIZE, y: (room.row + room.h / 2) * TILE_SIZE }, offset, zoom)
    expect(Math.abs(c.x - VIEW.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(c.y - VIEW.height / 2)).toBeLessThanOrEqual(1)
  })

  it('followStep aproxima com lerp e encaixa no alvo', () => {
    const target = { x: 40, y: 20 }
    const goal = panToCenter(target, MAP, 3)
    let pan = { x: 0, y: 0 }
    const first = followStep(pan, target, MAP, 3)
    expect(Math.abs(goal.x - first.x)).toBeLessThan(Math.abs(goal.x))
    for (let i = 0; i < 500; i++) pan = followStep(pan, target, MAP, 3)
    expect(pan).toEqual(goal)
  })
})
