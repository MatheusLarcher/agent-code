import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventBody, AgentStatus } from '../events'
import type { PartyRole } from '../partyPlan'
import type { PowerEvent, PowerLevel } from '../power'
import { fill } from './format'
import { createQuipEngine, PRIORITY, seededRng, type Quip } from './generator'
import { LINES } from './lines'
import { ALERT_REMIND_MS, PARTY_TALKERS, type PowerQuipInput } from './powerVoice'

/** 14:00 local: a hora do reset sai igual em qualquer fuso. */
const NOW = new Date(2026, 9, 2, 14, 0).getTime()
const RESET = new Date(2026, 9, 2, 23, 40).getTime()
const KEYS = ['conv:a', 'conv:b', 'conv:c', 'conv:d', 'conv:e', 'conv:f']

function status(key: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    key, convId: key.slice(5), role: 'principal', phase: 'idle', task: false, tool: null, lastUserText: '', busySinceMs: null, idleSinceMs: NOW - 60_000,
    contextPct: 80, permission: null, error: null, usageExhausted: null, speaking: false, stalledMs: 0, ...over
  }
}
const world = (...list: AgentStatus[]): Map<string, AgentStatus> => new Map(list.map((s) => [s.key, s]))
const office = (): Map<string, AgentStatus> => world(...KEYS.map((k) => status(k)))
const pw = (level: PowerLevel, pct: number, event: PowerEvent | null = null, roles?: ReadonlyMap<string, PartyRole>): PowerQuipInput => ({ level, pct, resetsAt: RESET, event, roles })
const ev = (key: string, body: AgentEventBody): AgentEvent => ({ key, convId: key.slice(5), at: NOW, ...body })
const ofKind = (out: Map<string, Quip | null>, kind: string): Quip[] => [...out.values()].filter((q): q is Quip => q?.kind === kind)
const POWER_SITS = ['power-eco', 'power-alert', 'power-out', 'power-back', 'party', 'party-flashlight', 'party-pizza', 'party-conga'] as const
/** De qual situação de energia/festa saiu a fala (preenchendo os moldes com os dados do teste). */
const sitOf = (text: string): (typeof POWER_SITS)[number] | null => {
  for (const sit of POWER_SITS) {
    for (const pct of [0, 12, 14, 15, 42, 100]) if (LINES[sit].lines.some((l) => fill(l, { pct, time: '23:40' }) === text)) return sit
  }
  return null
}

describe('falas da energia do escritório', () => {
  it('cada mudança tem quem anuncie, com o dado: economia (%), alerta (% e hora), apagão (hora), luz voltou (%)', () => {
    const e = createQuipEngine(seededRng(5))
    const eco = ofKind(e.step(office(), [], NOW, pw('economia', 42, 'economia')), 'power')
    expect(eco).toHaveLength(1)
    expect(eco[0].text).toContain('42%')
    expect(sitOf(eco[0].text)).toBe('power-eco')
    const alert = ofKind(e.step(office(), [], NOW + 10_000, pw('alerta', 12, 'alerta')), 'power')
    expect(alert).toHaveLength(1)
    expect(alert[0].text).toContain('12%')
    const out = ofKind(e.step(office(), [], NOW + 20_000, pw('apagao', 0, 'apagao')), 'power')
    expect(out).toHaveLength(2)
    for (const q of out) expect(q.text).toContain('23:40')
    expect(out[0].priority).toBe(PRIORITY.power)
    const back = ofKind(e.step(office(), [], NOW + 60_000, pw('cheia', 100, 'luz-voltou')), 'power')
    expect(back).toHaveLength(2)
    for (const q of back) expect(q.text).toContain('100%')
  })

  it('permissão e erro continuam ganhando do anúncio de energia', () => {
    const e = createQuipEngine(seededRng(2))
    const perm = status('conv:a', { phase: 'waiting-permission', permission: { tool: 'Bash', detail: 'rm -rf dist' } })
    const err = status('conv:b', { phase: 'error', error: 'ENOENT config.json' })
    const statuses = world(perm, err)
    const out = e.step(statuses, [ev('conv:a', { type: 'permission', tool: 'Bash', detail: 'rm -rf dist' }), ev('conv:b', { type: 'error', message: 'ENOENT config.json' })], NOW, pw('apagao', 0, 'apagao'))
    expect(out.get('conv:a')?.kind).toBe('permission')
    expect(out.get('conv:b')?.kind).toBe('error')
    expect(PRIORITY.power).toBeLessThan(PRIORITY.error)
    expect(PRIORITY.power).toBeGreaterThan(PRIORITY.request)
  })

  it('no alerta, um lembrete com a % atual a cada ALERT_REMIND_MS', () => {
    const e = createQuipEngine(seededRng(9))
    e.step(office(), [], NOW, pw('alerta', 15, 'alerta'))
    for (let ms = 250; ms < ALERT_REMIND_MS; ms += 250) {
      expect(ofKind(e.step(office(), [], NOW + ms, pw('alerta', 14)), 'power').some((q) => q.text.includes('14%'))).toBe(false)
    }
    const remind = ofKind(e.step(office(), [], NOW + ALERT_REMIND_MS, pw('alerta', 14)), 'power')
    expect(remind).toHaveLength(1)
    expect(remind[0].text).toContain('14%')
    expect(sitOf(remind[0].text)).toBe('power-alert')
  })
})

