import { describe, expect, it, vi } from 'vitest'
import type { AccountUsageReading } from '../../shared/claudeAccounts'
import { accountForConversation, chooseAccountForNewConversation, type AccountCandidate } from './selection'
import {
  accountConsumption,
  mergeReading,
  windowFromRateLimitEvent,
  windowsFromUsage
} from './usageMath'
import { createUsageReader } from './usageReader'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const FUTURE = NOW + 3_600_000
const PAST = NOW - 1_000

function reading(windows: Record<string, [number | null, number | null]>): AccountUsageReading {
  return {
    at: NOW,
    windows: Object.fromEntries(
      Object.entries(windows).map(([key, [utilization, resetsAt]]) => [key, { utilization, resetsAt }])
    )
  }
}

describe('windowsFromUsage (contrato da API experimental)', () => {
  // Recorte real de `usage_EXPERIMENTAL…({ skipBehaviors: true })` no SDK 0.3.281.
  const sample = {
    five_hour: { utilization: 1, resets_at: '2026-09-25T05:09:59.648143+00:00', limit_dollars: null },
    seven_day: { utilization: 88, resets_at: '2026-09-27T01:59:59.648216+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 40, resets_at: '2026-09-27T01:59:59.648216+00:00' },
    seven_day_cowork: { utilization: 99, resets_at: '2026-09-27T01:59:59.648216+00:00' },
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, utilization: null },
    spend: { percent: 0 },
    model_scoped: [{ display_name: 'Fable', utilization: 1, resets_at: '2026-09-27T01:59:59.648561+00:00' }]
  }

  it('lê as janelas conhecidas, as novas e as por modelo', () => {
    const windows = windowsFromUsage(sample)
    expect(windows.five_hour).toEqual({ utilization: 1, resetsAt: Date.parse('2026-09-25T05:09:59.648143+00:00') })
    expect(windows.seven_day?.utilization).toBe(88)
    expect(windows.seven_day_sonnet?.utilization).toBe(40)
    expect(windows.nimbus_quill).toEqual({ utilization: 0, resetsAt: null })
    expect(windows['model:fable']?.utilization).toBe(1)
  })

  it('ignora o que não é limite do Claude Code', () => {
    const windows = windowsFromUsage(sample)
    expect(windows.extra_usage).toBeUndefined()
    expect(windows.spend).toBeUndefined()
    expect(windows.seven_day_cowork).toBeUndefined()
    expect(windows.seven_day_opus).toBeUndefined()
  })

  it('falha quando o formato muda (cai na última leitura)', () => {
    expect(() => windowsFromUsage(null)).toThrow()
    expect(() => windowsFromUsage({ outra_coisa: 1 })).toThrow()
  })
})

describe('windowFromRateLimitEvent', () => {
  it('converte fração em % e segundos em ms', () => {
    expect(windowFromRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1_790_000_000 })).toEqual({
      key: 'five_hour',
      window: { utilization: 50, resetsAt: 1_790_000_000_000 }
    })
  })
  it('estouro sem número vale 100%', () => {
    expect(windowFromRateLimitEvent({ rateLimitType: 'seven_day', status: 'rejected' })?.window.utilization).toBe(100)
  })
  it('ignora overage e evento sem tipo', () => {
    expect(windowFromRateLimitEvent({ rateLimitType: 'overage', utilization: 1 })).toBeNull()
    expect(windowFromRateLimitEvent({ utilization: 1 })).toBeNull()
  })
  it('junta a janela nova à leitura anterior', () => {
    const merged = mergeReading(reading({ seven_day: [30, FUTURE] }), { five_hour: { utilization: 10, resetsAt: FUTURE } }, NOW + 5)
    expect(Object.keys(merged.windows).sort()).toEqual(['five_hour', 'seven_day'])
    expect(merged.at).toBe(NOW + 5)
  })
})

describe('accountConsumption', () => {
  it('é a maior janela aplicável ao modelo', () => {
    const r = reading({ five_hour: [20, FUTURE], seven_day: [60, FUTURE], seven_day_opus: [90, FUTURE], seven_day_sonnet: [10, FUTURE] })
    expect(accountConsumption(r, 'claude-opus-5-5', NOW)).toBe(90)
    expect(accountConsumption(r, 'claude-sonnet-5', NOW)).toBe(60)
  })
  it('limite por modelo do model_scoped só vale para aquele modelo', () => {
    const r = reading({ five_hour: [10, FUTURE], 'model:fable': [97, FUTURE] })
    expect(accountConsumption(r, 'claude-fable-5-1', NOW)).toBe(97)
    expect(accountConsumption(r, 'claude-opus-5-5', NOW)).toBe(10)
  })
  it('janela com resets_at vencido conta como zerada', () => {
    const r = reading({ five_hour: [100, PAST], seven_day: [40, FUTURE] })
    expect(accountConsumption(r, 'opus', NOW)).toBe(40)
  })
  it('rateLimitType novo entra na conta', () => {
    expect(accountConsumption(reading({ nova_janela: [96, FUTURE] }), 'opus', NOW)).toBe(96)
  })
  it('sem leitura = com folga', () => {
    expect(accountConsumption(null, 'opus', NOW)).toBe(0)
  })
})

