import { describe, expect, it } from 'vitest'
import { AnimQueue, type Anim, type AnimStage } from './animQueue'

/** Palco de mentira: caminhada leva `walkTicks` tiques; registra tudo. */
function fakeStage(opts: { walkTicks?: number; reachable?: boolean } = {}) {
  const log: string[] = []
  const walkingLeft = new Map<number, number>()
  const s = {
    log,
    present: new Set<number>([1, 2]),
    waitingIds: new Set<number>(),
    pinned: new Set<number>(),
    props: new Map<number, string | null>(),
    stage: null as unknown as AnimStage
  }
  s.stage = {
    exists: (id) => s.present.has(id),
    waiting: (id) => s.waitingIds.has(id),
    walk(id, to) {
      if (opts.reachable === false) return false
      log.push(`${id}:walk:${to.kind === 'seat' ? to.seatId : to.papel}`)
      walkingLeft.set(id, opts.walkTicks ?? 2)
      return true
    },
    walking(id) {
      const n = walkingLeft.get(id) ?? 0
      if (n > 0) walkingLeft.set(id, n - 1)
      return n > 0
    },
    home(id) {
      log.push(`${id}:home`)
      return true
    },
    setProp: (id, prop) => void s.props.set(id, prop),
    caption: (id, text) => void log.push(`${id}:caption:${text}`),
    pin: (id, on) => void (on ? s.pinned.add(id) : s.pinned.delete(id))
  }
  return s
}

const walkAnim = (name: Anim['name'], text: string): Anim => ({
  name,
  steps: [{ do: 'prop', prop: 'pasta' }, { do: 'walk', to: { kind: 'destination', papel: 'kanban' } }, { do: 'caption', text, sec: 1 }]
})

describe('AnimQueue', () => {
  it('uma por vez: a segunda só começa quando a primeira termina', () => {
    const f = fakeStage({ walkTicks: 3 })
    const q = new AnimQueue(f.stage)
    q.enqueue(1, walkAnim('delegacao', 'a'))
    q.enqueue(1, walkAnim('po-quadro', 'b'))
    q.tick(0.1)
    expect(q.current(1)).toBe('delegacao')
    expect(q.pending(1)).toBe(1)
    expect(f.pinned.has(1)).toBe(true)
    for (let i = 0; i < 3; i++) q.tick(0.1)
    expect(f.log).toContain('1:caption:a')
    expect(q.current(1)).toBe('po-quadro')
    for (let i = 0; i < 5; i++) q.tick(0.1)
    expect(f.log.filter((l) => l.includes('caption'))).toEqual(['1:caption:a', '1:caption:b'])
    expect(q.current(1)).toBeNull()
    expect(f.pinned.has(1)).toBe(false)
    expect(f.props.get(1)).toBeNull()
  })

  it("'…' ou '?' interrompem na hora e descartam a fila", () => {
    const f = fakeStage({ walkTicks: 10 })
    const q = new AnimQueue(f.stage)
    q.enqueue(1, walkAnim('delegacao', 'a'))
    q.enqueue(1, walkAnim('po-quadro', 'b'))
    q.tick(0.1)
    f.waitingIds.add(1)
    q.tick(0.1)
    expect(q.current(1)).toBeNull()
    expect(q.pending(1)).toBe(0)
    expect(f.pinned.has(1)).toBe(false)
    expect(f.props.get(1)).toBeNull()
    expect(f.log.some((l) => l.includes('caption'))).toBe(false)
  })

  it('keepOnWaiting (a mão do vigia) não é interrompida pelo próprio "?"', () => {
    const f = fakeStage()
    const q = new AnimQueue(f.stage)
    f.waitingIds.add(2)
    q.enqueue(2, { name: 'vigia-mao', keepOnWaiting: true, steps: [{ do: 'prop', prop: 'mao' }, { do: 'until', signal: 'fim' }] })
    for (let i = 0; i < 5; i++) q.tick(0.1)
    expect(q.current(2)).toBe('vigia-mao')
    expect(f.props.get(2)).toBe('mao')
    q.signal(2, 'fim')
    q.tick(0.1)
    expect(q.current(2)).toBeNull()
  })

  it('destino ausente: sem caminhada, só o balão, e não trava', () => {
    const f = fakeStage({ reachable: false })
    const q = new AnimQueue(f.stage)
    q.enqueue(1, { name: 'delegacao', steps: [{ do: 'walk', to: { kind: 'destination', papel: 'kanban' } }, { do: 'caption', text: 'x', sec: 1 }, { do: 'home' }] })
    q.tick(0.1)
    expect(f.log).toEqual(['1:caption:x'])
    expect(q.current(1)).toBeNull()
  })

  it("walk com destino null também vira só o balão", () => {
    const f = fakeStage()
    const q = new AnimQueue(f.stage)
    q.enqueue(1, { name: 'revisao', steps: [{ do: 'walk', to: null }, { do: 'caption', text: 'y', sec: 1 }] })
    q.tick(0.1)
    expect(f.log).toEqual(['1:caption:y'])
  })

  it("sinal que chega antes do 'until' libera na hora; sem sinal, o prazo libera", () => {
    const f = fakeStage({ walkTicks: 2 })
    const q = new AnimQueue(f.stage)
    q.enqueue(1, { name: 'revisao', steps: [{ do: 'walk', to: { kind: 'seat', seatId: 's' } }, { do: 'until', signal: 'r' }, { do: 'caption', text: 'ok', sec: 1 }] })
    q.tick(0.1)
    q.signal(1, 'r')
    for (let i = 0; i < 3; i++) q.tick(0.1)
    expect(f.log).toContain('1:caption:ok')

    q.enqueue(2, { name: 'po-quadro', steps: [{ do: 'until', signal: 'nunca', timeoutSec: 1 }, { do: 'caption', text: 'tarde', sec: 1 }] })
    q.tick(0.5)
    expect(f.log).not.toContain('2:caption:tarde')
    q.tick(0.6)
    expect(f.log).toContain('2:caption:tarde')
  })

  it('personagem que saiu do mapa: a fila dele é descartada', () => {
    const f = fakeStage({ walkTicks: 10 })
    const q = new AnimQueue(f.stage)
    q.enqueue(1, walkAnim('delegacao', 'a'))
    q.tick(0.1)
    f.present.delete(1)
    q.tick(0.1)
    expect(q.current(1)).toBeNull()
  })

  it("'call' roda no seu passo, em ordem", () => {
    const f = fakeStage()
    const q = new AnimQueue(f.stage)
    const seen: string[] = []
    q.enqueue(1, { name: 'veredito', steps: [{ do: 'caption', text: '✗', sec: 1 }, { do: 'call', fn: () => seen.push('frustrado') }] })
    q.tick(0.1)
    expect(seen).toEqual(['frustrado'])
  })
})
