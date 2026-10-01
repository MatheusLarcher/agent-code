import type { CrewRole } from '../../crew'
import type { CharacterLook } from '../engine/types'
import { PALETTE } from './palette'

/**
 * Cor da roupa = cor do papel no painel Equipe. Tem de bater com as variáveis
 * --crew-* de styles.css (um teste lê o CSS e compara; se divergir, o CSS manda).
 */
export const ROLE_COLORS: Readonly<Record<CrewRole, string>> = {
  principal: '#d97757',
  executor: '#6f9bd1',
  critico: '#a98bd1',
  'navegador-de-codigo': '#6fbdad',
  memoria: '#c98bb8',
  po: '#7fae6f',
  vigia: '#e0a458',
  subagente: '#8d8a86'
}

/** Cabelos possíveis (do protótipo). */
export const HAIR_COLORS: readonly string[] = ['#6b4423', '#1b1b1b', '#d9b36c', '#2b1d0e', '#3a2a1a', '#8a3b1e']

/** Tons de pele possíveis (do protótipo). */
export const SKIN_COLORS: readonly string[] = ['#f1c27d', '#8d5524', '#e0ac69', '#c68642', '#ffdbac']

/** FNV-1a de 32 bits: estável entre execuções, sem depender de Math.random. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Aparência do personagem: roupa pela cor do papel, cabelo e pele sorteados
 * deterministicamente pela seed (mesma conversa → mesma aparência).
 */
export function lookFor(role: CrewRole, seed: string): CharacterLook {
  const h = hashSeed(seed)
  return {
    hair: HAIR_COLORS[h % HAIR_COLORS.length],
    // Bits altos para a pele não andar junto com o cabelo.
    skin: SKIN_COLORS[(h >>> 16) % SKIN_COLORS.length],
    outfit: ROLE_COLORS[role] ?? ROLE_COLORS.subagente,
    legs: PALETTE.legs
  }
}
