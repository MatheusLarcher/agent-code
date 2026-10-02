import { describe, expect, it } from 'vitest'
import { CENTRAL_PALETTE, centralColor } from './centralColor'

/** O laranja do app: exclusivo da Central (a cor dos destinos nunca pode parecer ele). */
const ACCENT = '#d97757'

/** Matiz (0–360°) de uma cor `#rrggbb`. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/** Distância angular entre dois matizes (0–180°). */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

describe('CENTRAL_PALETTE', () => {
  it('são exatamente estas 8 cores, nesta ordem', () => {
    expect([...CENTRAL_PALETTE]).toEqual([
      '#7fb3d5', // azul
      '#c39bd3', // roxo
      '#8fc89a', // verde
      '#e0cf7a', // amarelo
      '#6cc4c0', // turquesa
      '#e39bc1', // rosa
      '#a3c46c', // lima
      '#9aa8e8' // lavanda
    ])
  })

  it('nenhuma é o laranja do app', () => {
    expect(CENTRAL_PALETTE.map((c) => c.toLowerCase())).not.toContain(ACCENT)
  })

  it('todo matiz da paleta fica a 30° ou mais do matiz do laranja (≈15°)', () => {
    const accent = hue(ACCENT)
    expect(accent).toBeGreaterThan(10)
    expect(accent).toBeLessThan(20)
    for (const color of CENTRAL_PALETTE) {
      expect(hueGap(hue(color), accent), `${color} perto demais do laranja`).toBeGreaterThanOrEqual(30)
    }
  })
})

describe('centralColor', () => {
  it('a mesma conversa tem sempre a mesma cor', () => {
    const first = centralColor('conv-1')
    for (let i = 0; i < 20; i++) expect(centralColor('conv-1')).toBe(first)
    // O valor é o que conta, não a identidade da string.
    expect(centralColor(['conv', '1'].join('-'))).toBe(first)
  })

  it('sempre devolve uma cor da paleta, seja qual for o id', () => {
    for (const id of ['', 'a', 'central', 'conv-ção-ã', '🙂', 'x'.repeat(5000)]) {
      expect(CENTRAL_PALETTE).toContain(centralColor(id))
    }
  })

  it('mil ids usam todas as cores, sem nenhuma dominar', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `conv-${i}`)
    const uses = new Map<string, number>()
    for (const id of ids) uses.set(centralColor(id), (uses.get(centralColor(id)) ?? 0) + 1)
    expect(new Set(uses.keys())).toEqual(new Set(CENTRAL_PALETTE))
    // 1000 / 8 = 125 por cor; folga larga, só para pegar um hash torto.
    for (const [color, n] of uses) {
      expect(n, `${color} usada ${n}x`).toBeGreaterThan(60)
      expect(n, `${color} usada ${n}x`).toBeLessThan(220)
    }
  })

  it('ids parecidos (só o último dígito muda) não caem todos na mesma cor', () => {
    const colors = new Set(Array.from({ length: 10 }, (_, i) => centralColor(`c-170000000000${i}`)))
    expect(colors.size).toBeGreaterThan(3)
  })
})
