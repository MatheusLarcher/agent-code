import { describe, expect, it } from 'vitest'
import { appearance } from './characters'
import { rng, skyPalette } from './textures'

describe('skyPalette', () => {
  it('noite com estrelas, dia sem, amanhecer e entardecer com sol', () => {
    expect(skyPalette(23).stars).toBe(true)
    expect(skyPalette(3).stars).toBe(true)
    expect(skyPalette(12)).toMatchObject({ stars: false })
    expect(skyPalette(6).sun).not.toBeNull()
    expect(skyPalette(18).sun).not.toBeNull()
    expect(skyPalette(12).top).not.toBe(skyPalette(23).top)
  })
  it('hora fora de 0..23 é normalizada', () => {
    expect(skyPalette(36)).toEqual(skyPalette(12))
    expect(skyPalette(-1)).toEqual(skyPalette(23))
  })
})

describe('rng', () => {
  it('determinístico e em [0, 1)', () => {
    const a = rng(42)
    const b = rng(42)
    for (let i = 0; i < 50; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

describe('appearance', () => {
  it('estável por seed e com índices válidos', () => {
    expect(appearance('conv:1')).toEqual(appearance('conv:1'))
    const seeds = Array.from({ length: 40 }, (_, i) => `conv:${i}`)
    const hues = new Set(seeds.map((s) => appearance(s).shirtHue))
    expect(hues.size).toBeGreaterThan(20)
    for (const s of seeds) {
      const a = appearance(s)
      expect(a.skin).toBeLessThan(5)
      expect(a.hair).toBeLessThan(7)
      expect(a.pants).toBeLessThan(4)
    }
  })
})
