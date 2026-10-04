import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { diffEvents, snapshotOf, type OfficeSnapshot } from './events'
import { EMPTY_LAYOUT, layoutOffice } from './layout'
import { OfficeScene } from './scene'

/** Começo de um ciclo do loop num relógio realista (como em demoFeed.test.ts). */
const T0 = 14_916_667 * DEMO_LOOP_MS
const CAM = new Vector3(20, 25, 40)

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Roda o loop da demo (tique de 1 s, 10 quadros por tique) e anota o que os agentes fizeram. */
function playDemo() {
  const s = new OfficeScene()
  s.setDemo(true)
  const confetti = vi.spyOn(s.particles, 'confettiBurst')
  const puffs = vi.spyOn(s.particles, 'puff')
  const seen = {
    reactions: new Set<string>(),
    actions: new Set<string>(),
    modes: new Set<string>(),
    leisures: new Set<string>(),
    props: new Set<string>(),
    ran: false,
    /** Por visitante: fora (porta) → dentro → fora → sumiu. */
    visits: new Map<string, string[]>()
  }
  let layout = EMPTY_LAYOUT
  let prev: OfficeSnapshot | null = null
  for (let ms = 0; ms <= DEMO_LOOP_MS + 5_000; ms += 1_000) {
    const now = T0 + ms
    const feed = demoFeed(now)
    const model = deriveOfficeModel(feed, now)
    layout = layoutOffice(model, layout)
    const snapshot = snapshotOf(feed, model, now)
    const events = diffEvents(prev, snapshot, now)
    prev = snapshot
    s.sync(layout, feed, { snapshot, events, wallNow: now, t: ms / 1000 })
    for (let k = 1; k <= 10; k++) {
      s.animate(ms / 1000 + k / 10, 0.1, CAM)
      for (const b of s.crowd.list) {
        if (b.reaction) seen.reactions.add(b.reaction)
        seen.actions.add(b.action)
        seen.modes.add(b.mode)
        if (b.leisure) seen.leisures.add(b.leisure)
        if (b.prop) seen.props.add(b.prop)
        if (b.speed > 2.5) seen.ran = true
        if (b.role !== 'visitor' || !b.roomId) continue
        const room = s.room(b.roomId)
        // A porta é na parede da direita: fora = além dela (+X).
        const where = !b.visible ? 'gone' : room && b.x > room.x + room.width ? 'out' : 'in'
        const trail = seen.visits.get(b.key) ?? []
        if (trail[trail.length - 1] !== where) trail.push(where)
        seen.visits.set(b.key, trail)
      }
    }
  }
  const puffKinds = new Set(puffs.mock.calls.map((c) => c[0]))
  return { s, seen, confetti: confetti.mock.calls.length, puffKinds }
}

describe('a demo (Ctrl+Alt+Shift+D) mostra a vida do escritório', () => {
  it('ao longo do loop aparecem todas as reações, os lazeres, o cochilo, a fila do café e o especialista pela porta', () => {
    const { s, seen, confetti, puffKinds } = playDemo()
    // Reações aos eventos de events.ts.
    for (const r of ['alert', 'scared', 'knuckles', 'facepalm', 'fistpump', 'handsHead', 'yawn', 'watch', 'handoff', 'shrug']) {
      expect(seen.reactions.has(r), r).toBe(true)
    }
    expect(seen.reactions.has('celebrate') || seen.reactions.has('stretch')).toBe(true)
    // Gestos de trabalho por ferramenta, permissão, cochilo e fila.
    // (Na demo só um agente estoura o limite: ele é o 1º da fila e toma o café — 'brew' e 'sip'.)
    for (const a of ['typeFast', 'readScreen', 'drum', 'web', 'wave', 'napDesk', 'napSofa', 'brew', 'sip']) expect(seen.actions.has(a), a).toBe(true)
    for (const m of ['free', 'work', 'permission', 'sleep', 'queue', 'leave', 'away']) expect(seen.modes.has(m), m).toBe(true)
    expect(seen.props.has('sign')).toBe(true)
    expect(seen.props.has('cup')).toBe(true)
    expect(seen.ran).toBe(true)
    // Os sete lazeres aparecem no loop.
    expect([...seen.leisures].sort()).toEqual(['chat', 'coffee', 'phone', 'plant', 'postit', 'shelf', 'window'])
    // No quadro (o Quadro real) ninguém prende papel inventado: nem o gesto, nem o papel na mão.
    expect(seen.actions.has('stick')).toBe(false)
    expect(seen.props.has('note')).toBe(false)
    expect(seen.actions.has('readBoard')).toBe(true)
    // Efeitos: confete no fim, fumaça e suor no erro, vapor no café.
    expect(confetti).toBeGreaterThan(0)
    for (const k of ['smoke', 'sweat', 'steam']) expect(puffKinds.has(k as never), k).toBe(true)
    // Especialista: entra pela porta, trabalha na sala e sai por ela.
    const trails = [...seen.visits.values()].map((t) => t.join('>'))
    expect(trails.some((t) => t.includes('out>in>out>gone')), trails.join(' | ')).toBe(true)
    // O subagente genérico (sala 4) também chega e vai embora pela porta, e então sai de cena.
    const generic = [...seen.visits].find(([k]) => k.startsWith('track:'))
    expect(generic?.[1].join('>')).toBe('out>in>out')
    expect(s.crowd.brains.has(generic![0])).toBe(false)
    s.dispose()
  })

  it('o mesmo loop dá o mesmo resultado (determinístico)', () => {
    const a = playDemo()
    const b = playDemo()
    expect([...a.seen.reactions].sort()).toEqual([...b.seen.reactions].sort())
    expect([...a.seen.visits]).toEqual([...b.seen.visits])
    expect(a.confetti).toBe(b.confetti)
    a.s.dispose()
    b.s.dispose()
  })
})
