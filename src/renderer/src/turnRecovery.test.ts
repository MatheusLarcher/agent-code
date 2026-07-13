import { describe, expect, it } from 'vitest'
import { MAX_GENERIC_RETRIES, parseResetFromError, scheduleFailure } from './turnRecovery'

describe('turnRecovery', () => {
  it('interpreta reset com horário e fuso e adiciona um minuto', () => {
    const now = Date.parse('2026-07-13T02:00:00.000Z') // 23:00 do dia anterior em São Paulo
    const parsed = parseResetFromError("You've hit your session limit · resets 12:20am (America/Sao_Paulo)", now)
    expect(parsed).toBe(Date.parse('2026-07-13T03:20:00.000Z'))
    expect(scheduleFailure("You've hit your session limit · resets 12:20am (America/Sao_Paulo)", {}, now)).toEqual({
      reason: 'limit',
      scheduledAt: Date.parse('2026-07-13T03:21:00.000Z')
    })
  })

  it('usa o próximo reset conhecido quando o texto não traz horário', () => {
    const now = 1_000_000
    expect(
      scheduleFailure('rate_limit_error', { five_hour: { rateLimitType: 'five_hour', status: 'rejected', resetsAt: now + 5_000 } }, now)
    ).toEqual({ reason: 'limit', scheduledAt: now + 65_000 })
  })

  it('agenda erro comum para um minuto e limita a cinco tentativas', () => {
    expect(scheduleFailure('socket disconnected', {}, 100)).toEqual({ reason: 'transient', scheduledAt: 60_100 })
    expect(MAX_GENERIC_RETRIES).toBe(5)
  })

  it('move horário já passado para o dia seguinte', () => {
    const now = Date.parse('2026-07-13T04:00:00.000Z') // 01:00 em São Paulo
    expect(parseResetFromError('resets 12:20am (America/Sao_Paulo)', now)).toBe(Date.parse('2026-07-14T03:20:00.000Z'))
  })
})
