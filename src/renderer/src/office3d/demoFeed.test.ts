import { beforeAll, describe, expect, it } from 'vitest'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { sessionBattery } from './battery'
import { DEMO_PER_ROOM, DEMO_ROOMS, demoFeed } from './demoFeed'
import { DEMO_LOOP_MS, USAGE_BACK_AT, USAGE_OUT_AT } from './demoTimeline'
import { scanMemorySequences } from './memoryTrips'
import { diffEvents, snapshotOf, type AgentEvent, type AgentEventType, type AgentPhase, type OfficeSnapshot } from './events'
import { officePower, powerEvents, type OfficePower } from './power'

/** Começo de um ciclo do loop num relógio realista (set/2026: segundos com 10 dígitos). */
const T0 = 14_916_667 * DEMO_LOOP_MS
const ALL_PHASES: AgentPhase[] = ['idle', 'working', 'waiting-permission', 'error', 'done']
const SLEEP_MS = 10 * 60_000

const frame = (now: number): OfficeSnapshot => {
  const f = demoFeed(now)
  return snapshotOf(f, deriveOfficeModel(f, now), now)
}

/** Shape sem relógio: o que muda entre ciclos são só ids (ciclo) e horários. */
const shape = (f: OfficeFeed): unknown =>
  f.conversations.map((c) => ({
    id: c.id,
    busy: f.busyIds.has(c.id),
    perm: f.permissions[c.id]?.toolName ?? null,
    stalled: c.id in f.stalledSince,
    tracks: Object.values(f.tracks[c.id] ?? {}).map((t) => t.status),
    messages: c.messages.map((m) => (m.kind === 'tool-use' ? `${m.name}${m.result ? '✓' : '…'}` : m.kind))
  }))

/** ~120 s simulados, um quadro por segundo (o tique do modo 3D). */
let events: AgentEvent[] = []
const phases = new Map<string, Set<AgentPhase>>()
let firstDiff: AgentEvent[] | null = null
beforeAll(() => {
  let prev: OfficeSnapshot | null = null
  for (let now = T0; now <= T0 + DEMO_LOOP_MS + 2_000; now += 1_000) {
    const snap = frame(now)
    const evs = diffEvents(prev, snap, now)
    firstDiff ??= evs
    events = events.concat(evs)
    for (const s of snap.agents.values()) {
      if (s.role !== 'principal') continue
      const set = phases.get(s.convId) ?? new Set<AgentPhase>()
      set.add(s.phase)
      phases.set(s.convId, set)
    }
    prev = snap
  }
})

