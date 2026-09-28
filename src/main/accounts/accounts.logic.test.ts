import { describe, expect, it, vi } from 'vitest'
import type { AccountUsageReading } from '../../shared/claudeAccounts'
import { parseResetFromError } from '../../shared/resetTime'
import { accountForConversation, chooseAccountForNewConversation, type AccountCandidate } from './selection'
import {
  accountConsumption,
  EXHAUSTED_MAX_MS,
  exhaustedReading,
  mergeReading,
  windowFromRateLimitEvent,
  windowsFromUsage
} from './usageMath'
import { createUsageReader } from './usageReader'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const FUTURE = NOW + 3_600_000
const PAST = NOW - 1_000
const HOUR = 3_600_000

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
    expect(accountConsumption(r, 'claude-sonnet-5-5', NOW)).toBe(60)
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

describe('exhaustedReading (conta que estourou de vez)', () => {
  it('a janela citada no aviso vai a 100%, com o reset já conhecido', () => {
    const before = reading({ five_hour: [40, FUTURE], seven_day: [80, FUTURE + 1] })
    const after = exhaustedReading(before, "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)", NOW)
    expect(after.windows.seven_day).toEqual({ utilization: 100, resetsAt: FUTURE + 1 })
    expect(after.windows.five_hour).toEqual({ utilization: 40, resetsAt: FUTURE })
    expect(accountConsumption(after, 'claude-opus-5-5', NOW)).toBe(100)
    // Depois do reset, a janela volta a contar como zerada.
    expect(accountConsumption(after, 'claude-opus-5-5', FUTURE + 2)).toBe(0)
  })

  it('"weekly usage limit" (fim do modo de baixa prioridade) também é a janela semanal, com o prazo de 7 dias', () => {
    const after = exhaustedReading(null, 'Lower-priority mode ended · you have reached your weekly usage limit', NOW)
    expect(after.windows.seven_day).toEqual({ utilization: 100, resetsAt: NOW + EXHAUSTED_MAX_MS.seven_day })
    expect(after.windows.exhausted).toBeUndefined()
  })

  it('reset vencido e texto sem fuso: prazo máximo da janela (5h na de sessão), nunca sem reset', () => {
    const after = exhaustedReading(reading({ five_hour: [99, PAST] }), "You've hit your session limit · resets 2:10am", NOW)
    expect(after.windows.five_hour).toEqual({ utilization: 100, resetsAt: NOW + 5 * HOUR })
  })

  it('aviso sem janela reconhecível marca a conta toda', () => {
    const after = exhaustedReading(null, "You've hit your limit · resets 8pm", NOW)
    expect(accountConsumption(after, 'claude-sonnet-5-5', NOW)).toBe(100)
  })

  it('limite de um modelo só vale para aquele modelo', () => {
    const after = exhaustedReading(null, "You've hit your Opus limit · resets Oct 1", NOW)
    expect(accountConsumption(after, 'claude-opus-5-5', NOW)).toBe(100)
    expect(accountConsumption(after, 'claude-sonnet-5-5', NOW)).toBe(0)
    const fable = exhaustedReading(null, "You've reached your Fable 5 limit. Run /usage-credits to continue", NOW)
    expect(accountConsumption(fable, 'claude-fable-5-1', NOW)).toBe(100)
    expect(accountConsumption(fable, 'claude-opus-5-5', NOW)).toBe(0)
  })
})

