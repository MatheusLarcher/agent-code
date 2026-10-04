import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { cameraPosition, type CameraPose } from './cameraRig'
import { BAR_BEATS, beatAt, DANCE_MOVES, danceMove } from './dance'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { layoutOffice } from './layout'
import { ZONES, type ZoneId } from './officePlan'
import type { PartyZone } from './party'
import { CONGA_GAP, CONGA_MAX } from './partyPlan'
import type { OfficePower, PowerLevel } from './power'
import { OfficeScene } from './scene'

const T0 = 14_916_667 * DEMO_LOOP_MS
const power = (level: PowerLevel): OfficePower => ({
  pct: level === 'apagao' ? 0 : 80,
  level,
  resetsAt: T0 + 3_600_000,
  drainPerMin: 0,
  rejected: level === 'apagao',
  samples: []
})

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function camera(pose: CameraPose): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 16 / 9, 0.05, 250)
  const p = cameraPosition(pose)
  cam.position.set(p.x, p.y, p.z)
  cam.lookAt(pose.tx, pose.ty, pose.tz)
  cam.updateMatrixWorld()
  return cam
}

/** Demo aos 30 s do loop (gente trabalhando) e o apagão ligado no relógio 0. */
function party(now = T0 + 30_000) {
  const s = new OfficeScene()
  const feed = demoFeed(now)
  const model = deriveOfficeModel(feed, now)
  const layout = layoutOffice(model)
  s.sync(layout, feed, { snapshot: snapshotOf(feed, model, now), events: [], wallNow: now, t: 0 })
  /** O escritório inteiro de cima (todas as zonas à vista) e de perto de uma ilha (a praça e a ilha). */
  const whole = camera({ tx: 0, ty: 0, tz: 1.1, yaw: 0, pitch: 1.2, distance: 17 })
  const near = camera({ tx: -4.25, ty: 0, tz: 6.46, yaw: 0, pitch: 0.9, distance: 6 })
  const zoneOf = (id: ZoneId): PartyZone => (s.energy as unknown as { byId: Map<ZoneId, { party: PartyZone }> }).byId.get(id)!.party
  let t = 0
  const run = (secs: number): void => {
    for (let k = 0; k < Math.round(secs / 0.05); k++) s.animate((t += 0.05), 0.05)
  }
  s.setPower(power('apagao'), 'apagao', 0)
  return { s, layout, whole, near, zoneOf, run, now: () => t }
}

