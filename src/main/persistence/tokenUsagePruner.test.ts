// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenUsagePruner, TOKEN_USAGE_PRUNE_INTERVAL_MS, TOKEN_USAGE_RETENTION_DAYS } from './tokenUsagePruner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TokenUsagePruner', () => {
  it('poda logo ao iniciar, com a janela de retenção de 15 dias, e repete a cada 24h', async () => {
    vi.useFakeTimers()
    const deleteLlmCallsOlderThan = vi.fn(async (_days: number) => undefined)
    new TokenUsagePruner({ deleteLlmCallsOlderThan }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(1)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledWith(TOKEN_USAGE_RETENTION_DAYS)
    expect(TOKEN_USAGE_RETENTION_DAYS).toBe(15)

    await vi.advanceTimersByTimeAsync(TOKEN_USAGE_PRUNE_INTERVAL_MS - 1)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(2)
  })

  it('poda linhas velhas e preserva linhas recentes', async () => {
    // O pruner não decide "qual linha": delega ao backend via deleteLlmCallsOlderThan(days).
    // Aqui simulamos um backend real em memória para provar o filtro por idade.
    const now = new Date('2026-09-19T00:00:00.000Z').getTime()
    const rows = [
      { id: 'old', created_at: new Date(now - 16 * 24 * 60 * 60_000).toISOString() },
      { id: 'boundary', created_at: new Date(now - 15 * 24 * 60 * 60_000 - 1).toISOString() },
      { id: 'recent', created_at: new Date(now - 1 * 24 * 60 * 60_000).toISOString() }
    ]
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const db = {
      deleteLlmCallsOlderThan: async (days: number) => {
        const cutoff = now - days * 24 * 60 * 60_000
        for (let i = rows.length - 1; i >= 0; i--) {
          if (Date.parse(rows[i].created_at) < cutoff) rows.splice(i, 1)
        }
      }
    }
    new TokenUsagePruner(db).start()
    await vi.advanceTimersByTimeAsync(0)

    expect(rows.map((row) => row.id)).toEqual(['recent'])
  })

  it('uma falha só loga e tenta de novo no próximo ciclo — nunca propaga', async () => {
    vi.useFakeTimers()
    const failure = new Error('connection terminated')
    const deleteLlmCallsOlderThan = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const onError = vi.fn()
    new TokenUsagePruner({ deleteLlmCallsOlderThan }, onError).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(1)

    // Agenda o próximo ciclo mesmo depois da falha.
    await vi.advanceTimersByTimeAsync(TOKEN_USAGE_PRUNE_INTERVAL_MS)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stop() cancela a poda seguinte', async () => {
    vi.useFakeTimers()
    const deleteLlmCallsOlderThan = vi.fn(async () => undefined)
    const pruner = new TokenUsagePruner({ deleteLlmCallsOlderThan }).start()

    await vi.advanceTimersByTimeAsync(0)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(1)

    pruner.stop()
    await vi.advanceTimersByTimeAsync(10 * TOKEN_USAGE_PRUNE_INTERVAL_MS)
    expect(deleteLlmCallsOlderThan).toHaveBeenCalledTimes(1)
  })
})
