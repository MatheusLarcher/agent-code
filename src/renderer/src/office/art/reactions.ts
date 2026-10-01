import { REACTION_KINDS, type ReactionKind, type ReactionSprites } from '../engine/types'
import { BUBBLE_KEYS } from './bubbles'
import type { OfficePalette, PaletteKey } from './palette'
import { parseSprite } from './sprites'

/**
 * Reações (card sug-aderecos-sobrepostos): cada uma é um balão 9×7 com um
 * rostinho 7×5, no mesmo formato dos balões de estado, mais um adereço
 * pequeno colado ao lado (fumaça, gota de suor, confete…). Nada de quadro
 * novo de personagem.
 *
 * Letras além das do balão: k=traço escuro y=amarelo p=rosa b=azul s=fumaça.
 */
export const REACTION_KEYS: Readonly<Record<string, PaletteKey>> = {
  ...BUBBLE_KEYS,
  k: 'legs',
  y: 'postYellow',
  p: 'postPink',
  b: 'postBlue',
  s: 'sleep'
}

/** Rostos 7×5; '.' vira o fundo do balão. */
export const REACTION_FACES: Readonly<Record<ReactionKind, readonly string[]>> = {
  // Sobrancelhas em V e boca para baixo.
  irritado: ['r.....r', '.r...r.', '.......', '..rrr..', '.r...r.'],
  // Olhos e boca em "o".
  surpreso: ['.a...a.', '.......', '...a...', '..a.a..', '...a...'],
  // Olhos fechados, "z" e bocejo.
  sonolento: ['....kkk', '.....k.', 'kk.kkkk', '.......', '..kkk..'],
  feliz: ['.g...g.', '.......', 'g.....g', '.g...g.', '..ggg..'],
  // Estrela de festa.
  comemora: ['...y...', '..yyy..', 'yyyyyyy', '..y.y..', '.y...y.'],
  // Boca tremida.
  nervoso: ['.b...b.', '.......', '.......', '.b.b.b.', 'b.b.b.b'],
  // Olhos em X e boca reta.
  frustrado: ['r.r.r.r', '.r...r.', 'r.r.r.r', '.......', '.rrrrr.'],
  // Olhos fechados, sorriso leve.
  aliviado: ['.......', 'gg...gg', '.......', '..ggg..', '.......']
}

/** Adereços sobrepostos, ao lado do balão. */
export const REACTION_PROPS: Readonly<Record<ReactionKind, readonly string[]>> = {
  // Fumacinha na cabeça.
  irritado: ['.ss..', 's..s.', '.ss.s', '...s.', '..s..'],
  // O "!" do pulinho.
  surpreso: ['rr', 'rr', 'rr', '..', 'rr'],
  sonolento: ['...kkk', '....k.', 'kk.kkk', '.k....', 'kk....'],
  // Coraçãozinho.
  feliz: ['p.p', 'ppp', '.p.'],
  // Confete.
  comemora: ['y.p.b', '.b.y.', 'p.y.p', '.y.b.'],
  // Gota de suor.
  nervoso: ['.b.', 'bbb', 'bbb', '.b.'],
  // Rabisco de bronca.
  frustrado: ['rk.kr', '.kkk.', 'kr.rk'],
  // Suspiro.
  aliviado: ['..ss', '.s..', 'ss..']
}

export function reactionBubbleRows(kind: ReactionKind): string[] {
  const inner = REACTION_FACES[kind].map((r) => 'E' + r.replace(/\./g, 'W') + 'E')
  return ['EEEEEEEEE', ...inner, 'EEEEEEEEE', '....E....']
}

export function reactionPalette(pal: OfficePalette): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, token] of Object.entries(REACTION_KEYS)) out[k] = pal[token]
  return out
}

/** Gera todos uma vez: o cache do renderer é por identidade do sprite. */
export function buildReactionSprites(pal: OfficePalette): Map<ReactionKind, ReactionSprites> {
  const p = reactionPalette(pal)
  return new Map(
    REACTION_KINDS.map((k) => [k, { bubble: parseSprite(reactionBubbleRows(k), p), prop: parseSprite(REACTION_PROPS[k], p) }])
  )
}