describe('chooseAccountForNewConversation', () => {
  const acc = (id: string, pct: number | null, status: AccountCandidate['status'] = 'connected'): AccountCandidate => ({
    id,
    status,
    usage: pct == null ? null : reading({ five_hour: [pct, FUTURE] })
  })

  it('primeira da ordem abaixo de 95%', () => {
    expect(chooseAccountForNewConversation([acc('a', 96), acc('b', 50), acc('c', 10)], 'opus', NOW)).toBe('b')
  })
  it('reordenar muda a escolha', () => {
    expect(chooseAccountForNewConversation([acc('c', 10), acc('a', 96), acc('b', 50)], 'opus', NOW)).toBe('c')
  })
  it('conta sem leitura conta como com folga', () => {
    expect(chooseAccountForNewConversation([acc('a', 99), acc('b', null)], 'opus', NOW)).toBe('b')
  })
  it('todas em 95%+: a de menor consumo que não estourou', () => {
    expect(chooseAccountForNewConversation([acc('a', 100), acc('b', 98), acc('c', 96)], 'opus', NOW)).toBe('c')
  })
  it('todas estouradas: a de menor consumo', () => {
    expect(chooseAccountForNewConversation([acc('a', 100), acc('b', 100)], 'opus', NOW)).toBe('a')
  })
  it('login expirado ou sem login não é candidata', () => {
    expect(chooseAccountForNewConversation([acc('a', 0, 'expired'), acc('b', 80)], 'opus', NOW)).toBe('b')
    expect(chooseAccountForNewConversation([acc('a', 0, 'logged-out')], 'opus', NOW)).toBeUndefined()
  })
  it('retomar usa a conta gravada se conectada; senão, regra de conversa nova', () => {
    const list = [acc('a', 10), acc('b', 99), acc('c', 10, 'expired')]
    expect(accountForConversation('b', list, 'opus', NOW)).toBe('b')
    expect(accountForConversation('c', list, 'opus', NOW)).toBe('a')
    expect(accountForConversation('removida', list, 'opus', NOW)).toBe('a')
  })
})

describe('createUsageReader', () => {
  function setup(fetchWindows: (id: string, signal: AbortSignal) => Promise<Record<string, { utilization: number; resetsAt: number }>>) {
    let clock = NOW
    const store = new Map<string, AccountUsageReading>()
    const fetchSpy = vi.fn(fetchWindows)
    const reader = createUsageReader({
      fetchWindows: fetchSpy,
      load: (id) => store.get(id) ?? null,
      save: (id, r) => store.set(id, r),
      now: () => clock,
      timeoutMs: 50
    })
    return { reader, store, fetchSpy, tick: (ms: number) => (clock += ms) }
  }

  it('respeita o cache de 60 s', async () => {
    const { reader, fetchSpy, tick } = setup(async () => ({ five_hour: { utilization: 5, resetsAt: FUTURE } }))
    await reader.read('a')
    tick(59_000)
    await reader.read('a')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    tick(2_000)
    const result = await reader.read('a')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.fresh).toBe(true)
  })

  it('abrir e fechar o painel 5 vezes (2 contas) = no máximo 1 consulta por conta', async () => {
    const { reader, fetchSpy, tick } = setup(async () => ({ five_hour: { utilization: 5, resetsAt: FUTURE } }))
    for (let i = 0; i < 5; i++) {
      await Promise.all([reader.read('a'), reader.read('b')])
      tick(5_000)
    }
    expect(fetchSpy.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
  })

  it('pedidos simultâneos da mesma conta dividem a consulta; contas diferentes vão em paralelo', async () => {
    const { reader, fetchSpy } = setup(async () => ({ five_hour: { utilization: 5, resetsAt: FUTURE } }))
    await Promise.all([reader.read('a'), reader.read('a'), reader.readMany(['b', 'c'])])
    expect(fetchSpy.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('falha cai na última leitura guardada', async () => {
    const { reader, store } = setup(async () => {
      throw new Error('rede')
    })
    const previous = reading({ five_hour: [70, FUTURE] })
    store.set('a', { ...previous, at: NOW - 120_000 })
    const result = await reader.read('a')
    expect(result.fresh).toBe(false)
    expect(result.reading?.windows.five_hour?.utilization).toBe(70)
  })

  it('timeout aborta a consulta e cai na última leitura', async () => {
    let aborted = false
    const { reader } = setup(
      (_id, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('abortado'))
          })
        })
    )
    const result = await reader.read('a')
    expect(aborted).toBe(true)
    expect(result).toEqual({ accountId: 'a', reading: null, fresh: false })
  })
})
