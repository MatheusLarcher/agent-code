import type { PermissionRequest, PoProviderDiagnosticMsg } from '@shared/ipc'
import { contextLimitFor } from '@shared/ipc'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '../../types'
import { variantFor } from '../art/furniture'
import { createReactions } from '../behavior/reactions'
import { OfficeState } from '../engine/officeState'
import type { Character } from '../engine/types'
import { buildBuilding } from '../layout'
import { AnimDriver, BADGE_SEC, createStage } from './animDriver'
import { OfficeDirector, type Scheduler } from './director'
import type { OfficeFeed } from './feed'
import { deriveOfficeModel, roomIdFor } from './model'
import { OfficeOverlays } from './overlays'
import { ReactionDriver } from './reactionDriver'
import { conv, feed, NOW, track } from './testFeed'

const ROOM = roomIdFor('C:\\proj\\alpha')

/** Modelo + diretor + motor + fila + sobreposições reais, num relógio só. */
function world(opts: { noWalk?: boolean } = {}) {
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
  const reactions = new ReactionDriver(state, createReactions({ rng: () => 0 }), () => t)
  let anims: AnimDriver | null = null
  const director = new OfficeDirector(state, { scheduler, reactions, onHold: (id) => anims?.cancel(id) })
  const overlays = new OfficeOverlays(state, director)
  const base = createStage(state, director)
  const stage = opts.noWalk ? { ...base, walk: () => false } : base
  anims = new AnimDriver(state, director, stage, { overlays, now: () => t })
  const driver = anims
  state.idleBehavior = (ch) => director.isHeld(ch.id)
  state.afterUpdate = (dt) => driver.tick(dt)
  const apply = (f: OfficeFeed): void => {
    director.apply(deriveOfficeModel(f, NOW))
    driver.update(f)
    overlays.update(f)
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
  const until = (pred: () => boolean, maxMs = 30_000): void => {
    for (let n = 0; n < maxMs / 50 && !pred(); n++) advance(50)
    expect(pred()).toBe(true)
  }
  return { state, director, anims: driver, overlays, reactions, apply, advance, ch, until, now: () => t }
}

const near = (ch: Character, col: number, row: number): boolean => Math.abs(ch.tileCol - col) + Math.abs(ch.tileRow - row) <= 1
const exhausted: UIMessage = { kind: 'error', id: 'e1', text: 'limite', usageExhausted: true }

function settled(over: Partial<OfficeFeed> = {}, opts: { noWalk?: boolean } = {}) {
  const w = world(opts)
  w.apply(feed({ conversations: [conv('a')], activeId: 'a', ...over }))
  w.advance(20_000)
  return w
}

describe('animações 6 a 10 com o diretor e o motor reais', () => {
  it('6: estourou → vai à copa com a xícara e a hora de volta; o humor cai sem reação; volta no turno novo', () => {
    const w = settled()
    const p = w.ch('conv:a')
    const mood0 = w.reactions.reactions.moodOf(p.id, w.now())
    const resetsAt = NOW + 2 * 3_600_000
    const mood = vi.spyOn(w.director, 'moodSignal')
    w.apply(feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a', usageLimits: { five_hour: { rateLimitType: 'five_hour', status: 'rejected', resetsAt } } }))
    w.advance(50)
    expect(p.prop).toBe('xicara')
    expect(w.reactions.reactions.moodOf(p.id, w.now())).toBeLessThan(mood0)
    // Uma vez só, mesmo com o erro e a janela da conta chegando juntos.
    expect(mood.mock.calls).toEqual([['conv:a', 'limite']])
    // A reação visível (se houver) vem do 'erro' do turno, momento-chave já
    // existente; o limite em si só mexe no humor (moodSignal 'limite').
    const copa = w.state.layout.destinations.find((d) => d.papel === 'copa')!
    w.until(() => p.caption?.startsWith('volta ') === true)
    expect(near(p, copa.col, copa.row)).toBe(true)
    // Fica lá esperando.
    w.advance(5_000)
    expect(w.anims.queue.current(p.id)).toBe('cafe')
    // Turno novo: volta à mesa sem a xícara.
    w.apply(feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a', busyIds: new Set(['a']) }))
    w.until(() => w.anims.queue.current(p.id) === null)
    expect(p.prop).toBeNull()
    const seat = w.state.seats.get(p.seatId!)!
    w.until(() => near(p, seat.col, seat.row))
  })

  it("6: '?' no meio do café interrompe na hora (pedido vence enfeite)", () => {
    const w = settled()
    const p = w.ch('conv:a')
    const f = feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a' })
    w.apply(f)
    w.advance(500)
    expect(w.anims.queue.current(p.id)).toBe('cafe')
    w.apply({ ...f, permissions: { a: { id: 'perm', toolName: 'Bash', input: {} } as unknown as PermissionRequest } })
    w.advance(100)
    expect(w.anims.queue.current(p.id)).toBeNull()
    expect(p.prop).toBeNull()
  })

  it('6: destino ausente não trava: legenda no lugar e segue a fila', () => {
    const w = settled({}, { noWalk: true })
    const p = w.ch('conv:a')
    w.apply(feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a' }))
    w.until(() => p.caption === 'volta logo', 2_000)
    w.apply(feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a', busyIds: new Set(['a']) }))
    w.until(() => w.anims.queue.current(p.id) === null, 2_000)
  })

  it('8: troca de conta → crachá brilha com o nome por 2 s', () => {
    const w = settled()
    const p = w.ch('conv:a')
    const msg: UIMessage = { kind: 'account-switch', id: 's1', reason: 'manual', toAccountId: 'b', text: 'Troquei para a conta Trabalho (3% usado).' }
    w.apply(feed({ conversations: [conv('a', { messages: [msg] })], activeId: 'a' }))
    w.advance(50)
    expect(p.prop).toBe('cracha')
    expect(p.caption).toBe('Trabalho')
    w.advance(BADGE_SEC * 1000 + 200)
    expect(p.prop).toBeNull()
    expect(w.anims.queue.current(p.id)).toBeNull()
  })

  it('chamado à reunião corta a animação em curso do principal', () => {
    const w = settled()
    const p = w.ch('conv:a')
    w.apply(feed({ conversations: [conv('a', { messages: [exhausted] })], activeId: 'a' }))
    w.advance(300)
    expect(w.anims.queue.current(p.id)).toBe('cafe')
    expect(w.director.meetingHold('conv:a', true)).toBe(true)
    expect(w.anims.queue.current(p.id)).toBeNull()
    expect(p.prop).toBeNull()
  })

  it('7, 9 e 10: impressora com contador, pilha na mesa do principal e ondas sobre ele', () => {
    const task = { taskId: 't', taskType: 'local_bash', description: 'dev' } as never
    const max = contextLimitFor('claude-opus-4-5')
    const w = settled()
    const p = w.ch('conv:a')
    const a = conv('a', { backgroundTasks: [task, task], tokens: { context: max * 0.96, output: 0, cost: 0 }, messages: [{ kind: 'assistant-text', id: 'm1', text: 'oi' } as UIMessage] })
    w.apply(feed({ conversations: [a], activeId: 'a', speakingId: 'm1' }))
    const printer = w.state.layout.furniture.find((f) => f.kind === 'impressora' && f.roomId === ROOM)!
    expect(w.overlays.variantOf(printer, variantFor(printer, { active: false, t: 0.6 }), 0.6)).toMatchObject({ count: 2, blink: true })
    const desk = w.state.seats.get(p.seatId!)!.deskUid!
    const mesa = w.state.layout.furniture.find((f) => f.uid === desk)!
    expect(w.overlays.variantOf(mesa, variantFor(mesa, { active: false, t: 0 }), 0)).toMatchObject({ pile: 3 })
    expect(p.speaking).toBe(true)
    // Lista zera, contexto cai, áudio acaba (onended → speakingId null): tudo some.
    w.apply(feed({ conversations: [conv('a')], activeId: 'a', speakingId: null }))
    expect(w.overlays.variantOf(printer, variantFor(printer, { active: false, t: 0.6 }), 0.6)).toBeNull()
    expect(w.overlays.variantOf(mesa, variantFor(mesa, { active: false, t: 0 }), 0)).toBeNull()
    expect(p.speaking).toBe(false)
  })

  it('PO na abertura cola o post-it: o quadro da sala muda de coluna', () => {
    const w = settled()
    const po: PoProviderDiagnosticMsg = { id: 'p1', at: NOW, conversationId: 'a', correlationId: 'k', phase: 'claude-started', requestedProvider: 'claude', actualProvider: 'claude', round: 'open' }
    const kanban = w.state.layout.furniture.find((f) => f.kind === 'quadro-kanban' && f.roomId === ROOM)!
    expect(w.overlays.variantOf(kanban, variantFor(kanban, { active: false, t: 0 }), 0)).toBeNull()
    w.apply(feed({ conversations: [conv('a')], activeId: 'a', poDiagnostics: { a: po } }))
    w.until(() => w.overlays.kanbanMoved.has(ROOM))
    expect(w.overlays.variantOf(kanban, variantFor(kanban, { active: false, t: 0 }), 0)).toMatchObject({ moved: true })
  })

  it('trilhas já rodando quando o app abre não disparam a delegação', () => {
    const w = world()
    w.apply(feed({ conversations: [conv('a')], activeId: 'a', busyIds: new Set(['a']), tracks: { a: { t1: track('t1') } } }))
    w.advance(100)
    expect(w.anims.queue.current(w.ch('conv:a').id)).toBeNull()
    expect(w.ch('conv:a').prop).toBeNull()
  })
})
