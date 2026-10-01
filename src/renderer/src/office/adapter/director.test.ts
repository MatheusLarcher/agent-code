import { describe, expect, it, vi } from 'vitest'
import { OfficeState } from '../engine/officeState'
import { buildBuilding } from '../layout'
import { IDLE_DELAY_MS, OfficeDirector, type Scheduler } from './director'
import { deriveOfficeModel, type OfficeCharacterModel, type OfficeModel } from './model'
import { NOW, conv, feed, track } from './testFeed'

/** Relógio manual: run() dispara o que venceu. */
function manualScheduler(): Scheduler & { advance(ms: number): void } {
  let t = 0
  let seq = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn, ms) {
      jobs.set(++seq, { at: t + ms, fn })
      return seq
    },
    clearTimeout(h) {
      jobs.delete(h as number)
    },
    advance(ms) {
      t += ms
      for (const [k, j] of [...jobs]) if (j.at <= t) (jobs.delete(k), j.fn())
    }
  }
}

function setup() {
  const state = new OfficeState(buildBuilding({ rooms: [] }))
  const scheduler = manualScheduler()
  const leisure = { wake: vi.fn(), forget: vi.fn() }
  const director = new OfficeDirector(state, { scheduler, leisure })
  return { state, scheduler, director, leisure }
}

function principal(over: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key: 'conv:a',
    convId: 'a',
    roomId: 'r',
    role: 'principal',
    placement: { kind: 'seat', seatKind: 'principal' },
    seed: 'conv:a',
    active: false,
    activity: null,
    bubble: null,
    label: 'parado',
    ...over
  }
}
const room = { id: 'r', projectKey: 'C:/r', name: 'r', icon: null, principals: 1 }
const model = (...characters: OfficeCharacterModel[]): OfficeModel => ({ rooms: [room], characters })

describe('OfficeDirector', () => {
  it('volta ao ocioso só depois de 300 ms; ferramenta nova na janela cancela', () => {
    const { state, scheduler, director } = setup()
    director.apply(model(principal({ active: true, activity: 'type' })))
    const id = director.idOf('conv:a')!
    expect(state.getCharacter(id)!.activity).toBe('type')
    director.apply(model(principal()))
    scheduler.advance(IDLE_DELAY_MS - 1)
    expect(state.getCharacter(id)!.isActive).toBe(true)
    director.apply(model(principal({ active: true, activity: 'read' })))
    scheduler.advance(IDLE_DELAY_MS)
    expect(state.getCharacter(id)!.activity).toBe('read')
    director.apply(model(principal()))
    scheduler.advance(IDLE_DELAY_MS)
    expect(state.getCharacter(id)!.isActive).toBe(false)
    expect(state.getCharacter(id)!.activity).toBeNull()
  })

  it('balão, rótulo e contexto só quando mudam', () => {
    const { state, director } = setup()
    const show = vi.spyOn(state, 'showBubble')
    const label = vi.spyOn(state, 'setLabel')
    director.apply(model(principal({ bubble: 'permissao', context: { tokens: 10, max: 100 } })))
    director.apply(model(principal({ bubble: 'permissao', context: { tokens: 10, max: 100 } })))
    expect(show).toHaveBeenCalledTimes(1)
    expect(label).not.toHaveBeenCalled()
    const ch = state.getCharacter(director.idOf('conv:a')!)!
    expect(ch.bubble).toBe('permissao')
    expect(ch.maxContextTokens).toBe(100)
    director.apply(model(principal({ label: 'Edit a.ts' })))
    expect(ch.bubble).toBeNull()
    expect(ch.label).toBe('Edit a.ts')
  })

  it('mapa de ids estável entre applies e lookup', () => {
    const { director, leisure, state } = setup()
    const f = feed({ conversations: [conv('a'), conv('b', { cwd: 'D:/b' })] })
    director.apply(deriveOfficeModel(f, NOW))
    const a = director.idOf('conv:a')!
    const b = director.idOf('conv:b')!
    director.apply(deriveOfficeModel(f, NOW))
    expect(director.idOf('conv:a')).toBe(a)
    expect(director.lookup(b)).toEqual({ key: 'conv:b', convId: 'b', role: 'principal' })
    // Sai e volta: mesmo id.
    director.apply(deriveOfficeModel(feed({ conversations: [conv('b', { cwd: 'D:/b' })] }), NOW))
    expect(director.idOf('conv:a')).toBeNull()
    expect(leisure.forget).toHaveBeenCalledWith(a)
    director.apply(deriveOfficeModel(f, NOW))
    expect(director.idOf('conv:a')).toBe(a)
    director.onEvent('a')
    expect(leisure.wake).toHaveBeenCalledWith(state.getCharacter(a))
  })

  it('duas salas → layout com duas salas; refaz só quando muda', () => {
    const { director, state } = setup()
    const rebuild = vi.spyOn(state, 'rebuildFromLayout')
    const f = feed({ conversations: [conv('a'), conv('b', { cwd: 'D:/b' })] })
    director.apply(deriveOfficeModel(f, NOW))
    director.apply(deriveOfficeModel(f, NOW))
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(state.getLayout().rooms.map((r) => r.name)).toEqual(['alpha', 'b'])
  })

  it('subagente genérico entra e sai; especialista no slot certo e reforco', () => {
    const { director, state } = setup()
    const gen = track('g', { subagentType: 'Explore' })
    const tracks = { a: { g: gen, t1: track('t1', { startedAt: NOW - 2000 }), t2: track('t2', { startedAt: NOW - 1000 }) } }
    director.apply(deriveOfficeModel(feed({ conversations: [conv('a')], tracks }), NOW))
    const sub = director.idOf('track:g')!
    expect(sub).toBeLessThan(0)
    expect(state.getCharacter(sub)!.parentAgentId).toBe(director.idOf('conv:a'))
    const seatOf = (key: string) => state.getCharacter(director.idOf(key)!)!.seatId
    expect(seatOf('role:c:/proj/alpha:executor')).toBe('c:/proj/alpha:esp:executor')
    expect(seatOf('role:c:/proj/alpha:executor:reforco')).toBe('c:/proj/alpha:esp:reforco')
    expect(director.lookup(director.idOf('role:c:/proj/alpha:executor')!)).toMatchObject({ role: 'executor', trackId: 't2' })
    director.apply(deriveOfficeModel(feed({ conversations: [conv('a')], tracks: { a: { ...tracks.a, g: { ...gen, status: 'done' } } } }), NOW))
    expect(director.idOf('track:g')).toBeNull()
    expect(state.getCharacter(sub)).toBeUndefined()
  })

  it('desempenho: 5 salas e 20 personagens, apply < 2 ms em média', () => {
    const { director } = setup()
    const conversations = Array.from({ length: 20 }, (_, i) => conv(`c${i}`, { cwd: `C:/p${i % 5}` }))
    const busyA = feed({ conversations, busyIds: new Set(conversations.filter((_, i) => i % 2).map((c) => c.id)) })
    const busyB = feed({ conversations, busyIds: new Set(conversations.filter((_, i) => i % 2 === 0).map((c) => c.id)) })
    director.apply(deriveOfficeModel(busyA, NOW))
    const ma = deriveOfficeModel(busyA, NOW)
    const mb = deriveOfficeModel(busyB, NOW)
    const n = 200
    const t0 = performance.now()
    for (let i = 0; i < n; i++) director.apply(i % 2 ? ma : mb)
    expect((performance.now() - t0) / n).toBeLessThan(2)
  })
})
