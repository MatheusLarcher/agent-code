/**
 * Aparência dos personagens do Escritório 3D — camisa, pele, cabelo e calça
 * saem da seed (FNV-1a), estáveis por conversa/trilha.
 */
import { Color } from 'three'

export const SKIN = [0xf3d2b3, 0xe0b28c, 0xc68e63, 0x9a6440, 0x6e4529]
export const HAIR = [0x1d1a17, 0x4a2f1d, 0x8a5a2b, 0xd8b26a, 0xb5482c, 0x9aa0a8, 0x2c3e6b]

export interface Appearance {
  shirtHue: number
  skin: number
  hair: number
  pants: number
}

/** Aparência estável por seed (FNV-1a). */
export function appearance(seed: string): Appearance {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const u = h >>> 0
  return { shirtHue: u % 360, skin: (u >>> 9) % SKIN.length, hair: (u >>> 13) % HAIR.length, pants: (u >>> 17) % 4 }
}

/** Cor da camisa por seed. */
export function seedColor(seed: string): Color {
  return new Color().setHSL(appearance(seed).shirtHue / 360, 0.55, 0.52)
}
