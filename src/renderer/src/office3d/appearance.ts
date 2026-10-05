/**
 * Aparência dos personagens do Escritório 3D — camisa, pele, cabelo (cor e
 * corte), calça, manga e constituição saem da seed (FNV-1a), estáveis por
 * conversa/trilha.
 */
import { Color } from 'three'
import { HAIR_STYLES, type HairStyle } from './bodyGeo'

export const SKIN = [0xf1d0b5, 0xe2b896, 0xc99470, 0xa86f4c, 0x7d4f33, 0x5c3a26]
export const HAIR = [0x1d1a17, 0x3b2a1e, 0x5a3a22, 0x8a5a2b, 0xc79a5a, 0xa2442a, 0x8d9096, 0x2a2523]

export interface Appearance {
  shirtHue: number
  skin: number
  hair: number
  pants: number
  /** Corte de cabelo (bodyGeo.ts). */
  hairStyle: HairStyle
  /** Manga comprida (o antebraço é da camisa) ou curta. */
  longSleeves: boolean
  /** Ombros e tronco: 0,94 … 1,06. */
  build: number
}

/** Aparência estável por seed (FNV-1a). */
export function appearance(seed: string): Appearance {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const u = h >>> 0
  // Uma segunda mistura para os traços novos não andarem junto com as cores.
  const v = Math.imul(u ^ (u >>> 15), 0x2c1b3c6d) >>> 0
  return {
    shirtHue: u % 360,
    skin: (u >>> 9) % SKIN.length,
    hair: (u >>> 13) % HAIR.length,
    pants: (u >>> 17) % 4,
    hairStyle: HAIR_STYLES[v % HAIR_STYLES.length],
    longSleeves: ((v >>> 7) & 1) === 1,
    build: 0.94 + (((v >>> 11) % 13) / 12) * 0.12
  }
}

/** Cor da camisa por seed. */
export function seedColor(seed: string): Color {
  return new Color().setHSL(appearance(seed).shirtHue / 360, 0.55, 0.52)
}

/**
 * A mesma cor da camisa em CSS (o ponto do agente no chat do escritório). Sai
 * da própria Color da camisa: o setHSL dela vale no espaço de trabalho (linear)
 * do three, e o getStyle a devolve em sRGB — a cor que a tela mostra. Um
 * `hsl()` com os mesmos números seria outra cor.
 */
export function seedCss(seed: string): string {
  return seedColor(seed).getStyle()
}
