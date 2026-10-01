import { describe, expect, it } from 'vitest'
import type { ComposerPresence } from '../../composerPresence'
import { createLeisure } from '../behavior/leisure'
import { RETURN_MS } from '../behavior/meeting'
import { OfficeState } from '../engine/officeState'
import { CharacterState } from '../engine/types'
import { buildBuilding } from '../layout'
import { OfficeDirector, type Scheduler } from './director'
import type { OfficeFeed } from './feed'
import { MeetingDriver } from './meetingDriver'
import { deriveOfficeModel, roomIdFor } from './model'
import { NOW, conv, feed, toolUse, user } from './testFeed'

const idle: ComposerPresence = { draftActiveSince: null, lastInputAt: null, micOn: false, sentAt: null, clearedAt: null }

/** Relógio único para o driver (Date) e o scheduler. */
function world() {
  let t = NOW
  const jobs = new Map<number, { at: number; fn: () => void }>()
  let seq = 0
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      jobs.set(++seq, { at: t + ms, fn })
      return seq
    },
    clearTimeout: (h) => void jobs.delete(h as number)
  }
  const presence = new Map<string, ComposerPresence>()
  const state = new OfficeState(buildBuilding({ rooms: [] }))
  const leisure = createLeisure({ rng: () => 0 })
  const director = new OfficeDirector(state, { scheduler, leisure })
  state.idleBehavior = (ch, dt, api) => director.isHeld(ch.id) || leisure.idleBehavior(ch, dt, api)
  const driver = new MeetingDriver(director, { presence: (id) => presence.get(id) ?? idle, scheduler, now: () => t })
  const apply = (f: OfficeFeed): void => {
    director.apply(deriveOfficeModel(f, t))
    driver.update(f)
  }
  /** Avança o relógio (timers) e o motor juntos, em passos de 50 ms. */
  const advance = (ms: number): void => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 50)
      for (const [k, j] of [...jobs]) if (j.at <= t) (jobs.delete(k), j.fn())
      state.update(0.05)
    }
  }
  const ch = (cid: string) => state.getCharacter(director.idOf(`conv:${cid}`)!)!
  const meetingTile = (cid: string) => {
    const c = ch(cid)
    return state.layout.destinations.find((d) => d.papel === 'reuniao' && d.roomId === c.roomId)!
  }
  const atMeeting = (cid: string): boolean => {
    const c = ch(cid)
    const d = meetingTile(cid)
    return c.tileCol === d.col && c.tileRow === d.row
  }
  return { state, director, driver, presence, apply, advance, ch, atMeeting, now: () => t }
}

// Duas salas, dois principais em cada: o gatilho tem de mover só o certo.
const a1 = conv('a1', { cwd: 'C:\\proj\\alpha', updatedAt: NOW })
const a2 = conv('a2', { cwd: 'C:\\proj\\alpha', updatedAt: NOW })
const b1 = conv('b1', { cwd: 'C:\\proj\\beta', updatedAt: NOW })
const base = (over: Partial<OfficeFeed> = {}): OfficeFeed => feed({ conversations: [a1, a2, b1], activeId: 'a1', ...over })

/** Põe todos nas mesas (a entrada pela porta termina). */
function seated(w: ReturnType<typeof world>, f: OfficeFeed): void {
  w.apply(f)
  w.advance(20_000)
}

/** Confere a ida caminhando: tem caminho, não salta, e chega ao destino da sala dele. */
function expectWalksThere(w: ReturnType<typeof world>, cid: string, others: string[]): void {
  const c = w.ch(cid)
  expect(c.state).toBe(CharacterState.WALK)
  expect(c.path.length).toBeGreaterThan(0)
  const start = { x: c.x, y: c.y }
  w.advance(50)
  // Um passo de 50 ms anda menos que um tile: não teleporta.
  expect(Math.hypot(c.x - start.x, c.y - start.y)).toBeLessThan(16)
  w.advance(15_000)
  expect(w.atMeeting(cid)).toBe(true)
  expect(w.director.isHeld(c.id)).toBe(true)
  for (const o of others) expect(w.director.isHeld(w.ch(o).id)).toBe(false)
}

