// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { mapOffset, type MapOffset } from './camera'
import { TILE_SIZE } from './constants'
import { backgroundFurnitureItems, buildBubbleItems, buildCaptionItems, buildSceneItems, type SceneItem, type SceneSource } from './sceneLayers'
import { getCachedSprite, paintSprite } from './spriteCache'
import { TileType, type OfficeArt, type OfficeLayout } from './types'

export interface RenderView {
  /** Inteiro (ver clampZoom). */
  zoom: number
  panX: number
  panY: number
}

/** O que o renderer lê do OfficeState (a classe satisfaz isto). */
export interface RenderSource extends SceneSource {
  layoutVersion: number
}

/**
 * Desenha o escritório num canvas 2D com a arte recebida por OfficeArt.
 *
 * Fundo estático (tiles + móveis rente ao chão) num canvas fora da tela, feito
 * em 1:1 com o mundo e ampliado com vizinho-mais-próximo a cada quadro: em
 * pixel-art com zoom inteiro o resultado é idêntico a pintar já ampliado, e o
 * fundo só é refeito quando o LAYOUT muda — trocar o zoom não custa nada. Pintar
 * ampliado custaria um canvas de cols×rows×8×zoom px (64×64 tiles em zoom 20 =
 * 10240² px, ~400 MB).
 */
export class OfficeRenderer {
  private bg: HTMLCanvasElement | null = null
  private bgLayout: OfficeLayout | null = null
  private bgVersion = -1

  constructor(
    private art: OfficeArt,
    private readonly createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')
  ) {}

  /** Troca a arte (tema, paleta) — refaz o fundo no próximo quadro. */
  setArt(art: OfficeArt): void {
    this.art = art
    this.invalidate()
  }

  invalidate(): void {
    this.bgVersion = -1
    this.bgLayout = null
  }

  private ensureBackground(src: RenderSource): HTMLCanvasElement | null {
    const { layout } = src
    if (this.bg && this.bgLayout === layout && this.bgVersion === src.layoutVersion) return this.bg
    const canvas = this.bg ?? this.createCanvas()
    canvas.width = layout.cols * TILE_SIZE
    canvas.height = layout.rows * TILE_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const tile = layout.tiles[r * layout.cols + c]
        if (tile === TileType.VOID) continue
        ctx.fillStyle = this.art.tileColor(tile, c, r)
        ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE)
      }
    }
    for (const item of backgroundFurnitureItems(layout, this.art)) {
      paintSprite(ctx, item.sprite, Math.round(item.x), Math.round(item.y), 1)
    }
    this.bg = canvas
    this.bgLayout = layout
    this.bgVersion = src.layoutVersion
    return canvas
  }

  private drawItems(ctx: CanvasRenderingContext2D, items: SceneItem[], offset: MapOffset, zoom: number): void {
    for (const item of items) {
      if (item.alpha <= 0 || item.sprite.length === 0) continue
      const cached = getCachedSprite(item.sprite, zoom)
      // Arredonda em pixels de dispositivo, como o original: sprite fora da grade borra.
      const dx = Math.round(offset.offsetX + item.x * zoom)
      const dy = Math.round(offset.offsetY + item.y * zoom)
      if (item.alpha >= 1) {
        ctx.drawImage(cached, dx, dy)
        continue
      }
      ctx.save()
      ctx.globalAlpha = item.alpha
      ctx.drawImage(cached, dx, dy)
      ctx.restore()
    }
  }

  /** Um quadro. Devolve o offset do mapa — o mesmo que as sobreposições HTML devem usar. */
  render(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    src: RenderSource,
    view: RenderView
  ): MapOffset {
    const { zoom } = view
    const { cols, rows } = src.layout
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.imageSmoothingEnabled = false
    const offset = mapOffset(canvasWidth, canvasHeight, cols, rows, zoom, view.panX, view.panY)

    const bg = this.ensureBackground(src)
    if (bg) ctx.drawImage(bg, offset.offsetX, offset.offsetY, bg.width * zoom, bg.height * zoom)

    // Móveis + personagens ordenados por Y; balões sempre por cima.
    this.drawItems(ctx, buildSceneItems(src, this.art), offset, zoom)
    this.drawItems(ctx, buildBubbleItems(src, this.art), offset, zoom)
    this.drawCaptions(ctx, src, offset, zoom)
    return offset
  }

  /** Legendas em texto, por cima de tudo (fonte proporcional ao zoom). */
  private drawCaptions(ctx: CanvasRenderingContext2D, src: RenderSource, offset: MapOffset, zoom: number): void {
    const items = buildCaptionItems(src)
    if (items.length === 0 || typeof ctx.fillText !== 'function') return
    ctx.save()
    ctx.font = `bold ${Math.max(9, Math.round(4 * zoom))}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const it of items) {
      const x = Math.round(offset.offsetX + it.x * zoom)
      const y = Math.round(offset.offsetY + it.y * zoom)
      ctx.globalAlpha = it.alpha
      ctx.lineWidth = Math.max(2, zoom / 2)
      ctx.strokeStyle = '#1d1d2a'
      ctx.strokeText(it.text, x, y)
      ctx.fillStyle = '#eceef4'
      ctx.fillText(it.text, x, y)
    }
    ctx.restore()
  }
}
