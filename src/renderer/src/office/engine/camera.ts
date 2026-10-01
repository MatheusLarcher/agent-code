// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

/**
 * Câmera pura: mundo ↔ tela, pan, zoom e seguir. Tudo em pixels de DISPOSITIVO
 * do canvas (o componente converte CSS → dispositivo com o devicePixelRatio na
 * borda); sem window/DOM aqui, para o renderer, o canvas e as sobreposições
 * HTML usarem a MESMA conta — uma cópia que arredonda diferente põe o rótulo um
 * pixel fora do sprite.
 */

import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  PAN_MARGIN_FRACTION,
  TILE_SIZE,
  ZOOM_MAX,
  ZOOM_MIN
} from './constants'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface MapSize {
  cols: number
  rows: number
}

/** Retângulo em tiles — um RoomDef serve direto. */
export interface TileRect {
  col: number
  row: number
  w: number
  h: number
}

export interface MapOffset {
  offsetX: number
  offsetY: number
}

/** Canto superior esquerdo do mapa no canvas: centralizado + pan, em pixels inteiros. */
export function mapOffset(
  canvasWidth: number,
  canvasHeight: number,
  cols: number,
  rows: number,
  zoom: number,
  panX: number,
  panY: number
): MapOffset {
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  return {
    offsetX: Math.floor((canvasWidth - mapW) / 2) + Math.round(panX),
    offsetY: Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)
  }
}

export function worldToScreen(p: Point, offset: MapOffset, zoom: number): Point {
  return { x: offset.offsetX + p.x * zoom, y: offset.offsetY + p.y * zoom }
}

export function screenToWorld(p: Point, offset: MapOffset, zoom: number): Point {
  return { x: (p.x - offset.offsetX) / zoom, y: (p.y - offset.offsetY) / zoom }
}

/** Zoom inteiro dentro dos limites: pixel-art só fica nítida em múltiplos exatos. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_MIN
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom)))
}

/** Limita o pan para a borda do mapa não passar de uma margem dentro do viewport. */
export function clampPan(pan: Point, viewport: Size, map: MapSize, zoom: number): Point {
  const mapW = map.cols * TILE_SIZE * zoom
  const mapH = map.rows * TILE_SIZE * zoom
  const maxX = mapW / 2 + viewport.width / 2 - viewport.width * PAN_MARGIN_FRACTION
  const maxY = mapH / 2 + viewport.height / 2 - viewport.height * PAN_MARGIN_FRACTION
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y))
  }
}

/** Pan que põe o ponto de mundo `focus` no centro do viewport. */
export function panToCenter(focus: Point, map: MapSize, zoom: number): Point {
  return {
    x: (map.cols * TILE_SIZE * zoom) / 2 - focus.x * zoom,
    y: (map.rows * TILE_SIZE * zoom) / 2 - focus.y * zoom
  }
}

/** Pan que centraliza um retângulo de tiles (uma sala) no viewport. */
export function centerOn(rect: TileRect, map: MapSize, zoom: number): Point {
  return panToCenter({ x: (rect.col + rect.w / 2) * TILE_SIZE, y: (rect.row + rect.h / 2) * TILE_SIZE }, map, zoom)
}

/** Maior zoom inteiro em que o retângulo inteiro cabe no viewport. */
export function fitZoom(viewport: Size, rect: TileRect): number {
  const w = Math.max(1, rect.w) * TILE_SIZE
  const h = Math.max(1, rect.h) * TILE_SIZE
  return clampZoom(Math.floor(Math.min(viewport.width / w, viewport.height / h)))
}

/**
 * Um passo de "seguir": aproxima o pan do alvo por CAMERA_FOLLOW_LERP por
 * quadro e encaixa quando falta menos que o limiar (sem tremer meio pixel).
 */
export function followStep(pan: Point, target: Point, map: MapSize, zoom: number): Point {
  const goal = panToCenter(target, map, zoom)
  const dx = goal.x - pan.x
  const dy = goal.y - pan.y
  if (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD) return goal
  return { x: pan.x + dx * CAMERA_FOLLOW_LERP, y: pan.y + dy * CAMERA_FOLLOW_LERP }
}
