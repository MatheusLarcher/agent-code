import { describe, expect, it } from 'vitest'
import { createOfficeArt, PALETTE } from '.'
import { projectColor, PROP_ROWS } from './props'

describe('adereços da F4·1-3', () => {
  it('pasta na cor do projeto: mesma cor, mesmo sprite; outra cor, outro sprite', () => {
    const art = createOfficeArt()
    const a = art.propSprite('pasta', '#ff0000')
    expect(art.propSprite('pasta', '#ff0000')).toBe(a)
    expect(art.propSprite('pasta', '#00ff00')).not.toBe(a)
    expect(a.flat()).toContain('#ff0000')
    // Sem cor, a da paleta.
    expect(art.propSprite('pasta').flat()).toContain(PALETTE.amber)
  })

  it('cor do projeto é estável por sala e vem da paleta', () => {
    const c = projectColor('c:/proj/alpha', PALETTE)
    expect(projectColor('c:/proj/alpha', PALETTE)).toBe(c)
    expect(Object.values(PALETTE)).toContain(c)
  })

  it('✓ e ✗ carimbados na pasta e na prancheta', () => {
    const art = createOfficeArt()
    expect(art.propSprite('pasta-ok').flat()).toContain(PALETTE.okGreen)
    expect(art.propSprite('pasta-erro').flat()).toContain(PALETTE.errRed)
    expect(art.propSprite('prancheta-ok').flat()).toContain(PALETTE.okGreen)
    expect(art.propSprite('prancheta-erro').flat()).toContain(PALETTE.errRed)
    // A prancheta leva a lupa (lente).
    expect(art.propSprite('prancheta').flat()).toContain(PALETTE.lens)
    expect(PROP_ROWS.mao.length).toBeGreaterThan(0)
    expect(PROP_ROWS.ficha.length).toBeGreaterThan(0)
  })
})
