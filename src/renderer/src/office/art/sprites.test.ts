import { describe, expect, it } from 'vitest'
import { POSE_FRAMES } from '../engine/constants'
import type { CharacterLook, Pose } from '../engine/types'
import { CHARACTER_KEYS, CHARACTER_ROWS, CharacterSprites, parseSprite } from './sprites'

const LOOK: CharacterLook = { hair: '#111', skin: '#eee', outfit: '#d97757', legs: '#222' }

describe('parseSprite', () => {
  it('converte letras em cores, mantém dimensões e trata "." como transparente', () => {
    const s = parseSprite(['a.', '.b', 'ab'], { a: '#f00', b: '#0f0' })
    expect(s).toHaveLength(3)
    expect(s.every((r) => r.length === 2)).toBe(true)
    expect(s[0]).toEqual(['#f00', ''])
    expect(s[1]).toEqual(['', '#0f0'])
  })

  it('letra fora da paleta lança com a letra e a linha', () => {
    expect(() => parseSprite(['aa', 'aX'], { a: '#f00' })).toThrow(/'X'.*linha 1/)
  })

  it('linha com largura diferente lança', () => {
    expect(() => parseSprite(['aa', 'a'], { a: '#f00' })).toThrow(/linha 1/)
  })
})

describe('sprites de personagem', () => {
  const poses = Object.keys(POSE_FRAMES) as Pose[]

  it.each(poses)('%s: quadros = POSE_FRAMES, só letras h/s/b/l, largura constante', (pose) => {
    const frames = CHARACTER_ROWS[pose]
    expect(frames).toHaveLength(POSE_FRAMES[pose])
    for (const rows of frames) {
      const w = rows[0].length
      for (const r of rows) {
        expect(r.length).toBe(w)
        for (const ch of r) expect(['.', ...CHARACTER_KEYS]).toContain(ch)
      }
    }
  })

  it('cacheia por look+pose+quadro (mesma referência) e usa a cor da roupa', () => {
    const c = new CharacterSprites()
    const a = c.get(LOOK, 'walk', 1)
    expect(c.get({ ...LOOK }, 'walk', 1)).toBe(a)
    expect(c.get(LOOK, 'walk', 0)).not.toBe(a)
    expect(a.flat()).toContain('#d97757')
    // Quadro fora do intervalo é reduzido, não quebra.
    expect(c.get(LOOK, 'stand', 3)).toBe(c.get(LOOK, 'stand', 0))
  })
})
