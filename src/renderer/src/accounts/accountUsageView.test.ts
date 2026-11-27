import { describe, expect, it } from 'vitest'
import { accountDisplayName, barLimits, readingToLimits, updatedAgo } from './accountUsageView'

const NOW = Date.parse('2026-09-24T12:00:00Z')

describe('readingToLimits', () => {
  it('converte as janelas conhecidas em pílulas, em fração', () => {
    const limits = readingToLimits(
      { at: NOW, windows: { seven_day: { utilization: 88, resetsAt: NOW + 1000 }, five_hour: { utilization: 5, resetsAt: NOW + 1000 }, nimbus: { utilization: 1, resetsAt: null } } },
      NOW
    )
    expect(limits.map((l) => [l.rateLimitType, l.utilization, l.status])).toEqual([
      ['five_hour', 0.05, 'allowed'],
      ['seven_day', 0.88, 'allowed_warning']
    ])
  })
  it('janela já zerada aparece em 0%', () => {
    const [limit] = readingToLimits({ at: NOW, windows: { five_hour: { utilization: 100, resetsAt: NOW - 1 } } }, NOW)
    expect(limit).toMatchObject({ utilization: 0, status: 'allowed' })
    expect(limit.resetsAt).toBeUndefined()
  })
  it('janela só com o horário (sem o número) fica sem utilization, não 0% usado', () => {
    const [limit] = readingToLimits({ at: NOW, windows: { five_hour: { utilization: null, resetsAt: NOW + 1000 } } }, NOW)
    expect(limit).toMatchObject({ rateLimitType: 'five_hour', status: 'allowed', resetsAt: NOW + 1000 })
    expect(limit.utilization).toBeUndefined()
  })
  it('sem leitura, sem pílulas', () => {
    expect(readingToLimits(null)).toEqual([])
  })
})

describe('barLimits (barra do topo)', () => {
  const week = { seven_day: { utilization: 38, resetsAt: NOW + 1000 } }
  const types = (r: ReturnType<typeof barLimits>) => [r.limits.map((l) => l.rateLimitType), r.fiveHourUnread]
  it('five_hour ausente ou só com o horário: fora das pílulas, sem leitura de 5 h', () => {
    expect(types(barLimits({ at: NOW, windows: week }, NOW))).toEqual([['seven_day'], true])
    expect(types(barLimits({ at: NOW, windows: { ...week, five_hour: { utilization: null, resetsAt: NOW + 1000 } } }, NOW))).toEqual([['seven_day'], true])
  })
  it('uso real, 0% real e janela já zerada são leitura', () => {
    for (const five of [{ utilization: 62, resetsAt: NOW + 1000 }, { utilization: 0, resetsAt: null }, { utilization: null, resetsAt: NOW - 1 }]) {
      expect(types(barLimits({ at: NOW, windows: { ...week, five_hour: five } }, NOW))).toEqual([['five_hour', 'seven_day'], false])
    }
  })
  it('conta nunca lida não é "sem leitura de 5 h"', () => {
    expect(barLimits(null)).toEqual({ limits: [], fiveHourUnread: false })
  })
})

describe('nomes e idade da leitura', () => {
  it('apelido, e-mail ou Conta N', () => {
    expect(accountDisplayName({ label: 'Trabalho', email: 'a@b.c' }, 0)).toBe('Trabalho')
    expect(accountDisplayName({ label: '', email: 'a@b.c' }, 0)).toBe('a@b.c')
    expect(accountDisplayName({ label: '', email: null }, 1)).toBe('Conta 2')
  })
  it('atualizado há X min', () => {
    expect(updatedAgo(NOW, NOW)).toBe('atualizado agora')
    expect(updatedAgo(NOW - 5 * 60_000, NOW)).toBe('atualizado há 5 min')
    expect(updatedAgo(NOW - 3 * 3_600_000, NOW)).toBe('atualizado há 3 h')
  })
})
