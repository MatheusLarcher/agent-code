import { describe, expect, it } from 'vitest'
import { REACTION_KINDS } from '../engine/types'
import { bubbleRows } from './bubbles'
import { createOfficeArt } from './index'
import { REACTION_FACES, REACTION_KEYS, REACTION_PROPS, reactionBubbleRows } from './reactions'

describe('sprites de reação', () => {
  it.each(REACTION_KINDS)('%s: rosto 7×5, adereço retangular e só letras da paleta', (kind) => {
    const face = REACTION_FACES[kind]
    expect(face).toHaveLength(5)
    for (const r of face) expect(r).toHaveLength(7)
    const prop = REACTION_PROPS[kind]
    for (const r of prop) expect(r).toHaveLength(prop[0].length)
    for (const rows of [face, prop]) for (const r of rows) for (const c of r) if (c !== '.') expect(REACTION_KEYS).toHaveProperty(c)
  })

  it('balão de reação tem o mesmo formato dos balões de estado', () => {
    const ref = bubbleRows('ok')
    for (const k of REACTION_KINDS) {
      const rows = reactionBubbleRows(k)
      expect(rows).toHaveLength(ref.length)
      expect(rows[0]).toHaveLength(ref[0].length)
    }
  })

  it('a arte devolve sempre a mesma referência (cache por identidade) e rostos distintos', () => {
    const art = createOfficeArt()
    const seen = new Set<string>()
    for (const k of REACTION_KINDS) {
      const a = art.reactionSprites!(k)
      expect(art.reactionSprites!(k)).toBe(a)
      expect(a.prop).not.toBeNull()
      seen.add(JSON.stringify(a.bubble))
    }
    expect(seen.size).toBe(REACTION_KINDS.length)
  })
})