describe('MeetingDriver', () => {
  it('gatilho 1: rascunho de ~1 s leva o principal certo da sala certa', () => {
    const w = world()
    seated(w, base())
    w.presence.set('b1', { ...idle, draftActiveSince: w.now(), lastInputAt: w.now() })
    w.driver.update()
    expect(w.ch('b1').state).not.toBe(CharacterState.WALK)
    // Segue digitando durante a caminhada (lastInputAt adiante cobre os 15 s).
    w.presence.set('b1', { ...idle, draftActiveSince: w.now(), lastInputAt: w.now() + 15_000 })
    w.advance(1000)
    expect(w.ch('b1').roomId).toBe(roomIdFor('C:\\proj\\beta'))
    expectWalksThere(w, 'b1', ['a1', 'a2'])
  })

  it('gatilho 2: envio leva; o turno passar a usar ferramenta devolve à mesa', () => {
    const w = world()
    seated(w, base())
    w.presence.set('a2', { ...idle, sentAt: w.now() })
    const sending = base({ busyIds: new Set(['a2']), conversations: [a1, { ...a2, messages: [user('u')] }, b1] })
    w.apply(sending)
    expectWalksThere(w, 'a2', ['a1', 'b1'])
    w.apply(base({ busyIds: new Set(['a2']), conversations: [a1, { ...a2, messages: [user('u'), toolUse('t', 'Bash', {})] }, b1] }))
    expect(w.director.isHeld(w.ch('a2').id)).toBe(false)
    w.advance(15_000)
    expect(w.atMeeting('a2')).toBe(false)
    expect(w.ch('a2').seatId).not.toBeNull()
  })

  it('gatilho 3: pedido pendente segura lá até ser resolvido', () => {
    const w = world()
    seated(w, base())
    const perm = { requestId: 'r', toolName: 'Bash', input: {} } as unknown as OfficeFeed['permissions'][string]
    w.apply(base({ permissions: { a1: perm } }))
    expectWalksThere(w, 'a1', ['a2', 'b1'])
    expect(w.ch('a1').bubble).toBe('permissao')
    w.advance(60_000)
    expect(w.atMeeting('a1')).toBe(true)
    w.apply(base())
    expect(w.director.isHeld(w.ch('a1').id)).toBe(false)
  })

  it('gatilho 4: conversa de planejamento ativa leva o Gerente', () => {
    const w = world()
    const plan = { ...b1, mode: 'planning' as const, planningSlug: 'plano-x' }
    seated(w, base({ conversations: [a1, a2, b1] }))
    w.apply(base({ conversations: [a1, a2, plan], activeId: 'b1' }))
    expectWalksThere(w, 'b1', ['a1', 'a2'])
  })

  it('volta ~8 s depois de apagar o rascunho sem envio', () => {
    const w = world()
    seated(w, base())
    const t0 = w.now()
    w.presence.set('a1', { ...idle, draftActiveSince: t0, lastInputAt: t0 })
    w.driver.update()
    w.advance(1100)
    expect(w.director.isHeld(w.ch('a1').id)).toBe(true)
    const t1 = w.now()
    w.presence.set('a1', { ...idle, lastInputAt: t1, clearedAt: t1 })
    w.driver.update()
    w.advance(RETURN_MS - 200)
    expect(w.director.isHeld(w.ch('a1').id)).toBe(true)
    w.advance(400)
    expect(w.director.isHeld(w.ch('a1').id)).toBe(false)
  })

  it('lazer não age enquanto está na reunião', () => {
    const w = world()
    seated(w, base())
    w.apply(base({ vigiaAlerts: { b1: {} as OfficeFeed['vigiaAlerts'][string] } }))
    w.advance(20 * 60_000)
    expect(w.atMeeting('b1')).toBe(true)
    expect(w.ch('b1').prop).toBeNull()
  })

  it('destino ausente não trava: fica onde está, com o balão', () => {
    const w = world()
    seated(w, base())
    w.state.layout.destinations = w.state.layout.destinations.filter((d) => d.papel !== 'reuniao')
    const perm = { requestId: 'r', toolName: 'Bash', input: {} } as unknown as OfficeFeed['permissions'][string]
    w.apply(base({ permissions: { a1: perm } }))
    expect(w.director.isHeld(w.ch('a1').id)).toBe(false)
    expect(w.ch('a1').bubble).toBe('permissao')
    w.apply(base())
    w.advance(1000)
    expect(w.ch('a1').bubble).toBeNull()
  })
})
