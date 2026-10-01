import type { BubbleKind } from '../engine/types'
import type { OfficePalette, PaletteKey } from './palette'

/**
 * Balões 9×7 do protótipo + 1 linha da "ponta" embaixo. O glifo 7×5 fica
 * dentro da borda. E=borda W=fundo a=âmbar g=verde r=vermelho.
 */
export const BUBBLE_KEYS: Readonly<Record<string, PaletteKey>> = {
  E: 'bubbleEdge',
  W: 'bubble',
  a: 'amber',
  g: 'okGreen',
  r: 'errRed'
}

/** Glifos 7×5; '.' vira o fundo do balão. */
export const GLYPHS: Readonly<Record<BubbleKind, readonly string[]>> = {
  permissao: ['.......', '.......', '.a.a.a.', '.......', '.......'],
  pergunta: ['..aaa..', '.....a.', '...aa..', '.......', '...a...'],
  ok: ['......g', '.....g.', 'g...g..', '.g.g...', '..g....'],
  erro: ['...r...', '...r...', '...r...', '.......', '...r...'],
  ampulheta: ['.aaaaa.', '..aaa..', '...a...', '..a.a..', '.aaaaa.']
}

export function bubbleRows(kind: BubbleKind): string[] {
  const glyph = GLYPHS[kind]
  const inner = glyph.map((r) => 'E' + r.replace(/\./g, 'W') + 'E')
  return ['EEEEEEEEE', ...inner, 'EEEEEEEEE', '....E....']
}

export function bubblePalette(pal: OfficePalette): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, token] of Object.entries(BUBBLE_KEYS)) out[k] = pal[token]
  return out
}

export const BUBBLE_KINDS: readonly BubbleKind[] = ['permissao', 'pergunta', 'ok', 'erro', 'ampulheta']