describe('linha do tempo da demonstração', () => {
  it('em ~120 s simulados, diffEvents emite pelo menos 1 evento de cada tipo (menos speaking)', () => {
    expect(firstDiff).toEqual([])
    const all: AgentEventType[] = ['request', 'tool', 'test-result', 'permission', 'permission-done', 'delegate', 'return', 'error', 'done', 'context-low', 'usage-exhausted', 'usage-back', 'stalled']
    const seen = new Set(events.map((e) => e.type))
    expect(all.filter((t) => !seen.has(t))).toEqual([])
    // Testes que passam e que falham; delegação que volta com e sem sucesso.
    const tests = events.filter((e) => e.type === 'test-result')
    expect(tests.some((e) => e.type === 'test-result' && e.failed > 0) && tests.some((e) => e.type === 'test-result' && e.failed === 0)).toBe(true)
    const returns = events.filter((e) => e.type === 'return').map((e) => e.type === 'return' && e.ok)
    expect(returns).toContain(true)
    expect(returns).toContain(false)
    // Quem vive o quê: o limite na sala 3, o silêncio na sala 4, o contexto baixo na sala 1.
    expect(events.filter((e) => e.type === 'usage-exhausted')).toMatchObject([{ key: 'conv:demo-3-2', resetsAt: T0 + USAGE_BACK_AT }])
    expect(events.filter((e) => e.type === 'error' && e.key === 'conv:demo-3-2').map((e) => e.type === 'error' && e.message)).toContain('Claude AI usage limit reached')
    expect(events.filter((e) => e.type === 'stalled').map((e) => e.key)).toEqual(['conv:demo-4-2'])
    expect(events.filter((e) => e.type === 'context-low' && e.key === 'conv:demo-1-0').map((e) => e.type === 'context-low' && e.pct)).toEqual([20, 10])
    const requests = events.filter((e) => e.type === 'request')
    expect(requests.some((e) => e.type === 'request' && e.text.includes('desconto'))).toBe(true)
  })

  it('em cada sala, uma conversa passa por todas as fases ao longo do loop', () => {
    for (let r = 0; r < DEMO_ROOMS; r++) {
      const full = Array.from({ length: DEMO_PER_ROOM }, (_, i) => phases.get(`demo-${r}-${i}`) ?? new Set()).filter((set) => ALL_PHASES.every((p) => set.has(p)))
      expect(full.length, `sala ${r}`).toBeGreaterThan(0)
    }
  })

  it('o dorminhoco de cada sala fica ocioso acima do sono o loop inteiro', () => {
    for (let now = T0; now < T0 + DEMO_LOOP_MS; now += 10_000) {
      const snap = frame(now)
      for (let r = 0; r < DEMO_ROOMS; r++) {
        const s = snap.agents.get(`conv:demo-${r}-3`)!
        expect(s.phase).toBe('idle')
        expect(now - s.idleSinceMs!).toBeGreaterThan(SLEEP_MS)
      }
    }
  })

  it('a janela de 5h esgota e volta em algum ponto do loop', () => {
    const at = (t: number): ReturnType<typeof sessionBattery> => sessionBattery(demoFeed(T0 + t).usageLimits, T0 + t)
    expect(at(0)).toMatchObject({ percent: 85, rejected: false })
    expect(at(USAGE_OUT_AT + 1_000)).toMatchObject({ percent: 0, rejected: true })
    expect(at(USAGE_BACK_AT + 1_000)).toMatchObject({ rejected: false, level: 'high' })
  })

  it('a energia do escritório faz o ciclo inteiro no loop: cheia → economia → alerta → apagão (≥ 20 s de festa) → luz voltou', () => {
    let p: OfficePower | null = null
    const levels: Array<{ level: string; t: number }> = []
    const events: Array<{ event: string; t: number }> = []
    for (let t = 0; t <= DEMO_LOOP_MS; t += 1_000) {
      const next = officePower(demoFeed(T0 + t), T0 + t, p)
      const ev = powerEvents(p, next)
      if (ev) events.push({ event: ev, t })
      if (!levels.length || levels[levels.length - 1].level !== next!.level) levels.push({ level: next!.level, t })
      p = next
    }
    expect(levels.map((l) => l.level)).toEqual(['cheia', 'economia', 'alerta', 'apagao', 'cheia'])
    expect(events.map((e) => e.event)).toEqual(['economia', 'alerta', 'apagao', 'luz-voltou'])
    const out = events.find((e) => e.event === 'apagao')!.t
    const back = events.find((e) => e.event === 'luz-voltou')!.t
    expect(back - out).toBeGreaterThanOrEqual(20_000)
    // O consumo da demo é medido: os pulsos do cabo andam antes do apagão.
    expect(officePower(demoFeed(T0 + 30_000), T0 + 30_000, officePower(demoFeed(T0 + 20_000), T0 + 20_000))!.drainPerMin).toBeGreaterThan(0)
  })

  it('é determinística e se repete a cada DEMO_LOOP_MS', () => {
    expect(demoFeed(T0 + 12_345)).toEqual(demoFeed(T0 + 12_345))
    for (const t of [0, 7_500, 36_000, 70_000, 95_000]) expect(shape(demoFeed(T0 + t + DEMO_LOOP_MS))).toEqual(shape(demoFeed(T0 + t)))
    // Cada volta traz mensagens novas (o id leva o ciclo).
    const firstId = (now: number): string => {
      const m = demoFeed(now).conversations[0].messages[0]
      return 'id' in m ? m.id : ''
    }
    expect(firstId(T0 + DEMO_LOOP_MS)).not.toBe(firstId(T0))
  })

  it('aos ~27 s alguém consulta a memória (vai à estante), e não quem testou na TV (a sala de reunião vem antes)', () => {
    const now = T0 + 27_000
    const f = demoFeed(now)
    const trips = scanMemorySequences(f, deriveOfficeModel(f, now).characters, null)
    expect(trips.size).toBeGreaterThan(0)
    const testers = new Set(f.conversations.filter((c) => c.messages.some((m) => m.kind === 'tool-use' && /^mcp__(browser|android)__/.test(m.name))).map((c) => `conv:${c.id}`))
    for (const key of trips.keys()) expect(testers.has(key)).toBe(false)
  })

  it('sem argumento é o quadro de vitrine: a fase 0 com o relógio de agora', () => {
    const showcase = demoFeed()
    expect(shape(showcase)).toEqual(shape(demoFeed(0)))
    expect(showcase.conversations.map((c) => c.messages.map((m) => ('id' in m ? m.id : '')))).toEqual(demoFeed(0).conversations.map((c) => c.messages.map((m) => ('id' in m ? m.id : ''))))
    const model = deriveOfficeModel(showcase, Date.now())
    // + a Central, no console do centro, e o Manager do plano, à cabeceira.
    expect(model.characters).toHaveLength(DEMO_ROOMS * DEMO_PER_ROOM + 2)
    expect(showcase.permissions['demo-0-2']?.input).toEqual({ command: 'npm publish' })
    expect(showcase.stalledSince['demo-4-2']).toBeLessThan(Date.now())
  })
})
