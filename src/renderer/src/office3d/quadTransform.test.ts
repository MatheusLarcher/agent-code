import { describe, expect, it } from 'vitest'
import { quadMatrix3d, type Pt } from './quadTransform'

type Quad = [Pt, Pt, Pt, Pt]

/** Os 16 números do matrix3d (column-major). */
function parse(s: string | null): number[] {
  const m = /^matrix3d\((.+)\)$/.exec(s ?? '')
  if (!m) throw new Error(`não é matrix3d: ${s}`)
  const n = m[1].split(',').map(Number)
  expect(n).toHaveLength(16)
  return n
}

/** Leva o ponto (X, Y) do elemento pelo matrix3d, com a divisão da perspectiva (como o navegador). */
function apply(m: number[], X: number, Y: number): Pt {
  const w = m[3] * X + m[7] * Y + m[15]
  return { x: (m[0] * X + m[4] * Y + m[12]) / w, y: (m[1] * X + m[5] * Y + m[13]) / w }
}

/** Maior erro (px) entre os cantos do retângulo transformados e os 4 pontos. */
function cornerError(w: number, h: number, quad: Quad): number {
  const m = parse(quadMatrix3d(w, h, quad))
  const rect: Array<[number, number]> = [[0, 0], [w, 0], [w, h], [0, h]]
  return Math.max(
    ...rect.map(([X, Y], i) => {
      const p = apply(m, X, Y)
      return Math.hypot(p.x - quad[i].x, p.y - quad[i].y)
    })
  )
}

/** Cruzamento das diagonais TL–BR e TR–BL. */
function diagonals(q: Quad): Pt {
  const [a, b, c, d] = q
  const t = ((d.x - a.x) * (b.y - d.y) - (d.y - a.y) * (b.x - d.x)) / ((c.x - a.x) * (b.y - d.y) - (c.y - a.y) * (b.x - d.x))
  return { x: a.x + t * (c.x - a.x), y: a.y + t * (c.y - a.y) }
}

describe('quadMatrix3d: retângulo do elemento → 4 pontos do palco', () => {
  it('quadrilátero qualquer (perspectiva): os 4 cantos caem nos pontos e o meio no cruzamento das diagonais', () => {
    const quad: Quad = [{ x: 103.5, y: 77.25 }, { x: 910.2, y: 60.1 }, { x: 870.7, y: 590.3 }, { x: 140.9, y: 610.8 }]
    expect(cornerError(640, 360, quad)).toBeLessThan(1e-6)
    const mid = apply(parse(quadMatrix3d(640, 360, quad)), 320, 180)
    const x = diagonals(quad)
    expect(Math.hypot(mid.x - x.x, mid.y - x.y)).toBeLessThan(1e-6)
    // Trapézio do keystone (borda de cima mais larga): também.
    expect(cornerError(1187, 671, [{ x: 92, y: 60 }, { x: 1308, y: 60 }, { x: 1279, y: 742 }, { x: 121, y: 742 }])).toBeLessThan(1e-6)
  })

  it('quad = o próprio retângulo: identidade; deslocado: só a translação', () => {
    const id = parse(quadMatrix3d(400, 300, [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }]))
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    id.forEach((v, i) => expect(v).toBeCloseTo(I[i], 12))
    const moved = parse(quadMatrix3d(400, 300, [{ x: 30, y: 40 }, { x: 430, y: 40 }, { x: 430, y: 340 }, { x: 30, y: 340 }]))
    moved.forEach((v, i) => expect(v).toBeCloseTo(i === 12 ? 30 : i === 13 ? 40 : I[i], 12))
  })

  it('paralelogramo (afim): sem termo de perspectiva, cantos exatos e o meio no meio', () => {
    const quad: Quad = [{ x: 10, y: 20 }, { x: 410, y: 60 }, { x: 460, y: 360 }, { x: 60, y: 320 }]
    const m = parse(quadMatrix3d(800, 450, quad))
    expect(Math.abs(m[3])).toBeLessThan(1e-12)
    expect(Math.abs(m[7])).toBeLessThan(1e-12)
    expect(cornerError(800, 450, quad)).toBeLessThan(1e-6)
    const mid = apply(m, 400, 225)
    expect(mid.x).toBeCloseTo(235, 9)
    expect(mid.y).toBeCloseTo(190, 9)
  })

  it('degenerado: null (tamanho, valor não finito, cantos alinhados, quadrilátero cruzado)', () => {
    const ok: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]
    expect(quadMatrix3d(0, 50, ok)).toBeNull()
    expect(quadMatrix3d(100, -1, ok)).toBeNull()
    expect(quadMatrix3d(Number.NaN, 50, ok)).toBeNull()
    expect(quadMatrix3d(100, 50, [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }])).toBeNull()
    expect(quadMatrix3d(100, 50, [{ x: 0, y: 0 }, { x: Infinity, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }])).toBeNull()
    // TR, BR e BL na mesma reta; tudo num ponto só.
    expect(quadMatrix3d(100, 50, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0 }])).toBeNull()
    expect(quadMatrix3d(100, 50, [{ x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }])).toBeNull()
    // Gravata-borboleta (TR e BR trocados): passaria pelo infinito.
    expect(quadMatrix3d(100, 50, [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 0 }, { x: 0, y: 50 }])).toBeNull()
  })
})
