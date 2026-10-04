import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { setStatus, type Brain } from './brain'
import { Crowd } from './crowd'
import { layoutOffice, type Office3DLayout } from './layout'
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
