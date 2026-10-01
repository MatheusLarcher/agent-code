import type { OfficePalette } from './palette'
import { bubblePalette } from './bubbles'
import { parseSprite } from './sprites'
import type { SpriteData } from '../engine/types'

/**
 * Balão de ondas de som (animação 10): o mesmo balão 9×7 dos outros, com um
 * alto-falante à esquerda e arcos que crescem de um a três (em ciclo).
 * 'a' = âmbar, como o '…'; o fundo e a borda são os do balão.
 */
export const WAVE_GLYPHS: readonly (readonly string[])[] = [
  ['.......', '.a.....', 'aa.a...', '.a.....', '.......'],
  ['.....a.', '.a.a..a', 'aa.a..a', '.a.a..a', '.....a.'],
  ['...a..a', '.a..a..', 'aa..a.a', '.a..a..', '...a..a']
]
export const WAVE_FRAMES = WAVE_GLYPHS.length

export function waveRows(frame: number): string[] {
  const glyph = WAVE_GLYPHS[((frame % WAVE_FRAMES) + WAVE_FRAMES) % WAVE_FRAMES]
  const inner = glyph.map((r) => 'E' + r.replace(/\./g, 'W') + 'E')
  return ['EEEEEEEEE', ...inner, 'EEEEEEEEE', '....E....']
}

/** Os quadros já rasterizados (mesma referência por quadro, para o cache). */
export function buildWaveSprites(pal: OfficePalette): (frame: number) => SpriteData {
  const bPal = bubblePalette(pal)
  const frames = WAVE_GLYPHS.map((_, i) => parseSprite(waveRows(i), bPal))
  return (frame) => frames[((frame % WAVE_FRAMES) + WAVE_FRAMES) % WAVE_FRAMES]
}
