import { describe, expect, it } from 'vitest'
import { createOfficeArt } from '../art'
import { createReactions } from '../behavior/reactions'
import { OfficeState } from '../engine/officeState'
import { buildBubbleItems } from '../engine/sceneLayers'
import { CharacterState } from '../engine/types'
import { buildBuilding } from '../layout'
import { OfficeDirector, type Scheduler } from './director'
import type { OfficeCharacterModel, OfficeModel } from './model'
import { ReactionDriver } from './reactionDriver'

const room = { id: 'r', projectKey: 'C:/r', name: 'r', icon: null, principals: 1 }
const model = (...characters: OfficeCharacterModel[]): OfficeModel => ({ rooms: [room], characters })

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
    label: 'x',
    ...over
  }
}

/** Diretor + motor + reações num relógio só (timers, Date e motor). */
function world() {
  let t = 1_000_000
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
  const director = new OfficeDirector(state, { scheduler, reactions })
  state.idleBehavior = (ch) => director.isHeld(ch.id)
  const advance = (ms: number): void => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 50)
      for (const [k, j] of [...jobs]) if (j.at <= t) (jobs.delete(k), j.fn())
      state.update(0.05)
    }
  }
  const ch = () => state.getCharacter(director.idOf('conv:a')!)!
  return { state, director, advance, ch }
}

/** Trabalha `min` minutos trocando de ferramenta a cada 10 s (muitos passos). */
function work(w: ReturnType<typeof world>, min: number): void {
  for (let i = 0; i < (min * 60) / 10; i++) {
    w.director.apply(model(principal({ active: true, activity: i % 2 ? 'type' : 'read' })))
    w.advance(10_000)
  }
}

describe('reações integradas ao diretor', () => {
  it('chamado no meio de tarefa importante: sai irritado na hora e chega feliz', () => {
    const w = world()
    w.director.apply(model(principal()))
    w.advance(15_000)
    work(w, 3)
    expect(w.director.meetingHold('conv:a', true)).toBe(true)
    // A caminhada sai no mesmo instante; a reação não a atrasa.
    expect(w.ch().state).toBe(CharacterState.WALK)
    expect(w.ch().reaction).toBe('irritado')
    w.advance(1000)
    // Continua emburrado no caminho (mesmo passado o prazo normal).
    if (w.ch().state === CharacterState.WALK) expect(w.ch().reaction).toBe('irritado')
    for (let i = 0; i < 400 && w.ch().state === CharacterState.WALK; i++) w.advance(50)
    expect(w.ch().state).not.toBe(CharacterState.WALK)
    w.advance(50)
    expect(w.ch().reaction).toBe('feliz')
    w.advance(3000)
    expect(w.ch().reaction).toBeNull()
  })

  it("turno longo terminando com 'ok' → comemora; 'erro' → nervoso ou frustrado", () => {
    const w = world()
    w.director.apply(model(principal()))
    w.advance(15_000)
    work(w, 4)
    w.director.apply(model(principal({ bubble: 'ok' })))
    expect(w.ch().reaction).toBe('comemora')
    w.advance(30_000)
    w.director.apply(model(principal({ active: true, activity: 'type' })))
    w.advance(5000)
    w.director.apply(model(principal({ bubble: 'erro' })))
    expect(['nervoso', 'frustrado']).toContain(w.ch().reaction)
  })

  it("'…' ganha da reação: o renderer desenha o balão de permissão, não a cara", () => {
    const w = world()
    w.director.apply(model(principal()))
    w.advance(15_000)
    w.director.apply(model(principal({ bubble: 'erro' })))
    expect(w.ch().reaction).not.toBeNull()
    w.director.apply(model(principal({ bubble: 'permissao' })))
    const art = createOfficeArt()
    const items = buildBubbleItems(w.state, art)
    expect(items.map((i) => i.sprite)).toContain(art.bubbleSprite('permissao'))
    expect(items.map((i) => i.sprite)).not.toContain(art.reactionSprites!(w.ch().reaction!).bubble)
  })

  it('ampulheta só mexe no humor, sem reação visível', () => {
    const w = world()
    w.director.apply(model(principal()))
    w.advance(15_000)
    w.director.apply(model(principal({ bubble: 'ampulheta' })))
    expect(w.ch().reaction).toBeNull()
  })
})
