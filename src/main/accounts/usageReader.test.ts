import { describe, expect, it } from 'vitest'
import type { AccountUsageReading, UsageWindow } from '../../shared/claudeAccounts'
import { createUsageReader } from './usageReader'

const NOW = 1_800_000_000_000
const SOON = NOW + 3_600_000
const WEEK = NOW + 3 * 86_400_000

function setup(windows: Record<string, UsageWindow>, previous: AccountUsageReading | null) {
  const store = new Map<string, AccountUsageReading>(previous ? [['a', previous]] : [])
  const reader = createUsageReader({ fetchWindows: async () => windows, load: (id) => store.get(id) ?? null, save: (id, r) => store.set(id, r), now: () => NOW })
  return { reader, store }
}

describe('createUsageReader — leitura que vem sem a janela de 5 h', () => {
  it('não apaga a janela de 5 h que a sessão gravou (a API manda five_hour: null)', async () => {
    const { reader, store } = setup({ seven_day: { utilization: 40, resetsAt: WEEK } }, { at: NOW - 120_000, windows: { five_hour: { utilization: 55, resetsAt: SOON } } })
    const { reading } = await reader.read('a')
    expect(reading?.windows).toEqual({ five_hour: { utilization: 55, resetsAt: SOON }, seven_day: { utilization: 40, resetsAt: WEEK } })
    expect(store.get('a')?.at).toBe(NOW)
  })

  it('janela antiga que já venceu (ou sem horário) não fica de herança', async () => {
    const old = { five_hour: { utilization: 55, resetsAt: NOW - 1 }, sonnet: { utilization: 5, resetsAt: null } }
    const { reader } = setup({ seven_day: { utilization: 40, resetsAt: WEEK } }, { at: NOW - 120_000, windows: old })
    expect((await reader.read('a')).reading?.windows).toEqual({ seven_day: { utilization: 40, resetsAt: WEEK } })
  })

  it('janela que veio na consulta substitui a antiga', async () => {
    const { reader } = setup({ five_hour: { utilization: 10, resetsAt: SOON } }, { at: NOW - 120_000, windows: { five_hour: { utilization: 55, resetsAt: SOON } } })
    expect((await reader.read('a')).reading?.windows.five_hour?.utilization).toBe(10)
  })
})
