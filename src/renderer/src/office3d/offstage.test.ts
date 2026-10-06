import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel, OfficeModel } from '../office/adapter/model'
import { setStatus, type Brain } from './brain'
import { Crowd } from './crowd'
import { layoutOffice, type Office3DLayout } from './layout'
import { managerSeat } from './meetingRoom'
import { isOffstage } from './offstage'

function model(key: string, extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key, convId: key, roomId: 'a', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: key, active: false, activity: null, bubble: null, label: '', ...extra
  }
}

const manager = (extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel =>
  model('conv:p', { placement: { kind: 'destination', papel: 'reuniao-cabeceira' }, ...extra })
const heir = (): OfficeCharacterModel => model('conv:i', { seed: 'conv:p', handoverFrom: 'conv:p', active: true })

const idle = { phase: 'idle' as const, tool: null, contextPct: null, usageOut: false, stalled: false, idleSince: 0 }
const working = { ...idle, phase: 'working' as const, idleSince: null }

/** O escritório como a cena o mantém: cada feed relayouta, cria/atualiza na ordem do layout e esquece quem saiu. */
function office(): { crowd: Crowd; sync: (chars: OfficeCharacterModel[]) => Office3DLayout; brain: (k: string) => Brain } {
  const crowd = new Crowd(3)
  let prev: Office3DLayout | undefined
  const sync = (chars: OfficeCharacterModel[]): Office3DLayout => {
    const m: OfficeModel = { rooms: [{ id: 'a', projectKey: 'a', name: 'a', icon: null, principals: 2 }], characters: chars }
    const layout = layoutOffice(m, prev)
    prev = layout
    crowd.syncRooms(layout.rooms)
    const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
    const seen = new Set<string>()
    for (const c of layout.characters) {
      seen.add(c.key)
      const fresh = !crowd.brains.has(c.key)
      const b = crowd.upsert(c, false, rooms)
      if (fresh) setStatus(b, c.model.active ? working : idle, crowd.t)
    }
    for (const k of [...crowd.brains.keys()]) if (!seen.has(k)) crowd.forget(k)
    return layout
  }
  return { crowd, sync, brain: (k) => crowd.brains.get(k)! }
}

function run(crowd: Crowd, seconds: number, dt = 0.1): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) crowd.step(dt, crowd.t + dt, 0, 30)
}

describe('plano enviado: o Manager sai da sala de reunião e vai para o PC trabalhar', () => {
  for (const order of ['herdeiro antes', 'herdeiro depois'] as const) {
    it(`na mesma passagem o Manager some e o agente da implementação levanta da cabeceira e senta na mesa dele (${order})`, () => {
      const { crowd, sync, brain } = office()
      sync([manager()])
      run(crowd, 20)
      const p = brain('conv:p')
      const seat = managerSeat(0)!
      expect([p.visible, p.sit, p.seat]).toEqual([true, 1, 'chair'])
      expect(Math.hypot(p.x - seat.x, p.z - seat.z)).toBeLessThan(0.05)
      const at = { x: p.x, z: p.z }
      // O envio: o plano deixa de estar aberto e a implementação nasce (na ordem que o feed trouxer).
      const sent = manager({ offstage: true })
      const layout = sync(order === 'herdeiro antes' ? [heir(), sent] : [sent, heir()])
      const i = brain('conv:i')
      expect(p.visible).toBe(false)
      expect([i.visible, i.sit, i.seat, i.mode]).toEqual([true, 1, 'chair', 'meeting'])
      expect(Math.hypot(i.x - at.x, i.z - at.z)).toBeLessThan(0.01)
      // O Manager continua no layout (a TV acha o plano dele), lá fora e sem ocupar a cabeceira.
      expect(layout.characters.find((c) => c.key === 'conv:p')?.spot).toBe('offstage')
      expect(layout.characters.filter((c) => c.spot === 'manager')).toHaveLength(0)
      run(crowd, 40)
      expect([i.mode, i.seat, i.sit]).toEqual(['work', 'chair', 1])
      expect(i.desk).not.toBeNull()
      expect(Math.hypot(i.x - at.x, i.z - at.z)).toBeGreaterThan(2)
      expect([p.visible, p.mode, isOffstage(p)]).toEqual([false, 'away', true])
    })
  }

  it('o app abre com o plano já enviado: ninguém na cabeceira e o agente da implementação já sentado na mesa dele', () => {
    const { crowd, sync, brain } = office()
    sync([manager({ offstage: true }), heir()])
    const p = brain('conv:p')
    const i = brain('conv:i')
    expect(p.visible).toBe(false)
    expect([i.visible, i.sit, i.mode]).toEqual([true, 1, 'init'])
    const desk = { x: i.x, z: i.z }
    run(crowd, 20)
    expect(Math.hypot(i.x - desk.x, i.z - desk.z)).toBeLessThan(0.01)
    expect(p.visible).toBe(false)
  })

  it('o filtro de projeto não traz o Manager fora de cena de volta; planejamento aberto de novo, ele entra pela porta e senta à cabeceira', () => {
    const { crowd, sync, brain } = office()
    sync([manager({ offstage: true }), heir()])
    const p = brain('conv:p')
    crowd.setFilter('outro', () => true)
    crowd.setFilter(null, () => true)
    run(crowd, 5)
    expect([p.visible, p.outside]).toEqual([false, true])
    // O plano volta a estar aberto (ex.: a implementação foi apagada).
    sync([manager()])
    run(crowd, 40)
    const seat = managerSeat(0)!
    expect([p.visible, p.outside, p.sit]).toEqual([true, false, 1])
    expect(Math.hypot(p.x - seat.x, p.z - seat.z)).toBeLessThan(0.05)
  })
})
