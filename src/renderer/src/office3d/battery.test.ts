import { describe, expect, it } from 'vitest'
import { BATTERY_COLORS, batteryLevel, contextBattery, formatResetIn, sessionBattery } from './battery'

describe('batteryLevel', () => {
  it('verde acima de 50%, amarelo acima de 20%, vermelho no resto', () => {
    expect(batteryLevel(0.51).level).toBe('high')
    expect(batteryLevel(0.5).level).toBe('mid')
    expect(batteryLevel(0.21).level).toBe('mid')
    expect(batteryLevel(0.2).level).toBe('low')
    expect(batteryLevel(0).level).toBe('low')
    expect(batteryLevel(0.9).color).toBe(BATTERY_COLORS.high)
  })

  it('prende a carga em 0..1 e trata NaN como vazia', () => {
    expect(batteryLevel(1.7).charge).toBe(1)
    expect(batteryLevel(-3).charge).toBe(0)
    expect(batteryLevel(NaN).charge).toBe(0)
  })
})

describe('contextBattery', () => {
  it('carga = contexto restante (1 - tokens/max)', () => {
    const b = contextBattery({ tokens: 150_000, max: 200_000 })!
    expect(b.charge).toBeCloseTo(0.25)
    expect(b.level).toBe('mid')
    expect(contextBattery({ tokens: 10_000, max: 200_000 })!.level).toBe('high')
    expect(contextBattery({ tokens: 190_000, max: 200_000 })!.level).toBe('low')
  })

  it('sem dado ou limite inválido: null', () => {
    expect(contextBattery(undefined)).toBeNull()
    expect(contextBattery({ tokens: 10, max: 0 })).toBeNull()
  })
})

describe('formatResetIn', () => {
  const now = 1_000_000
  it('minutos, horas e horas com minutos', () => {
    expect(formatResetIn(now + 12 * 60_000, now)).toBe('recarrega em 12min')
    expect(formatResetIn(now + 120 * 60_000, now)).toBe('recarrega em 2h')
    expect(formatResetIn(now + 133 * 60_000, now)).toBe('recarrega em 2h 13min')
  })
  it('sem horário ou já passou: vazio', () => {
    expect(formatResetIn(undefined, now)).toBe('')
    expect(formatResetIn(now - 1, now)).toBe('')
  })
})

describe('sessionBattery', () => {
  const now = 5_000_000
  it('usa a janela five_hour: restante, usado e reset', () => {
    const b = sessionBattery({ five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.37, resetsAt: now + 45 * 60_000 } }, now)!
    expect(b.percent).toBe(63)
    expect(b.usedPercent).toBe(37)
    expect(b.level).toBe('high')
    expect(b.resetText).toBe('recarrega em 45min')
  })

  it('rejeitada fica vazia e vermelha', () => {
    const b = sessionBattery({ five_hour: { rateLimitType: 'five_hour', status: 'rejected' } }, now)!
    expect(b.percent).toBe(0)
    expect(b.level).toBe('low')
    expect(b.rejected).toBe(true)
  })

  it('sem a janela de 5h (ou sem utilização): null — o HUD some', () => {
    expect(sessionBattery(undefined, now)).toBeNull()
    expect(sessionBattery({}, now)).toBeNull()
    expect(sessionBattery({ seven_day: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.5 } }, now)).toBeNull()
    expect(sessionBattery({ five_hour: { rateLimitType: 'five_hour', status: 'allowed' } }, now)).toBeNull()
  })
})
