import { describe, expect, it } from 'vitest'
import type { RateLimitStatus } from '@shared/ipc'
import { sessionBattery } from './battery'
import {
  drainOf,
  DRAIN_WINDOW_MS,
  officePower,
  plainLevel,
  POWER_HYSTERESIS,
  powerEvents,
  powerLevel,
  powerPanelText,
  SAMPLE_MIN_MS,
  type OfficePower,
  type PowerLevel
} from './power'

const NOW = new Date(2026, 9, 2, 14, 0).getTime()
const RESET = new Date(2026, 9, 2, 23, 40).getTime()

const feed = (utilization: number | undefined, extra: Partial<RateLimitStatus> = {}): { usageLimits: Record<string, RateLimitStatus> } => ({
  usageLimits: { five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization, resetsAt: RESET, ...extra } }
})

/** Anda de leitura em leitura (carga em %, uma a cada `stepMs`), passando o retorno como `prev`. */
function walk(pcts: number[], stepMs = 30_000): OfficePower[] {
  const out: OfficePower[] = []
  let prev: OfficePower | null = null
  pcts.forEach((pct, i) => {
    const at = NOW + i * stepMs
    prev = officePower(feed(1 - pct / 100, { updatedAt: at }), at, prev)
    out.push(prev!)
  })
  return out
}

describe('officePower: a energia do escritório é a janela de 5h da bateria do HUD', () => {
  it('mesma % da bateria de sessão (battery.ts), a hora do reset e null sem a janela', () => {
    for (const u of [0, 0.123, 0.5, 0.505, 0.8, 0.996, 1]) {
      const f = feed(u)
      expect(officePower(f, NOW)!.pct).toBe(sessionBattery(f.usageLimits, NOW)!.percent)
    }
    expect(officePower(feed(0.28), NOW)).toMatchObject({ pct: 72, level: 'cheia', resetsAt: RESET, rejected: false, drainPerMin: 0 })
    expect(officePower(null, NOW)).toBeNull()
    expect(officePower({ usageLimits: {} }, NOW)).toBeNull()
    expect(officePower(feed(undefined), NOW)).toBeNull()
  })

  it('níveis: ≥ 50 cheia, 20–50 economia, 1–20 alerta, 0% ou rejected apagão', () => {
    const at = (pct: number): PowerLevel => officePower(feed(1 - pct / 100), NOW)!.level
    expect([100, 50, 49, 20, 19, 1, 0].map(at)).toEqual(['cheia', 'cheia', 'economia', 'economia', 'alerta', 'alerta', 'apagao'])
    expect(officePower(feed(0.4, { status: 'rejected' }), NOW)).toMatchObject({ level: 'apagao', pct: 0, rejected: true })
    expect(plainLevel(NaN, false)).toBe('apagao')
  })

  it('histerese: piora na fronteira, melhora só ~3 pontos acima dela', () => {
    expect(POWER_HYSTERESIS).toBe(3)
    const levels = (pcts: number[]): PowerLevel[] => walk(pcts).map((p) => p.level)
    // 55 → 49 cai; 50, 51, 52 ainda economia; 53 volta.
    expect(levels([55, 49, 50, 51, 52, 53])).toEqual(['cheia', 'economia', 'economia', 'economia', 'economia', 'cheia'])
    expect(levels([25, 19, 20, 22, 23])).toEqual(['economia', 'alerta', 'alerta', 'alerta', 'economia'])
    // Do apagão só sai com 4% (sem saltar de vez, que é reset).
    expect(powerLevel(3, false, 'apagao')).toBe('apagao')
    expect(powerLevel(4, false, 'apagao')).toBe('alerta')
    // Melhora de vários níveis de uma vez quando a carga sobe muito (o reset).
    expect(powerLevel(100, false, 'apagao')).toBe('cheia')
    expect(powerLevel(51, false, 'alerta')).toBe('economia')
  })

  it('o reset que já passou (sem leitura nova) é janela nova: 100%', () => {
    const p = officePower(feed(1, { status: 'rejected', resetsAt: NOW - 1 }), NOW)
    expect(p).toMatchObject({ pct: 100, level: 'cheia', rejected: false, resetsAt: null })
  })
})

