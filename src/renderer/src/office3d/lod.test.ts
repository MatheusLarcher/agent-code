import { describe, expect, it } from 'vitest'
import { LOD_BOUNDS, LOD_SLACK, lodLevel, type Lod } from './lod'

const [NEAR, FAR] = LOD_BOUNDS

describe('lodLevel', () => {
  it('sem nível anterior: só a fronteira decide', () => {
    expect(lodLevel(0)).toBe(0)
    expect(lodLevel(NEAR - 0.01)).toBe(0)
    expect(lodLevel(NEAR)).toBe(1)
    expect(lodLevel(FAR - 0.01)).toBe(1)
    expect(lodLevel(FAR)).toBe(2)
    expect(lodLevel(1e4)).toBe(2)
  })

  it('histerese: dentro da folga de uma fronteira fica onde está', () => {
    const inside = [NEAR * (1 - LOD_SLACK) + 0.01, NEAR, NEAR * (1 + LOD_SLACK) - 0.01]
    for (const d of inside) {
      expect(lodLevel(d, 0)).toBe(0)
      expect(lodLevel(d, 1)).toBe(1)
    }
    for (const d of [FAR * (1 - LOD_SLACK) + 0.01, FAR, FAR * (1 + LOD_SLACK) - 0.01]) {
      expect(lodLevel(d, 1)).toBe(1)
      expect(lodLevel(d, 2)).toBe(2)
    }
  })

  it('passou da folga: muda (e pode pular dois níveis)', () => {
    expect(lodLevel(NEAR * (1 + LOD_SLACK) + 0.01, 0)).toBe(1)
    expect(lodLevel(NEAR * (1 - LOD_SLACK) - 0.01, 1)).toBe(0)
    expect(lodLevel(FAR * (1 + LOD_SLACK) + 0.01, 1)).toBe(2)
    expect(lodLevel(FAR * (1 - LOD_SLACK) - 0.01, 2)).toBe(1)
    expect(lodLevel(FAR * 2, 0)).toBe(2)
    expect(lodLevel(1, 2)).toBe(0)
  })

  it('câmera tremendo em cima da fronteira não pisca', () => {
    let level: Lod = lodLevel(NEAR - 1)
    const seen = new Set<Lod>()
    for (let i = 0; i < 200; i++) {
      // Oscila ±(folga/2) em volta da fronteira.
      level = lodLevel(NEAR + Math.sin(i) * NEAR * LOD_SLACK * 0.5, level)
      seen.add(level)
    }
    expect([...seen]).toEqual([0])
    // Afastou de verdade: muda uma vez e fica.
    level = lodLevel(NEAR * 1.5, level)
    for (let i = 0; i < 200; i++) {
      level = lodLevel(NEAR + Math.sin(i) * NEAR * LOD_SLACK * 0.5, level)
      seen.add(level)
    }
    expect(level).toBe(1)
    expect([...seen].sort()).toEqual([0, 1])
  })

  it('distância inválida não troca de nível', () => {
    expect(lodLevel(Number.NaN, 1)).toBe(1)
    expect(lodLevel(Number.NaN)).toBe(0)
  })
})
