import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { CALL_JUMP_S, setStatus, type Brain } from './brain'
import { Crowd } from './crowd'
import { layoutOffice, type Office3DLayout } from './layout'
import { meetingSpots, TV_SIDE } from './meetingRoom'
import { CENTRAL_SPOT, MEMORY_SPOT_X, MEMORY_SPOTS_Z, MEMORY_WAIT, OFFICE } from './officePlan'

function model(key: string, roomId: string | null, extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key, convId: key, roomId, role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: key, active: false, activity: null, bubble: null, label: '', ...extra
  }
}

const memoria = (p: string): OfficeCharacterModel => model(`role:${p}:memoria`, p, { role: 'memoria', placement: { kind: 'destination', papel: 'arquivo-memorias' }, active: true })
const central = model('conv:central', null, { placement: { kind: 'destination', papel: 'central' } })

function world(chars: OfficeCharacterModel[], projects: string[]): { crowd: Crowd; layout: Office3DLayout; brain: (k: string) => Brain } {
  const layout = layoutOffice({ rooms: projects.map((id) => ({ id, projectKey: id, name: id, icon: null, principals: 1 })), characters: chars })
  const crowd = new Crowd(3)
  crowd.syncRooms(layout.rooms)
  const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
  for (const c of layout.characters) crowd.upsert(c, false, rooms)
  for (const b of crowd.list) setStatus(b, { phase: b.role === 'fixed' ? 'working' : 'idle', tool: null, contextPct: null, usageOut: false, stalled: false, idleSince: 0 }, 0)
  return { crowd, layout, brain: (k) => crowd.brains.get(k)! }
}

function run(crowd: Crowd, seconds: number, dt = 0.1): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) crowd.step(dt, crowd.t + dt, 0, 30)
}

describe('destinos fixos no escritório', () => {
  it('memória vai à estante de Memórias: 3 de pé diante dela, o 4º espera atrás; ninguém no corredor', () => {
    const ps = ['a', 'b', 'c', 'd']
    const { crowd, brain } = world([...ps.map((p) => model(`conv:${p}`, p)), ...ps.map(memoria)], ps)
    run(crowd, 30)
    const at = ps.map((p) => brain(`role:${p}:memoria`))
    MEMORY_SPOTS_Z.forEach((z, i) => expect(Math.hypot(at[i].x - MEMORY_SPOT_X, at[i].z - z), `memória ${i}`).toBeLessThan(0.05))
    expect(Math.hypot(at[3].x - MEMORY_WAIT.x, at[3].z - MEMORY_WAIT.z)).toBeLessThan(0.05)
    for (const b of at) {
      expect(b.visible && b.mode === 'fixed' && b.style === 'archive').toBe(true)
      expect(b.x > OFFICE.x0 && b.x < OFFICE.x1 && b.z > OFFICE.z0 && b.z < OFFICE.z1).toBe(true)
      expect(b.action).toBe('readBook')
    }
  })

  it('o lazer da estante não toma o lugar de quem está trabalhando nela', () => {
    const { crowd, brain } = world([model('conv:a', 'a'), model('conv:b', 'b'), model('conv:c', 'b'), memoria('a')], ['a', 'b'])
    const mem = brain('role:a:memoria')
    for (const k of ['conv:a', 'conv:b']) {
      const p = crowd.claim(brain(k), 'shelf')
      expect(p).not.toBeNull()
      expect(Math.hypot(p!.x - mem.home.x, p!.z - mem.home.z)).toBeGreaterThan(0.1)
    }
    // 3 lugares, 1 da memória: o terceiro não acha lugar.
    expect(crowd.claim(brain('conv:c'), 'shelf')).toBeNull()
  })

  it('a Central vai direto ao console e fica de pé olhando a tela; o filtro de projeto não a tira', () => {
    const { crowd, brain } = world([model('conv:a', 'a'), central], ['a'])
    const c = brain('conv:central')
    expect(c.projectId).toBeNull()
    expect(c.style).toBe('console')
    crowd.setFilter('a', () => false)
    run(crowd, 15)
    expect(Math.hypot(c.x - CENTRAL_SPOT.x, c.z - CENTRAL_SPOT.z)).toBeLessThan(0.05)
    expect(Math.abs(c.yaw - CENTRAL_SPOT.yaw)).toBeLessThan(0.05)
    expect([c.mode, c.visible, c.desk]).toEqual(['fixed', true, null])
    expect(c.action).toBe('type')
  })
})