describe('conta esgotada volta a ser elegível (nunca fica presa)', () => {
  const HOUR_MS = HOUR
  // NOW = 24/09 09:00 em São Paulo (UTC-3) → "11pm" = 24/09 23:00 BRT = 25/09 02:00Z.
  const ELEVEN_PM = Date.parse('2026-09-25T02:00:00Z')
  const candidates = (usageA: AccountUsageReading | null): AccountCandidate[] => [
    { id: 'A', status: 'connected', usage: usageA },
    { id: 'B', status: 'connected', usage: reading({ five_hour: [97, null] }) }
  ]

  it('o reset vem do próprio texto do aviso ("resets 11pm (America/Sao_Paulo)")', () => {
    const after = exhaustedReading(null, "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)", NOW)
    expect(after.windows.seven_day).toEqual({ utilization: 100, resetsAt: ELEVEN_PM })
    expect(accountConsumption(after, 'claude-opus-5-5', ELEVEN_PM - 1)).toBe(100)
    expect(accountConsumption(after, 'claude-opus-5-5', ELEVEN_PM)).toBe(0)
    // Antes do reset, A (100%) perde para B (97%); depois, A é a primeira da ordem de novo.
    expect(chooseAccountForNewConversation(candidates(after), 'claude-opus-5-5', ELEVEN_PM - 1)).toBe('B')
    expect(chooseAccountForNewConversation(candidates(after), 'claude-opus-5-5', ELEVEN_PM + 1)).toBe('A')
  })

  it('texto com data ("resets Sep 30, 9pm (…)") e com minutos ("1:10pm") também dão o reset', () => {
    // Datas dentro do prazo da janela (semanal 7d, sessão 5h a partir de 24/09 09:00 BRT).
    const opus = exhaustedReading(null, "You've hit your Opus limit · resets Sep 30, 9pm (America/Sao_Paulo)", NOW)
    expect(opus.windows.seven_day_opus?.resetsAt).toBe(Date.parse('2026-10-01T00:00:00Z'))
    const session = exhaustedReading(null, "You've hit your session limit · resets 1:10pm (America/Sao_Paulo)", NOW)
    expect(session.windows.five_hour?.resetsAt).toBe(Date.parse('2026-09-24T16:10:00Z'))
    // "2:10am" (17h depois) passaria do prazo da sessão: fica em NOW + 5h.
    const far = exhaustedReading(null, "You've hit your session limit · resets 2:10am (America/Sao_Paulo)", NOW)
    expect(far.windows.five_hour?.resetsAt).toBe(NOW + EXHAUSTED_MAX_MS.five_hour)
  })

  it('o reset exato da API (já conhecido) vale mais que o do texto (arredondado ao minuto)', () => {
    const after = exhaustedReading(reading({ seven_day: [80, FUTURE] }), "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)", NOW)
    expect(after.windows.seven_day?.resetsAt).toBe(FUTURE)
  })

  it('sem reset no texto: semanal expira em 7 dias, sessão em 5h', () => {
    const weekly = exhaustedReading(null, "You've hit your weekly limit", NOW)
    expect(EXHAUSTED_MAX_MS.seven_day).toBe(7 * 24 * HOUR_MS)
    expect(accountConsumption(weekly, 'claude-opus-5-5', NOW + 7 * 24 * HOUR_MS - 1)).toBe(100)
    expect(accountConsumption(weekly, 'claude-opus-5-5', NOW + 7 * 24 * HOUR_MS)).toBe(0)
    const session = exhaustedReading(null, "You've hit your session limit", NOW)
    expect(accountConsumption(session, 'claude-opus-5-5', NOW + 5 * HOUR_MS - 1)).toBe(100)
    expect(accountConsumption(session, 'claude-opus-5-5', NOW + 5 * HOUR_MS)).toBe(0)
  })

  it('aviso genérico sem modelo bloqueia todos os modelos, mas só até o prazo (5h)', () => {
    const after = exhaustedReading(null, "Your seat type doesn't include extra usage", NOW)
    expect(after.windows.exhausted).toEqual({ utilization: 100, resetsAt: NOW + 5 * HOUR_MS })
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      expect(accountConsumption(after, model, NOW + 5 * HOUR_MS - 1)).toBe(100)
      expect(accountConsumption(after, model, NOW + 5 * HOUR_MS)).toBe(0)
    }
    expect(chooseAccountForNewConversation(candidates(after), 'claude-sonnet-5-5', NOW + 5 * HOUR_MS)).toBe('A')
  })

  it('reset só com hora que acabou de passar (minuto truncado pelo CLI) não vai para amanhã: fica no prazo da janela', () => {
    // O reset real foi às 23:00:40; o CLI escreve "11pm" e o aviso é lido às 23:00:30.
    const at = Date.parse('2026-09-24T23:00:30Z')
    const text = "You've hit your session limit · resets 11pm (UTC)"
    // O parser sozinho joga para amanhã (+~24h) — mais que a janela de 5h inteira.
    expect(parseResetFromError(text, at)).toBe(Date.parse('2026-09-25T23:00:00Z'))
    const after = exhaustedReading(null, text, at)
    expect(after.windows.five_hour).toEqual({ utilization: 100, resetsAt: at + EXHAUSTED_MAX_MS.five_hour })
    expect(accountConsumption(after, 'claude-opus-5-5', at + 5 * HOUR_MS)).toBe(0)
    // Até 1 min antes também: 23:00:00 exato já é "passado" para o parser.
    const edge = exhaustedReading(null, text, Date.parse('2026-09-24T23:00:00Z'))
    expect(edge.windows.five_hour?.resetsAt).toBe(Date.parse('2026-09-24T23:00:00Z') + 5 * HOUR_MS)
  })

  it('nenhum reset lido do texto passa do prazo da própria janela (semanal: 7 dias)', () => {
    // 01/10 21h BRT = 02/10 00:00Z, 7,5 dias depois de NOW: mais longe que uma semana.
    const opus = exhaustedReading(null, "You've hit your Opus limit · resets Oct 1, 9pm (America/Sao_Paulo)", NOW)
    expect(opus.windows.seven_day_opus?.resetsAt).toBe(NOW + EXHAUSTED_MAX_MS.seven_day_opus)
    // Dentro do prazo o texto vale como antes (o teste de "11pm" acima: 25/09 02:00Z).
    const weekly = exhaustedReading(null, "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)", NOW)
    expect(weekly.windows.seven_day?.resetsAt).toBe(ELEVEN_PM)
  })

  it('todas as janelas conhecidas têm prazo', () => {
    for (const text of ["You've hit your session limit", "You've hit your weekly limit", "You've hit your Opus limit",
      "You've hit your Sonnet limit", "You've hit your Fable limit", "You've hit your limit"]) {
      const after = exhaustedReading(null, text, NOW)
      for (const window of Object.values(after.windows)) expect(window.resetsAt).toBeGreaterThan(NOW)
    }
  })
})

