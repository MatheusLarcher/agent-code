import { describe, expect, it, vi } from 'vitest'
import { fetchKimiUsage } from './kimiUsage'

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fetchKimiUsage', () => {
  it('lê 5h e mês da resposta real do /v1/usages', async () => {
    const f = reply(200, {
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: '2026-10-28T01:29:01Z' },
        limit_month_total: { used_ratio: 0, reset_time: '2026-11-28T00:00:00Z' }
      }
    })
    const u = await fetchKimiUsage('k', 'intl', { fetchImpl: f })
    expect(u).toEqual({
      session: { usedRatio: 0.25, resetsAt: Date.parse('2026-10-28T01:29:01Z') },
      month: { usedRatio: 0, resetsAt: Date.parse('2026-11-28T00:00:00Z') }
    })
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://api.kimi.ai/coding/v1/usages')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
  })

  it('sem chave, erro HTTP ou corpo sem janelas: null', async () => {
    expect(await fetchKimiUsage(' ', 'intl', { fetchImpl: reply(200, {}) })).toBeNull()
    expect(await fetchKimiUsage('k', 'intl', { fetchImpl: reply(401, {}) })).toBeNull()
    expect(await fetchKimiUsage('k', 'cn', { fetchImpl: reply(200, { usages: {} }) })).toBeNull()
  })
})
