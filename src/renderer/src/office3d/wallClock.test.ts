import { describe, expect, it } from 'vitest'
import { clockFace } from './wallClock'

describe('relógio de parede do escritório', () => {
  it('hora e minuto com dois dígitos, data em português e a barra do dia', () => {
    const f = clockFace(new Date(2026, 9, 5, 9, 7))
    expect([f.hh, f.mm]).toEqual(['09', '07'])
    expect(f.date).toBe('SEG · 05 OUT')
    expect(f.greeting).toBe('bom dia')
    expect(f.day).toBeCloseTo((9 * 60 + 7) / 1440)
  })

  it('a saudação acompanha a hora', () => {
    expect(clockFace(new Date(2026, 9, 5, 4, 59)).greeting).toBe('boa noite')
    expect(clockFace(new Date(2026, 9, 5, 12, 0)).greeting).toBe('boa tarde')
    expect(clockFace(new Date(2026, 9, 5, 18, 0)).greeting).toBe('boa noite')
  })

  it('só pede redesenho quando o minuto (ou o dia) muda', () => {
    const a = clockFace(new Date(2026, 9, 5, 21, 40, 1))
    const b = clockFace(new Date(2026, 9, 5, 21, 40, 59))
    const c = clockFace(new Date(2026, 9, 5, 21, 41, 0))
    expect(a.key).toBe(b.key)
    expect(c.key).not.toBe(a.key)
    expect(clockFace(new Date(2026, 9, 6, 21, 40)).key).not.toBe(a.key)
  })
})
