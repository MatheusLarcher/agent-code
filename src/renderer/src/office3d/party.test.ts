import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { cameraPosition, type CameraPose } from './cameraRig'
import { BAR_BEATS, beatAt, DANCE_MOVES, danceMove } from './dance'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { layoutOffice, type RoomLayout } from './layout'
import type { RoomPartyFx } from './party'
import { CONGA_GAP } from './partyPlan'
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
  const near = (r: RoomLayout): PerspectiveCamera => camera({ tx: r.x + r.width / 2, ty: 0, tz: r.z + r.depth / 2, yaw: 0, pitch: 0.8, distance: 9 })
  const fxOf = (id: string): RoomPartyFx => (s.energy as unknown as { rooms: Map<string, { party: RoomPartyFx }> }).rooms.get(id)!.party
  let t = 0
  const run = (secs: number): void => {
    for (let k = 0; k < Math.round(secs / 0.05); k++) s.animate((t += 0.05), 0.05)
  }
  s.setPower(power('apagao'), 'apagao', 0)
  return { s, layout, near, fxOf, run, now: () => t }
}

describe('festa no apagão: todo mundo para e festeja', () => {
  it('papéis por sala: lanterna em toda sala, trenzinho nas de slot ímpar, pizza nas outras, o resto dança — especialistas inclusos', () => {
    // Aos 45 s do loop os especialistas delegados estão trabalhando nas salas.
    const { s, layout, run } = party(T0 + 45_000)
    run(0.1)
    const crowd = s.crowd
    expect(crowd.partyOn).toBe(true)
    for (const r of layout.rooms) {
      const members = crowd.list.filter((b) => b.roomId === r.id && (b.role !== 'visitor' || b.visible))
      const roles = members.map((b) => b.party)
      expect(roles.every((x) => x !== null), r.name).toBe(true)
      expect(roles.filter((x) => x === 'flashlight'), r.name).toHaveLength(1)
      if (r.slot % 2 === 1) expect(roles.filter((x) => x === 'conga').length, r.name).toBeGreaterThanOrEqual(3)
      else expect(roles.filter((x) => x === 'pizza'), r.name).toHaveLength(1)
    }
    // O especialista que estava trabalhando na sala também entra na festa.
    const visitors = crowd.list.filter((b) => b.role === 'visitor' && b.visible)
    expect(visitors.length).toBeGreaterThan(0)
    expect(visitors.every((b) => b.party !== null)).toBe(true)
    // E as falas recebem os papéis.
    expect(crowd.partyRoles.size).toBeGreaterThanOrEqual(20)
    s.dispose()
  })

  it('≥ 4 passos de dança na batida, trenzinho andando em volta do tapete, lanterna procurando o disjuntor, pizza na mesa', () => {
    const { s, layout, near, run } = party()
    s.updateView(near(layout.rooms[0]))
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
    const congaRoom = layout.rooms.find((r) => r.slot % 2 === 1)!
    const wagons = crowd.list.filter((b) => b.roomId === congaRoom.id && b.party === 'conga').sort((a, b) => a.partySlot - b.partySlot)
    for (let i = 1; i < wagons.length; i++) expect(Math.hypot(wagons[i].x - wagons[i - 1].x, wagons[i].z - wagons[i - 1].z)).toBeLessThan(CONGA_GAP * 1.6)
    s.dispose()
  })

  it('bola desce, manchas, aviõezinhos e confete só nas salas à vista PERTO/MÉDIO; LONGE fica no escuro com a emergência', () => {
    const { s, layout, near, fxOf, run } = party()
    const confetti = vi.spyOn(s.particles, 'confettiBurst')
    const [r0] = layout.rooms
    s.updateView(near(r0))
    run(3)
    const fx = fxOf(r0.id)
    expect(fx.drop).toBe(1)
    expect(fx.root.visible).toBe(true)
    expect(fx['spots'].visible).toBe(true)
    expect(fx.ball.position.y).toBeLessThan(2.3)
    const pools = s.energy as unknown as { pools: { planes: { count: number } } }
    expect(pools.pools.planes.count).toBeGreaterThan(0)
    run(4)
    expect(confetti).toHaveBeenCalled()
    // Sala fora da tela: nada da festa roda nela.
    const off = layout.rooms.filter((r) => s['rooms'].get(r.id)!.lod.culled)
    expect(off.length).toBeGreaterThan(0)
    for (const r of off) expect(fxOf(r.id).eligible).toBe(false)
    // LONGE: sem bola nem aviões; a sala segue escura com a emergência piscando.
    s.updateView(camera({ tx: 20, ty: 0, tz: 9, yaw: 0, pitch: 0.85, distance: 60 }))
    run(0.5)
    expect(layout.rooms.every((r) => !fxOf(r.id).root.visible)).toBe(true)
    expect(pools.pools.planes.count).toBe(0)
    expect(layout.rooms.every((r) => s.energy.isDark(r.id))).toBe(true)
    s.dispose()
  })

  it('volta da luz: a música para (susto), a bola sobe, todo mundo corre para a mesa e quem tinha tarefa retoma', () => {
    const { s, layout, near, fxOf, run, now } = party()
    s.updateView(near(layout.rooms[0]))
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
    expect(fxOf(layout.rooms[0].id).root.visible).toBe(false)
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
