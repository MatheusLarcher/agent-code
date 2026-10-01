import { TileType } from '../engine/types'
import type { BubbleKind, OfficeArt, PropKind, SpriteData } from '../engine/types'
import { bubblePalette, bubbleRows, BUBBLE_KINDS } from './bubbles'
import { FurnitureSprites } from './furniture'
import { PALETTE, type OfficePalette } from './palette'
import { propPalette, PROP_KINDS, PROP_ROWS, PROP_TINT_KEY, TINTED_PROPS } from './props'

export { projectColor } from './props'
import { buildReactionSprites } from './reactions'
import { CharacterSprites, parseSprite } from './sprites'
import { buildWaveSprites } from './waves'

export { PALETTE, type OfficePalette } from './palette'
export { lookFor, ROLE_COLORS } from './roles'
export { parseSprite } from './sprites'

/**
 * Cor do tile: piso em xadrez sutil A/B por (col+row)%2 (FLOOR_ALT inverte a
 * fase) e parede lisa com blocos claros espaçados, como no protótipo.
 */
export function tileColorFor(pal: OfficePalette, tile: TileType, col: number, row: number): string {
  const odd = (col + row) % 2 === 1
  switch (tile) {
    case TileType.WALL:
      return (col + row * 3) % 6 === 2 ? pal.wallHi : pal.wall
    case TileType.FLOOR:
      return odd ? pal.floorA : pal.floorB
    case TileType.FLOOR_ALT:
      return odd ? pal.floorB : pal.floorA
    default:
      return 'transparent'
  }
}

/** A arte do escritório para o motor; passe outra paleta para recolorir tudo. */
export function createOfficeArt(palette: OfficePalette = PALETTE): OfficeArt {
  const characters = new CharacterSprites()
  const furniture = new FurnitureSprites(palette)
  const bPal = bubblePalette(palette)
  const pPal = propPalette(palette)
  // Balões e objetos são poucos: gerados uma vez.
  const bubbles = new Map<BubbleKind, SpriteData>(BUBBLE_KINDS.map((k) => [k, parseSprite(bubbleRows(k), bPal)]))
  const props = new Map<PropKind, SpriteData>(PROP_KINDS.map((k) => [k, parseSprite(PROP_ROWS[k], pPal)]))
  const reactions = buildReactionSprites(palette)
  // Pasta na cor do projeto: uma por (adereço, cor), gerada na primeira vez.
  const tinted = new Map<string, SpriteData>()
  const propSprite = (kind: PropKind, tint?: string | null): SpriteData => {
    const base = props.get(kind) ?? props.get('celular')!
    if (!tint || !TINTED_PROPS.has(kind)) return base
    const key = `${kind}|${tint}`
    let s = tinted.get(key)
    if (!s) {
      s = parseSprite(PROP_ROWS[kind], { ...pPal, [PROP_TINT_KEY]: tint })
      tinted.set(key, s)
    }
    return s
  }
  return {
    tileColor: (tile, col, row) => tileColorFor(palette, tile, col, row),
    furnitureSprite: (f, ctx) => furniture.get(f, ctx),
    characterSprite: (look, pose, frame) => characters.get(look, pose, frame),
    bubbleSprite: (kind) => bubbles.get(kind) ?? bubbles.get('permissao')!,
    propSprite,
    reactionSprites: (kind) => reactions.get(kind) ?? reactions.get('feliz')!,
    wavesSprite: buildWaveSprites(palette)
  }
}