describe('officePower: consumo (drainPerMin) por média móvel das amostras', () => {
  it('pontos por minuto entre a amostra mais antiga e a mais nova da janela', () => {
    // 1 ponto a cada 30 s = 2 pontos por minuto.
    const p = walk([80, 79, 78, 77, 76, 75])
    expect(p[0].drainPerMin).toBe(0)
    expect(p[5].drainPerMin).toBeCloseTo(2, 5)
    expect(p[5].samples).toHaveLength(6)
    // Média: uma rajada no meio não manda sozinha.
    const burst = walk([80, 80, 70, 70, 70, 70])
    expect(burst[5].drainPerMin).toBeCloseTo(10 / 2.5, 5)
    expect(drainOf([])).toBe(0)
  })

  it('leituras mais próximas que SAMPLE_MIN_MS não viram amostra; reset (subida brusca) recomeça; janela de 10 min', () => {
    const fast = walk([80, 79, 78], SAMPLE_MIN_MS / 5)
    expect(fast[2].samples).toHaveLength(1)
    const reset = walk([30, 25, 20, 100])
    expect(reset[3].samples).toHaveLength(1)
    expect(reset[3].drainPerMin).toBe(0)
    // Sem leitura nova por mais que a janela: consumo zera (os pulsos param).
    const last = walk([60, 58, 56])[2]
    const later = officePower(feed(0.44, { updatedAt: NOW + 60_000 }), NOW + 60_000 + DRAIN_WINDOW_MS + 1, last)!
    expect(later.drainPerMin).toBe(0)
    // Amostras velhas saem da conta.
    const many = walk(Array.from({ length: 30 }, (_, i) => 90 - i), 60_000)
    expect(many[29].samples.every((s) => many[29].samples[many[29].samples.length - 1].at - s.at <= DRAIN_WINDOW_MS)).toBe(true)
    expect(many[29].drainPerMin).toBeCloseTo(1, 5)
  })
})

describe('powerEvents', () => {
  const at = (level: PowerLevel): Pick<OfficePower, 'level'> => ({ level })
  it('piorou → o nível novo; saiu do apagão → luz-voltou; o resto nada', () => {
    expect(powerEvents(at('cheia'), at('economia'))).toBe('economia')
    expect(powerEvents(at('economia'), at('alerta'))).toBe('alerta')
    expect(powerEvents(at('alerta'), at('apagao'))).toBe('apagao')
    expect(powerEvents(at('cheia'), at('apagao'))).toBe('apagao')
    expect(powerEvents(at('apagao'), at('cheia'))).toBe('luz-voltou')
    expect(powerEvents(at('apagao'), at('alerta'))).toBe('luz-voltou')
    expect(powerEvents(at('economia'), at('cheia'))).toBeNull()
    expect(powerEvents(at('alerta'), at('alerta'))).toBeNull()
    // 1º retrato: histórico não dispara.
    expect(powerEvents(null, at('apagao'))).toBeNull()
    expect(powerEvents(at('apagao'), null)).toBeNull()
  })
})

describe('texto do painel', () => {
  it('"⚡ 72% · recarrega às 23:40" (no apagão também); sem horário, só a %', () => {
    expect(powerPanelText({ pct: 72, level: 'cheia', resetsAt: RESET }, NOW)).toBe('⚡ 72% · recarrega às 23:40')
    expect(powerPanelText({ pct: 0, level: 'apagao', resetsAt: RESET }, NOW)).toBe('⚡ 0% · recarrega às 23:40')
    expect(powerPanelText({ pct: 40, level: 'economia', resetsAt: null }, NOW)).toBe('⚡ 40%')
  })
})
