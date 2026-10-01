import type { MemoristaProviderDiagnosticMsg, PoProviderDiagnosticMsg } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { AgentTrack } from '../../agentTracks'
import { createReactions } from '../behavior/reactions'
import { OfficeState } from '../engine/officeState'
import { CharacterState, type Character } from '../engine/types'
import { roomAt } from '../engine/world'
import { buildBuilding } from '../layout'
import { AnimDriver } from './animDriver'
import { OfficeDirector, type Scheduler } from './director'
import type { OfficeFeed } from './feed'
import { deriveOfficeModel, roomIdFor } from './model'
import { ReactionDriver } from './reactionDriver'
import { conv, feed, NOW, track } from './testFeed'

const ROOM = roomIdFor('C:\\proj\\alpha')
const c = conv('a')

/** Modelo + diretor + motor + fila reais, num relógio só. */
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
  const state = new OfficeState(buildBuilding({ rooms: [] }))
  const director = new OfficeDirector(state, { scheduler, reactions: new ReactionDriver(state, createReactions({ rng: () => 0 }), () => t) })
  const anims = new AnimDriver(state, director)
  state.idleBehavior = (ch) => director.isHeld(ch.id)
  state.afterUpdate = (dt) => anims.tick(dt)
  const apply = (f: OfficeFeed): void => {
    director.apply(deriveOfficeModel(f, NOW))
    anims.update(f)
  }
  const advance = (ms: number): void => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 50)
      for (const [k, j] of [...jobs]) if (j.at <= t) (jobs.delete(k), j.fn())
      state.update(0.05)
    }
  }
  const ch = (key: string): Character => state.getCharacter(director.idOf(key)!)!
  /** Avança até `pred` valer (ou estoura o prazo). */
  const until = (pred: () => boolean, maxMs = 30_000): void => {
    for (let n = 0; n < maxMs / 50 && !pred(); n++) advance(50)
    expect(pred()).toBe(true)
  }
  return { state, director, anims, apply, advance, ch, until }
}

const busy = (over: Partial<OfficeFeed> = {}): OfficeFeed => feed({ conversations: [c], activeId: 'a', busyIds: new Set(['a']), ...over })
const near = (ch: Character, col: number, row: number): boolean => Math.abs(ch.tileCol - col) + Math.abs(ch.tileRow - row) <= 1
const roomOf = (w: ReturnType<typeof world>, ch: Character): string | null => roomAt(w.state.layout.rooms, ch.tileCol, ch.tileRow)?.id ?? null

function settled(tracks: Record<string, AgentTrack> = {}) {
  const w = world()
  w.apply(busy({ tracks: { a: tracks } }))
  w.advance(20_000)
  return w
}