describe('sala de reunião: quem testa na TV e quem espera a vez', () => {
  it('os lugares (ao lado da TV e as cadeiras de espera) são chão livre e alcançáveis da porta', () => {
    const { crowd } = world([model('conv:a', 'a')], ['a'])
    const grid = crowd.grid('office')!
    const f = crowd.furniture('office')!
    const spots = meetingSpots(['k0', 'k1', 'k2', 'k3', 'k4', 'k5'])
    const out = new Float32Array(64)
    for (const [key, s] of spots) {
      expect(grid.isFree(s.standX, s.standZ), key).toBe(true)
      expect(grid.findPath(f.doorIn.x, f.doorIn.z, s.standX, s.standZ, out), key).toBeGreaterThan(0)
    }
    expect(spots.get('k0')).toMatchObject({ role: 'present', seat: false, x: TV_SIDE.x, z: TV_SIDE.z })
    expect([...spots.values()].slice(1).every((s) => s.role === 'wait' && s.seat)).toBe(true)
  })

  it('o 1º da fila fica de pé ao lado da TV olhando para ela; o 2º senta à mesa esperando; sem uso, voltam às mesas', () => {
    const { crowd, brain } = world([model('conv:a', 'a', { active: true }), model('conv:b', 'a', { active: true })], ['a'])
    for (const k of ['conv:a', 'conv:b']) setStatus(brain(k), { phase: 'working', tool: 'web', contextPct: null, usageOut: false, stalled: false, idleSince: null }, 0)
    run(crowd, 2)
    crowd.setVenues(meetingSpots(['conv:a', 'conv:b']))
    run(crowd, 40)
    const a = brain('conv:a')
    const b = brain('conv:b')
    expect([a.mode, a.arrived, a.sit]).toEqual(['meeting', true, 0])
    expect(Math.hypot(a.x - TV_SIDE.x, a.z - TV_SIDE.z)).toBeLessThan(0.05)
    expect(a.look).toBe('point')
    expect([b.mode, b.seat, b.sit]).toEqual(['meeting', 'chair', 1])
    // A vez passa: b vai para o lado da TV.
    crowd.setVenues(meetingSpots(['conv:b']))
    run(crowd, 30)
    expect(Math.hypot(b.x - TV_SIDE.x, b.z - TV_SIDE.z)).toBeLessThan(0.05)
    expect(a.mode).toBe('work')
    expect(a.seat).toBe('chair')
    crowd.setVenues(meetingSpots([]))
    run(crowd, 30)
    expect([b.mode, b.sit]).toEqual(['work', 1])
  })
})

describe('o chamado do agente (app_chamar_usuario)', () => {
  it('ao lado da TV acenando para a câmera mesmo com o turno terminado; depois de CALL_JUMP_S alterna pulo e aceno; o 2º chamado espera sentado acenando; acabou, volta à mesa', () => {
    const { crowd, brain } = world([model('conv:a', 'a'), model('conv:b', 'a'), model('conv:c', 'a', { active: true })], ['a'])
    // c testa no navegador; a e b chamaram (b depois): os chamados vêm antes do teste.
    setStatus(brain('conv:c'), { phase: 'working', tool: 'web', contextPct: null, usageOut: false, stalled: false, idleSince: null }, 0)
    run(crowd, 2)
    crowd.setVenues(meetingSpots([{ key: 'conv:a', call: true }, { key: 'conv:b', call: true }, 'conv:c']))
    run(crowd, 30)
    const [a, b, c] = ['conv:a', 'conv:b', 'conv:c'].map(brain)
    expect([a.mode, a.arrived, a.sit, a.faceCamera, a.look, a.action]).toEqual(['meeting', true, 0, true, 'camera', 'wave'])
    expect(Math.hypot(a.x - TV_SIDE.x, a.z - TV_SIDE.z)).toBeLessThan(0.05)
    expect([b.mode, b.seat, b.sit, b.look]).toEqual(['meeting', 'chair', 1, 'camera'])
    expect([c.mode, c.seat]).toEqual(['meeting', 'chair'])
    // O sentado acena de vez em quando.
    const seated = new Set<string>()
    for (let i = 0; i < 120; i++) {
      run(crowd, 0.1)
      seated.add(b.action)
    }
    expect([...seated].sort()).toEqual(['sitIdle', 'wave'])
    // Sem resposta: depois de ~60 s no lugar, pula e acena, alternando.
    const late = new Set<string>()
    run(crowd, CALL_JUMP_S - a.modeT)
    for (let i = 0; i < 80; i++) {
      run(crowd, 0.1)
      late.add(a.action)
    }
    expect([...late].sort()).toEqual(['jump', 'wave'])
    expect(Math.hypot(a.x - TV_SIDE.x, a.z - TV_SIDE.z)).toBeLessThan(0.05)
    // a foi atendido: b assume o lado da TV; c continua esperando.
    crowd.setVenues(meetingSpots([{ key: 'conv:b', call: true }, 'conv:c']))
    run(crowd, 30)
    expect(Math.hypot(b.x - TV_SIDE.x, b.z - TV_SIDE.z)).toBeLessThan(0.05)
    expect(b.action).toBe('wave')
    expect([a.mode, a.venue]).toEqual(['free', null])
    expect(Math.hypot(a.x - TV_SIDE.x, a.z - TV_SIDE.z)).toBeGreaterThan(1)
    crowd.setVenues(meetingSpots([]))
    run(crowd, 30)
    expect([b.mode, b.venue]).toEqual(['free', null])
    expect(Math.hypot(b.x - TV_SIDE.x, b.z - TV_SIDE.z)).toBeGreaterThan(1)
  })
})
