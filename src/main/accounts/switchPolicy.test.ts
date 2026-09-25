import { describe, expect, it } from 'vitest'
import type { AccountCandidate } from './selection'
import { decideExhaustedSwitch, decideTurnEndSwitch } from './switchPolicy'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const FUTURE = NOW + 3_600_000
const PAST = NOW - 1

function acc(id: string, pct: number | null, extra: Partial<AccountCandidate> = {}, resetsAt = FUTURE): AccountCandidate {
  return {
    id,
    status: 'connected',
    usage: pct == null ? null : { at: NOW, windows: { five_hour: { utilization: pct, resetsAt } } },
    ...extra
  }
}

const turnEnd = (current: AccountCandidate, others: AccountCandidate[]) =>
  decideTurnEndSwitch({ current, others, model: 'claude-opus-5-5', now: NOW })

describe('troca de fim de turno', () => {
  it('A 96%, B 40%, C 70% → B (a de menor consumo)', () => {
    expect(turnEnd(acc('A', 96), [acc('B', 40), acc('C', 70)])).toEqual({ to: 'B', fromPct: 96, toPct: 40 })
  })
  it('A 96%, B 97%, C 98% → não troca', () => {
    expect(turnEnd(acc('A', 96), [acc('B', 97), acc('C', 98)])).toBeNull()
  })
  it('abaixo de 95% não troca', () => {
    expect(turnEnd(acc('A', 94.9), [acc('B', 0)])).toBeNull()
  })
  it('empate: a primeira na ordem do usuário', () => {
    expect(turnEnd(acc('A', 99), [acc('C', 30), acc('B', 30)])?.to).toBe('C')
  })
  it('login expirado nunca é escolhido', () => {
    expect(turnEnd(acc('A', 99), [acc('B', 0, { status: 'expired' }), acc('C', 50)])?.to).toBe('C')
    expect(turnEnd(acc('A', 99), [acc('B', 0, { status: 'logged-out' })])).toBeNull()
  })
  it('conta sem leitura conta como com folga', () => {
    expect(turnEnd(acc('A', 99), [acc('B', 60), acc('C', null)])?.to).toBe('C')
  })
  it('janela com resets_at vencido conta como zerada (nos dois lados)', () => {
    expect(turnEnd(acc('A', 100, {}, PAST), [acc('B', 10)])).toBeNull()
    expect(turnEnd(acc('A', 99), [acc('B', 100, {}, PAST), acc('C', 50)])?.to).toBe('B')
  })
  it('não fica indo e voltando: depois de trocar, a volta só acontece se a nova passar de 95%', () => {
    const first = turnEnd(acc('A', 96), [acc('B', 94)])
    expect(first?.to).toBe('B')
    // Agora B é a atual (94%) e A continua em 96%: não há troca de volta.
    expect(turnEnd(acc('B', 94), [acc('A', 96)])).toBeNull()
    // B chega a 96% e A continua em 96%: todas acima do limite, fica.
    expect(turnEnd(acc('B', 96), [acc('A', 96)])).toBeNull()
  })
})

describe('troca no estouro', () => {
  it('vai para a de menor consumo que não estourou, mesmo acima de 95%', () => {
    const target = decideExhaustedSwitch({
      current: acc('A', 100),
      others: [acc('B', 100), acc('C', 98)],
      model: 'opus',
      tried: new Set(['A']),
      now: NOW
    })
    expect(target?.to).toBe('C')
  })
  it('cada conta entra uma vez por turno; todas tentadas → null (vai para o GPT)', () => {
    const others = [acc('A', 10), acc('B', 20), acc('C', 30)]
    const tried = new Set<string>(['A'])
    const b = decideExhaustedSwitch({ current: acc('A', 100), others, model: 'opus', tried, now: NOW })
    expect(b?.to).toBe('B')
    tried.add('B')
    const c = decideExhaustedSwitch({ current: acc('B', 100), others, model: 'opus', tried, now: NOW })
    expect(c?.to).toBe('C')
    tried.add('C')
    expect(decideExhaustedSwitch({ current: acc('C', 100), others, model: 'opus', tried, now: NOW })).toBeNull()
  })
  it('login expirado nunca é escolhido no estouro', () => {
    expect(
      decideExhaustedSwitch({
        current: acc('A', 100),
        others: [acc('B', 0, { status: 'expired' })],
        model: 'opus',
        tried: new Set(['A']),
        now: NOW
      })
    ).toBeNull()
  })
})
