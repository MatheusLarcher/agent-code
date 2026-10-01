import { POSE_FRAMES } from '../engine/constants'
import type { CharacterLook, Pose, SpriteData } from '../engine/types'

/**
 * Converte um sprite em texto numa matriz de cores. Cada letra é uma chave da
 * paleta; '.' é transparente. Letra fora da paleta é erro de autoria: lança
 * dizendo qual letra e em que linha.
 */
export function parseSprite(rows: readonly string[], pal: Readonly<Record<string, string>>): SpriteData {
  const width = rows.length > 0 ? rows[0].length : 0
  return rows.map((row, j) => {
    if (row.length !== width) {
      throw new Error(`sprite: linha ${j} tem ${row.length} colunas, esperado ${width}`)
    }
    return Array.from(row, (k) => {
      if (k === '.') return ''
      const c = pal[k]
      if (c === undefined) throw new Error(`sprite: letra '${k}' fora da paleta na linha ${j}`)
      return c
    })
  })
}

// Personagem 6 px de largura: h=cabelo s=pele b=roupa l=perna.
const HEAD = ['.hhhh.', 'hhhhhh', 'hssssh', '.ssss.']
const BACK = ['.hhhh.', 'hhhhhh', 'hhhhhh', '.hhhh.']
const BODY = ['bbbbbb', 'sbbbbs', 'sbbbbs', '.bbbb.']
const BODY_BACK = ['bbbbbb', 'bbbbbb', 'bbbbbb', '.bbbb.']
const LEGS_A = ['.l..l.', 'l....l']
const LEGS_B = ['..ll..', '..ll..']
const LEGS_STILL = ['.l..l.', '.l..l.']

/** Quadros de texto por pose; o número de quadros bate com POSE_FRAMES. */
export const CHARACTER_ROWS: Readonly<Record<Pose, readonly (readonly string[])[]>> = {
  stand: [[...HEAD, ...BODY, ...LEGS_STILL]],
  walk: [
    [...HEAD, ...BODY, ...LEGS_A],
    [...HEAD, ...BODY, ...LEGS_B]
  ],
  walkBack: [
    [...BACK, ...BODY_BACK, ...LEGS_A],
    [...BACK, ...BODY_BACK, ...LEGS_B]
  ],
  sit: [[...BACK, ...BODY_BACK]],
  // Digitando: as mãos sobem e descem no teclado.
  sitType: [
    [...BACK, ...BODY_BACK],
    [...BACK, 'sbbbbs', 'bbbbbb', 'bbbbbb', '.bbbb.']
  ],
  // Lendo: mãos paradas segurando o papel, a cabeça desce de leve no 2º quadro.
  sitRead: [
    [...BACK, 'bbbbbb', 'sbbbbs', 'bbbbbb', '.bbbb.'],
    ['......', '.hhhh.', 'hhhhhh', 'hhhhhh', 'sbbbbs', 'bbbbbb', 'bbbbbb', '.bbbb.']
  ]
}

/** Letras que um sprite de personagem pode usar. */
export const CHARACTER_KEYS = ['h', 's', 'b', 'l'] as const

export function characterPalette(look: CharacterLook): Record<string, string> {
  return { h: look.hair, s: look.skin, b: look.outfit, l: look.legs }
}

/**
 * Cache dos sprites de personagem por look+pose+quadro: o renderer cacheia por
 * identidade, então a mesma entrada precisa devolver a mesma matriz.
 */
export class CharacterSprites {
  private cache = new Map<string, SpriteData>()

  get(look: CharacterLook, pose: Pose, frame: number): SpriteData {
    const frames = CHARACTER_ROWS[pose] ?? CHARACTER_ROWS.stand
    const n = Math.max(1, Math.min(frames.length, POSE_FRAMES[pose] ?? 1))
    const f = ((Math.floor(frame) % n) + n) % n
    const key = `${look.hair}|${look.skin}|${look.outfit}|${look.legs}|${pose}|${f}`
    let s = this.cache.get(key)
    if (!s) {
      s = parseSprite(frames[f], characterPalette(look))
      this.cache.set(key, s)
    }
    return s
  }
}
