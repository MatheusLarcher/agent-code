import { describe, expect, it } from 'vitest'
import { accountDisplayName, readingToLimits, updatedAgo } from './accountUsageView'

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
  it('sem leitura, sem pílulas', () => {
    expect(readingToLimits(null)).toEqual([])
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
