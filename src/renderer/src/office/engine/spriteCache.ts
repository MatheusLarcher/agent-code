// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import type { SpriteData } from './types'

/**
 * SpriteData → canvas já ampliado, um cache por zoom. WeakMap por identidade:
 * quando a arte solta um sprite, o canvas vai junto. Por isso a arte precisa
 * devolver a MESMA referência para a mesma entrada (ver OfficeArt).
 */
const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>()
const outlineCache = new WeakMap<SpriteData, SpriteData>()

/** Contorno branco de 1 px (o sprite resultante tem 2 px a mais em cada eixo). */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite)
  if (cached) return cached
  const rows = sprite.length
  const cols = rows > 0 ? sprite[0].length : 0
  const outline: string[][] = []
  for (let r = 0; r < rows + 2; r++) outline.push(new Array<string>(cols + 2).fill(''))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] === '') continue
      const er = r + 1
      const ec = c + 1
      if (outline[er - 1][ec] === '') outline[er - 1][ec] = '#FFFFFF'
      if (outline[er + 1][ec] === '') outline[er + 1][ec] = '#FFFFFF'
      if (outline[er][ec - 1] === '') outline[er][ec - 1] = '#FFFFFF'
      if (outline[er][ec + 1] === '') outline[er][ec + 1] = '#FFFFFF'
    }
  }
  // O contorno não cobre o próprio sprite.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (sprite[r][c] !== '') outline[r + 1][c + 1] = ''
  }
  outlineCache.set(sprite, outline)
  return outline
}

/** Pinta o sprite pixel a pixel em `ctx`, cada pixel um quadrado de `zoom`. */
export function paintSprite(ctx: CanvasRenderingContext2D, sprite: SpriteData, x: number, y: number, zoom: number): void {
  for (let r = 0; r < sprite.length; r++) {
    const line = sprite[r]
    for (let c = 0; c < line.length; c++) {
      const color = line[c]
      if (color === '') continue
      ctx.fillStyle = color
      ctx.fillRect(x + c * zoom, y + r * zoom, zoom, zoom)
    }
  }
}

export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom)
  if (!cache) {
    cache = new WeakMap()
    zoomCaches.set(zoom, cache)
  }
  const cached = cache.get(sprite)
  if (cached) return cached

  const rows = sprite.length
  const cols = rows > 0 ? sprite[0].length : 0
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, cols * zoom)
  canvas.height = Math.max(1, rows * zoom)
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = false
    paintSprite(ctx, sprite, 0, 0, zoom)
  }
  cache.set(sprite, canvas)
  return canvas
}