describe('aviso genérico ("You\'ve hit your limit") com data explícita de reset', () => {
  // NOW = 24/09 09:00 em São Paulo (UTC-3).
  it('"resets Sep 27, 9am" (3 dias) vale como escrito: o teto de 5h não corta uma data de dias', () => {
    const after = exhaustedReading(null, "You've hit your limit · resets Sep 27, 9am (America/Sao_Paulo)", NOW)
    expect(after.windows.exhausted).toEqual({ utilization: 100, resetsAt: Date.parse('2026-09-27T12:00:00Z') })
    // Continua esgotada depois de 5h (antes, voltava a cada 5h e estourava de novo).
    expect(accountConsumption(after, 'claude-opus-5-5', NOW + 6 * HOUR)).toBe(100)
    expect(accountConsumption(after, 'claude-opus-5-5', Date.parse('2026-09-27T12:00:00Z'))).toBe(0)
  })

  it('"resets Oct 3, 9am" (9 dias) fica no teto da janela mais longa (7 dias)', () => {
    const after = exhaustedReading(null, "You've hit your limit · resets Oct 3, 9am (America/Sao_Paulo)", NOW)
    expect(after.windows.exhausted?.resetsAt).toBe(NOW + EXHAUSTED_MAX_MS.seven_day)
  })

  it('só com a hora ("resets 11pm", 14h depois) o teto continua 5h', () => {
    const after = exhaustedReading(null, "You've hit your limit · resets 11pm (America/Sao_Paulo)", NOW)
    expect(after.windows.exhausted?.resetsAt).toBe(NOW + EXHAUSTED_MAX_MS.exhausted)
  })
})