describe('animações 1 a 5 com o diretor e o motor reais', () => {
  it('1: o principal leva a pasta (cor do projeto) até a mesa do executor e o executor a devolve com ✓', () => {
    const w = settled()
    const t1 = track('t1')
    w.apply(busy({ tracks: { a: { t1 } } }))
    const p = w.ch('conv:a')
    w.advance(50)
    expect(p.prop).toBe('pasta')
    expect(p.propTint).toMatch(/^#/)
    expect(p.pinned).toBe(true)
    const seat = w.state.seats.get(`${ROOM}:esp:executor`)!
    w.until(() => p.caption === 'pasta → executor')
    expect(near(p, seat.col, seat.row)).toBe(true)
    expect(roomOf(w, p)).toBe(ROOM)
    w.until(() => !p.pinned)
    expect(p.prop).toBeNull()

    w.apply(busy({ tracks: { a: { t1: { ...t1, status: 'done' } } } }))
    const ex = w.ch(`role:${ROOM}:executor`)
    w.advance(50)
    expect(ex.prop).toBe('pasta-ok')
    const pSeat = w.state.seats.get(p.seatId!)!
    w.until(() => ex.caption === '✓')
    expect(near(ex, pSeat.col, pSeat.row)).toBe(true)
  })

  it("1: 'memoria' leva a pasta ao arquivo do corredor", () => {
    const w = settled()
    w.apply(busy({ tracks: { a: { m: track('m', { subagentType: 'memoria' }) } } }))
    const p = w.ch('conv:a')
    w.until(() => p.caption === 'pasta → memoria', 60_000)
    const arq = w.state.layout.destinations.find((d) => d.papel === 'arquivo-memorias')!
    expect(arq.roomId).toBeNull()
    expect(near(p, arq.col, arq.row)).toBe(true)
    expect(roomOf(w, p)).toBeNull()
  })

  it('1: especialista ocupado → a pasta vai ao reforço, que entrou e usa a mesa livre', () => {
    const t1 = track('t1', { startedAt: NOW - 60_000 })
    const w = settled({ t1 })
    w.apply(busy({ tracks: { a: { t1, t2: track('t2', { startedAt: NOW - 1000 }) } } }))
    const reforco = w.state.seats.get(`${ROOM}:esp:reforco`)!
    expect(reforco.assigned).toBe(true)
    const p = w.ch('conv:a')
    w.until(() => p.caption === 'pasta → executor')
    // A trilha nova (a mais recente manda na mesa principal; a outra vai ao
    // reforço): a pasta vai a quem a mostra.
    const holder = w.ch(w.director.keyOfTrack('t2')!)
    const hs = w.state.seats.get(holder.seatId!)!
    expect(near(p, hs.col, hs.row)).toBe(true)
  })

  it('2: o crítico vai com a prancheta à mesa do executor; o ✗ frustra o executor revisado', () => {
    const e1 = track('e1', { status: 'done', startedAt: NOW - 120_000 })
    const w = settled({ e1 })
    const cr = track('cr', { subagentType: 'critico', startedAt: NOW - 1000 })
    w.apply(busy({ tracks: { a: { e1, cr } } }))
    const critic = w.ch(`role:${ROOM}:critico`)
    w.advance(100)
    expect(critic.prop).toBe('prancheta')
    const exSeat = w.state.seats.get(w.ch(`role:${ROOM}:executor`).seatId!)!
    w.until(() => critic.state !== CharacterState.WALK && near(critic, exSeat.col, exSeat.row))
    expect(critic.pinned).toBe(true)
    w.apply(busy({ tracks: { a: { e1, cr: { ...cr, status: 'error' } } } }))
    w.advance(100)
    expect(critic.prop).toBe('prancheta-erro')
    expect(w.ch(`role:${ROOM}:executor`).reaction).toBe('frustrado')
  })

  it('2: sem executor na conversa, o crítico vai à mesa do principal', () => {
    const w = settled()
    w.apply(busy({ tracks: { a: { cr: track('cr', { subagentType: 'critico' }) } } }))
    const critic = w.ch(`role:${ROOM}:critico`)
    const pSeat = w.state.seats.get(w.ch('conv:a').seatId!)!
    w.until(() => critic.state !== CharacterState.WALK && near(critic, pSeat.col, pSeat.row) && critic.pinned)
  })

  it("3: PO vai ao kanban da sala e, no fim, mostra 'N cartões'", () => {
    const w = settled()
    const d: PoProviderDiagnosticMsg = { id: 'p1', at: NOW, conversationId: 'a', correlationId: 'k', round: 'open', phase: 'claude-started', requestedProvider: 'claude', actualProvider: 'claude' }
    w.apply(busy({ poDiagnostics: { a: d } }))
    const po = w.ch(`po:${ROOM}`)
    const kanban = w.state.layout.destinations.find((x) => x.papel === 'kanban' && x.roomId === ROOM)!
    w.until(() => po.caption === 'cola post-it' && near(po, kanban.col, kanban.row))
    w.apply(busy({ poDiagnostics: { a: { ...d, id: 'p2', phase: 'audit-finished', appliedOps: 3 } } }))
    w.advance(100)
    expect(po.caption).toBe('3 cartões')
  })

  it('4: o vigia levanta a mão e vai à reunião; fica lá até a dúvida ser respondida', () => {
    const w = settled()
    w.apply(busy({ vigiaAlerts: { a: { at: NOW } as never } }))
    const v = w.ch('vigia:a')
    w.advance(100)
    expect(v.prop).toBe('mao')
    expect(v.bubble).toBe('pergunta')
    const reuniao = w.state.layout.destinations.find((x) => x.papel === 'reuniao' && x.roomId === ROOM)!
    w.until(() => v.state !== CharacterState.WALK && near(v, reuniao.col, reuniao.row))
    w.advance(60_000)
    expect(near(v, reuniao.col, reuniao.row)).toBe(true)
    expect(v.prop).toBe('mao')
    w.apply(busy())
    expect(w.director.idOf('vigia:a')).toBeNull()
  })

  it("5: memorista vai ao arquivo e guarda uma ficha: '+1 memória'; com 0 volta sem ficha", () => {
    const w = settled()
    const d: MemoristaProviderDiagnosticMsg = { id: 'm1', at: NOW, conversationId: 'a', correlationId: 'k', phase: 'claude-started', requestedProvider: 'claude', actualProvider: 'claude' }
    w.apply(busy({ memoristaDiagnostics: { a: d } }))
    const m = w.ch(`role:${ROOM}:memoria`)
    w.advance(30_000)
    w.apply(busy({ memoristaDiagnostics: { a: { ...d, id: 'm2', phase: 'analysis-finished', savedMemories: 1 } } }))
    w.until(() => m.prop === 'ficha')
    w.until(() => m.caption === '+1 memória')

    w.advance(10_000)
    w.apply(busy({ memoristaDiagnostics: { a: { ...d, id: 'm3', correlationId: 'k2' } } }))
    w.advance(5000)
    w.apply(busy({ memoristaDiagnostics: { a: { ...d, id: 'm4', correlationId: 'k2', phase: 'analysis-finished', savedMemories: 0 } } }))
    for (let i = 0; i < 100; i++) {
      w.advance(50)
      expect(m.prop).not.toBe('ficha')
    }
  })

  it("'…' interrompe a delegação no meio da caminhada", () => {
    const w = settled()
    w.apply(busy({ tracks: { a: { t1: track('t1') } } }))
    const p = w.ch('conv:a')
    w.advance(200)
    expect(p.pinned).toBe(true)
    w.apply(busy({ tracks: { a: { t1: track('t1') } }, permissions: { a: { id: 'x' } as never } }))
    w.advance(50)
    expect(p.bubble).toBe('permissao')
    expect(p.pinned).toBe(false)
    expect(p.prop).toBeNull()
    expect(w.anims.queue.current(p.id)).toBeNull()
  })

  it('destino ausente: sem caminhada, só a legenda, e a fila não trava', () => {
    const w = settled()
    w.state.layout.destinations = w.state.layout.destinations.filter((d) => d.papel !== 'arquivo-memorias')
    const p = w.ch('conv:a')
    const at = { col: p.tileCol, row: p.tileRow }
    w.apply(busy({ tracks: { a: { m: track('m', { subagentType: 'memoria' }) } } }))
    w.advance(100)
    expect(p.caption).toBe('pasta → memoria')
    expect({ col: p.tileCol, row: p.tileRow }).toEqual(at)
    w.until(() => w.anims.queue.current(p.id) === null)
    expect(p.pinned).toBe(false)
  })
})