describe('falas da festa (apagão)', () => {
  it('só 1–2 falam por vez, a vez passa pelo escritório e quem tem papel fala dele', () => {
    const e = createQuipEngine(seededRng(11))
    const roles = new Map<string, PartyRole>([['conv:a', 'flashlight'], ['conv:b', 'pizza'], ['conv:c', 'conga'], ['conv:d', 'conga'], ['conv:e', 'dance'], ['conv:f', 'dance']])
    e.step(office(), [], NOW, pw('apagao', 0, 'apagao', roles))
    const speakers = new Set<string>()
    const sits = new Set<string>()
    let max = 0
    for (let ms = 250; ms <= 90_000; ms += 250) {
      const out = e.step(office(), [], NOW + ms, pw('apagao', 0, null, roles))
      const talking = [...out.entries()].filter(([, q]) => q && (q.kind === 'party' || q.kind === 'power'))
      max = Math.max(max, talking.length)
      for (const [k, q] of talking) {
        if (q!.kind !== 'party') continue
        speakers.add(k)
        const sit = sitOf(q!.text)
        if (sit) sits.add(sit)
      }
    }
    expect(max).toBeLessThanOrEqual(PARTY_TALKERS)
    expect(speakers.size).toBeGreaterThanOrEqual(4)
    expect(sits.has('party')).toBe(true)
    expect(sits.has('party-flashlight') || sits.has('party-pizza') || sits.has('party-conga')).toBe(true)
  })

  it('no apagão o escritório para: narração de ferramenta, teste e pensamento à toa não entram; o que estava no ar sai', () => {
    const e = createQuipEngine(seededRng(3))
    const read = { id: 'r1', name: 'Read', kind: 'read' as const, target: 'api.ts', detail: '' }
    const working = status('conv:a', { phase: 'working', tool: read, busySinceMs: NOW - 5_000 })
    const before = e.step(world(working), [ev('conv:a', { type: 'tool', name: 'Read', kind: 'read', target: 'api.ts' })], NOW)
    expect(before.get('conv:a')?.kind).toBe('progress')
    const party = e.step(world(working), [ev('conv:a', { type: 'test-result', passed: 1, failed: 2 })], NOW + 1_000, pw('apagao', 0, null))
    expect(party.get('conv:a')?.kind ?? null).not.toBe('progress')
    expect(party.get('conv:a')?.kind ?? null).not.toBe('error')
    for (let ms = 1_250; ms < 60_000; ms += 250) {
      const q = e.step(world(working), [], NOW + ms, pw('apagao', 0, null)).get('conv:a')
      if (q) expect(['party', 'power']).toContain(q.kind)
    }
  })
})