describe('festa no apagão: todo mundo para e festeja', () => {
  it('papéis no escritório: uma lanterna, trenzinho com 3 a CONGA_MAX, uma pizza, o resto dança — especialistas inclusos', () => {
    // Aos 45 s do loop os especialistas delegados estão trabalhando.
    const { s, run } = party(T0 + 45_000)
    run(0.1)
    const crowd = s.crowd
    expect(crowd.partyOn).toBe(true)
    const roles = crowd.list.filter((b) => b.role !== 'visitor' || b.visible).map((b) => b.party)
    expect(roles.every((x) => x !== null)).toBe(true)
    expect(roles.filter((x) => x === 'flashlight')).toHaveLength(1)
    const conga = roles.filter((x) => x === 'conga').length
    expect(conga >= 3 && conga <= CONGA_MAX).toBe(true)
    expect(roles.filter((x) => x === 'pizza')).toHaveLength(1)
    expect(roles.filter((x) => x === 'dance').length).toBeGreaterThan(5)
    // O especialista que estava trabalhando na sala também entra na festa.
    const visitors = crowd.list.filter((b) => b.role === 'visitor' && b.visible)
    expect(visitors.length).toBeGreaterThan(0)
    expect(visitors.every((b) => b.party !== null)).toBe(true)
    // E as falas recebem os papéis.
    expect(crowd.partyRoles.size).toBeGreaterThanOrEqual(20)
    s.dispose()
  })

  it('≥ 4 passos de dança na batida, trenzinho andando em volta de uma ilha, lanterna procurando o disjuntor, pizza na mesa', () => {
    const { s, whole, run } = party()
    s.updateView(whole)
    const crowd = s.crowd
    const actions = new Set<string>()
    const props = new Set<string>()
    let congaMoved = false
    let deskSit = false
    for (let k = 0; k < 120; k++) {
      run(0.25)
      for (const b of crowd.list) {
        actions.add(b.action)
        if (b.prop) props.add(b.prop)
        if (b.party === 'conga' && b.puppet && b.speed > 0.2) congaMoved = true
        if (b.party === 'pizza' && b.seat === 'desk' && b.sit >= 1) deskSit = true
      }
    }
    for (const m of DANCE_MOVES) expect(actions.has(m), m).toBe(true)
    expect(actions.has('conga') && actions.has('flashlight') && actions.has('pizza')).toBe(true)
    expect([...props].sort()).toEqual(expect.arrayContaining(['flashlight', 'pizza']))
    expect(congaMoved).toBe(true)
    expect(deskSit).toBe(true)
    // Trenzinho em fila: vagões vizinhos a ~CONGA_GAP um do outro.
    const wagons = crowd.list.filter((b) => b.party === 'conga').sort((a, b) => a.partySlot - b.partySlot)
    expect(wagons.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < wagons.length; i++) expect(Math.hypot(wagons[i].x - wagons[i - 1].x, wagons[i].z - wagons[i - 1].z)).toBeLessThan(CONGA_GAP * 1.6)
    s.dispose()
  })

  it('sem bola nem manchas: aviõezinhos e o confete de quem comemora dançando só nas zonas à vista PERTO/MÉDIO; LONGE fica no escuro', () => {
    const { s, whole, near, zoneOf, run } = party()
    const confetti = vi.spyOn(s.particles, 'confettiBurst')
    expect(Object.keys(s.energy.kit.geo)).not.toContain('ball')
    expect(Object.keys(s.energy.kit.mat)).not.toContain('spot')
    s.updateView(whole)
    run(3)
    const pools = s.energy as unknown as { pools: { planes: { count: number } } }
    expect(pools.pools.planes.count).toBeGreaterThan(0)
    run(4)
    // Quem dança comemora (a reação) e solta o confete pela cabeça.
    expect(confetti).toHaveBeenCalled()
    // De perto de uma ilha: as zonas fora da tela não têm festa.
    s.updateView(near)
    run(0.2)
    const off = ZONES.filter((z) => s['rooms'].get('office')!.zone(z.id).lod.culled)
    expect(off.length).toBeGreaterThan(0)
    for (const z of off) expect(zoneOf(z.id).eligible).toBe(false)
    // LONGE: sem aviões; o escritório segue escuro com a emergência piscando.
    s.updateView(camera({ tx: 20, ty: 0, tz: 9, yaw: 0, pitch: 0.85, distance: 60 }))
    run(0.5)
    expect(pools.pools.planes.count).toBe(0)
    expect(ZONES.every((z) => s.energy.zoneDark(z.id))).toBe(true)
    s.dispose()
  })

  it('volta da luz: a música para (susto), os aviões somem, todo mundo corre para a mesa e quem tinha tarefa retoma', () => {
    const { s, whole, run, now } = party()
    s.updateView(whole)
    run(6)
    s.setPower(power('cheia'), 'luz-voltou', now())
    const crowd = s.crowd
    expect(crowd.partyOn).toBe(false)
    expect(crowd.list.every((b) => b.party === null && !b.puppet)).toBe(true)
    expect(crowd.list.filter((b) => b.visible).every((b) => b.reaction === 'alert' || b.pending.includes('alert') || b.reaction === 'scared')).toBe(true)
    run(0.2)
    const workers = crowd.list.filter((b) => b.phase === 'working' && b.role === 'desk')
    expect(workers.length).toBeGreaterThan(0)
    expect(workers.every((b) => b.mode === 'work' && b.goal.gait === 'run')).toBe(true)
    expect(crowd.list.filter((b) => b.role === 'desk' && b.phase === 'idle').every((b) => b.mode === 'back' || b.mode === 'sleep' || b.mode === 'free')).toBe(true)
    run(3)
    expect((s.energy as unknown as { pools: { planes: { count: number } } }).pools.planes.count).toBe(0)
    run(8)
    expect(workers.every((b) => b.sit === 1 && b.mode === 'work')).toBe(true)
    s.dispose()
  })
})

describe('dança no ritmo', () => {
  it('todos trocam de passo juntos a cada compasso, cada um começando num passo', () => {
    const seeds = [0.1, 0.9, 2.2, 3.7, 5.1]
    const at = (beat: number): string[] => seeds.map((k) => danceMove(k, beat))
    expect(new Set(at(0)).size).toBeGreaterThan(1)
    expect(at(0)).toEqual(at(BAR_BEATS - 0.01))
    expect(at(BAR_BEATS)).not.toEqual(at(0))
    expect(beatAt(60 / 118)).toBeCloseTo(1)
  })
})
