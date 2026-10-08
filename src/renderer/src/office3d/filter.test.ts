import { describe, expect, it, vi } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { setStatus, type Brain } from './brain'
import { Crowd } from './crowd'
import { EngineFilter, type FilterStorage } from './engineFilter'
import { seatOf } from './furniture'
import { layoutOffice, type Office3DLayout, type ProjectLayout } from './layout'

function model(conv: string, roomId: string | null, extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key: `conv:${conv}`, convId: conv, roomId, role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${conv}`, active: false, activity: null, bubble: null, label: '', ...extra
  }
}

const CENTRAL = model('central', null, { placement: { kind: 'destination', papel: 'central' } })

/** Projetos a (2 agentes) e b (1), mais a Central; cérebros num Crowd de sorteio fixo. */
function office(extra: OfficeCharacterModel[] = [], prev?: Office3DLayout) {
  const chars = [model('a0', 'a'), model('a1', 'a'), model('b0', 'b'), CENTRAL, ...extra]
  const layout = layoutOffice({ rooms: ['a', 'b'].map((id) => ({ id, projectKey: id, name: id, icon: null, principals: 2 })), characters: chars }, prev)
  return layout
}

function crowdOf(layout: Office3DLayout): { crowd: Crowd; brain: (key: string) => Brain; sync: (l: Office3DLayout) => void } {
  const crowd = new Crowd(7)
  const sync = (l: Office3DLayout): void => {
    crowd.syncRooms(l.rooms)
    const rooms = new Map(l.rooms.map((r) => [r.id, r] as const))
    for (const c of l.characters) crowd.upsert(c, false, rooms)
  }
  sync(layout)
  for (const b of crowd.list) setStatus(b, { phase: 'idle', tool: null, contextPct: null, usageOut: false, stalled: false, idleSince: 0 }, 0)
  return { crowd, brain: (key) => crowd.brains.get(key)!, sync }
}

function run(crowd: Crowd, seconds: number, dt = 0.1): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) crowd.step(dt, crowd.t + dt, 0, 30)
}

const deskOf = (b: Brain): { x: number; z: number } => seatOf(b.desk!)

describe('filtro de projeto no escritório (crowd + cérebro)', () => {
  it('filtrado: quem é de outro projeto levanta e sai andando pela porta; o projeto filtrado e a Central ficam', () => {
    const layout = office()
    const { crowd, brain } = crowdOf(layout)
    run(crowd, 1)
    const b0 = brain('conv:b0')
    const desk = { ...b0.desk! }
    crowd.setFilter('a', () => false)
    run(crowd, 0.5)
    expect(b0.mode).toBe('leave')
    expect(b0.visible).toBe(true)
    run(crowd, 40)
    expect(b0.visible).toBe(false)
    expect(b0.mode).toBe('away')
    expect(b0.desk).toEqual(desk)
    for (const k of ['conv:a0', 'conv:a1', 'conv:central']) {
      expect(brain(k).visible, k).toBe(true)
      expect(brain(k).outside, k).toBe(false)
    }
    // A Central nunca sai, seja qual for o filtro.
    crowd.setFilter('b', () => false)
    run(crowd, 1)
    expect(brain('conv:central').outside).toBe(false)
    expect(brain('conv:central').mode).not.toBe('leave')
  })

  it('ao limpar o filtro, quem estava fora entra pela porta e volta sentado à MESMA mesa', () => {
    const { crowd, brain } = crowdOf(office())
    const b0 = brain('conv:b0')
    crowd.setFilter('a', () => false)
    run(crowd, 40)
    expect(b0.visible).toBe(false)
    const doorX = crowd.doorOut(b0)!.x
    crowd.setFilter(null, () => false)
    run(crowd, 0.2)
    expect(b0.visible).toBe(true)
    expect(Math.abs(b0.x - doorX)).toBeLessThan(0.5)
    // Ocioso: senta na mesa dele, descansa e só então sai para o lazer.
    const seat = deskOf(b0)
    let sat = false
    for (let i = 0; i < 400 && !sat; i++) {
      run(crowd, 0.1)
      sat = b0.sit === 1 && b0.seat === 'chair' && Math.hypot(b0.x - seat.x, b0.z - seat.z) < 0.02
    }
    expect(sat).toBe(true)
  })

  it('fora da tela (ou motor pausado): a troca vai direto ao fim, sem andar', () => {
    const { crowd, brain } = crowdOf(office())
    const b0 = brain('conv:b0')
    crowd.setFilter('a', () => true)
    expect(b0.visible).toBe(false)
    expect(b0.mode).toBe('away')
    crowd.setFilter(null, () => true)
    const seat = deskOf(b0)
    expect(b0.visible).toBe(true)
    expect([b0.sit, b0.seat]).toEqual([1, 'chair'])
    expect(Math.hypot(b0.x - seat.x, b0.z - seat.z)).toBeLessThan(0.02)
    run(crowd, 2)
    expect(b0.mode).toBe('free')
    expect(b0.sit).toBe(1)
  })

  it('quem chega de projeto filtrado fora já nasce lá fora; a reserva da ilha e a mesa dele não mudam', () => {
    const l0 = office()
    const { crowd, brain, sync } = crowdOf(l0)
    crowd.setFilter('a', () => true)
    const l1 = office([model('b1', 'b')], l0)
    sync(l1)
    const b1 = brain('conv:b1')
    expect(b1.outside).toBe(true)
    expect(b1.visible).toBe(false)
    const islandB = l1.rooms[0].islands.find((i) => i.projectId === 'b')
    expect(islandB).toBeDefined()
    expect(l1.characters.find((c) => c.key === 'conv:b1')?.deskIndex).not.toBeNull()
  })
})

describe('EngineFilter: escolha salva, filtro em vigor e lista do HUD', () => {
  const store = (initial: string | null): FilterStorage & { value: string | null } => {
    const s = {
      value: initial,
      get: () => s.value,
      set: (id: string | null) => {
        s.value = id
      }
    }
    return s
  }
  const proj = (id: string, agents = 1): ProjectLayout => ({ id, name: id, icon: null, color: '#3c9add', islands: [], agents })

  it('a escolha salva vale quando o projeto chega; com o feed ainda vazio fica guardada', () => {
    const apply = vi.fn()
    const emit = vi.fn()
    const s = store('b')
    const f = new EngineFilter(apply, emit, s)
    expect(f.choice).toBe('b')
    f.feed([])
    expect(f.current).toBeNull()
    expect(s.value).toBe('b')
    f.feed([proj('a'), proj('b')])
    expect(f.current).toBe('b')
    expect(apply).toHaveBeenLastCalledWith('b')
    expect(emit).toHaveBeenLastCalledWith([proj('a'), proj('b')], 'b')
  })

  it('projeto que sumiu do escritório volta para Todos e apaga a escolha salva', () => {
    const apply = vi.fn()
    const changed = vi.fn()
    const s = store(null)
    const f = new EngineFilter(apply, () => {}, s)
    f.onChange(changed)
    f.feed([proj('a'), proj('b')])
    f.set('b')
    expect(s.value).toBe('b')
    expect(changed).toHaveBeenLastCalledWith('b')
    f.feed([proj('a')])
    expect(f.current).toBeNull()
    expect(s.value).toBeNull()
    expect(apply).toHaveBeenLastCalledWith(null)
    expect(changed).toHaveBeenLastCalledWith(null)
  })

  it('a lista vai ao HUD só quando muda (projetos, agentes ou filtro)', () => {
    const emit = vi.fn()
    const f = new EngineFilter(() => {}, emit, store(null))
    f.feed([proj('a', 2)])
    f.feed([proj('a', 2)])
    expect(emit).toHaveBeenCalledTimes(1)
    f.feed([proj('a', 3)])
    f.set('a')
    expect(emit).toHaveBeenCalledTimes(3)
  })
})
