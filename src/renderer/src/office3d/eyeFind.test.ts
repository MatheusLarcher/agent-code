import { describe, expect, it } from 'vitest'
import { findEyes, lidsClosed, STRIDE } from './eyeFind'

type RGB = [number, number, number]
const SKIN: RGB = [0.95, 0.68, 0.55]
const WHITE: RGB = [0.92, 0.9, 0.88]
const IRIS: RGB = [0.15, 0.1, 0.08]
const BROW: RGB = [0.25, 0.15, 0.1]
const GRAY_HAIR: RGB = [0.75, 0.75, 0.74]

/**
 * Uma cabeça de mentira (m, rosto para −Z): o plano do rosto em z = −0,1 com a pele, os olhos (branco com a íris
 * no meio) em (±0,045; 1,5), as sobrancelhas acima e, atrás, a nuca (para a caixa da cabeça ter fundo).
 */
function head(paint: (x: number, y: number) => RGB | null = () => null): number[] {
  const s: number[] = []
  const push = (x: number, y: number, z: number, nz: number, c: RGB): void => {
    s.push(x, y, z, 0, 0, nz, ...c)
  }
  for (let x = -0.11; x <= 0.11; x += 0.0015) {
    for (let y = 1.35; y <= 1.7; y += 0.0015) {
      push(x, y, 0.1, 1, [0.2, 0.15, 0.1])
      let c = paint(x, y) ?? SKIN
      for (const ex of [-0.045, 0.045]) {
        const d = ((x - ex) / 0.022) ** 2 + ((y - 1.5) / 0.012) ** 2
        if (d < 1) c = Math.abs(x - ex) < 0.007 ? IRIS : WHITE
        if (Math.abs(x - ex) < 0.025 && y > 1.522 && y < 1.53) c = BROW
      }
      push(x, y, -0.1, -1, c)
    }
  }
  return s
}

describe('olhos pintados na textura', () => {
  it('acha os dois olhos, a pele e o tamanho do olho', () => {
    const r = findEyes(head())
    expect(r).not.toBeNull()
    const [a, b] = r!.eyes
    expect(a.x).toBeCloseTo(-0.045, 2)
    expect(b.x).toBeCloseTo(0.045, 2)
    for (const e of [a, b]) {
      expect(e.y).toBeCloseTo(1.5, 2)
      expect(e.z).toBeCloseTo(-0.1, 3)
      expect(e.rx).toBeGreaterThan(0.018)
      expect(e.rx).toBeLessThan(0.03)
      expect(e.ry).toBeLessThan(e.rx)
    }
    r!.skin.forEach((c, i) => expect(c).toBeCloseTo(SKIN[i], 2))
  })

  it('cabelo grisalho num lado só (claro e sem cor, como o branco do olho) não vira olho', () => {
    const r = findEyes(head((x, y) => (x < -0.07 && y > 1.56 ? GRAY_HAIR : null)))
    expect(r).not.toBeNull()
    expect(r!.eyes[0].y).toBeCloseTo(1.5, 2)
    expect(r!.eyes[1].y).toBeCloseTo(1.5, 2)
  })

  it('sem olho pintado (rosto liso) não inventa pálpebra', () => {
    const s = head()
    for (let i = 0; i < s.length; i += STRIDE) if (s[i + 5] < 0) s.splice(i + 6, 3, ...SKIN)
    expect(findEyes(s)).toBeNull()
  })

  it('a pálpebra só fecha com o olho fechado de vez (o cochilo), não no piscar nem no franzido', () => {
    expect(lidsClosed(0)).toBe(true)
    expect(lidsClosed(0.2)).toBe(false)
    expect(lidsClosed(1)).toBe(false)
  })
})
