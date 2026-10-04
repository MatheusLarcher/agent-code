import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import { DWELL_MAX, DWELL_MIN, FX, react, setStatus, turnToward, type Brain, type BrainStatus, type Leisure } from './brain'
import { Crowd } from './crowd'
import { seatOf } from './furniture'
import { layoutOffice, type RoomLayout } from './layout'
import type { Reaction } from './poses'

function model(id: string, extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key: `conv:${id}`, convId: id, roomId: 'r1', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${id}`, active: false, activity: null, bubble: null, label: '', ...extra
  }
}

const CAM = { x: 6, z: 30 }

/** Escritório de uma sala com `n` principais (+ extras), cérebros num Crowd de sorteio fixo. */
function office(n: number, extra: OfficeCharacterModel[] = [], away = false) {
  const chars = [...Array.from({ length: n }, (_, i) => model(`p${i}`)), ...extra]
  const layout = layoutOffice({ rooms: [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: n }], characters: chars })
  const crowd = new Crowd(42)
  crowd.syncRooms(layout.rooms)
  const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
  const brains = layout.characters.map((c) => crowd.upsert(c, away, rooms))
  const room = layout.rooms[0] as RoomLayout
  return { crowd, brains, room, layout }
}

const status = (phase: BrainStatus['phase'], extra: Partial<BrainStatus> = {}): BrainStatus => ({
  phase, tool: null, contextPct: null, usageOut: false, stalled: false, idleSince: null, ...extra
})

/** Simula `seconds` em passos de `dt`, chamando `each` depois de cada passo. */
function run(crowd: Crowd, seconds: number, each?: () => void, dt = 0.1): void {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    crowd.step(dt, crowd.t + dt, CAM.x, CAM.z)
    each?.()
  }
}

/** Anota cada reação que COMEÇA (a mesma duas vezes seguidas conta duas). */
const reactions = (b: Brain, out: Reaction[]): (() => void) => {
  let last: Reaction | null = b.reaction
  let lastT = b.reactionT
  return () => {
    if (b.reaction && (b.reaction !== last || b.reactionT < lastT)) out.push(b.reaction)
    last = b.reaction
    lastT = b.reactionT
  }
}

describe('cérebro: ocioso', () => {
  it('alterna lazeres (café, estante, janela, planta, ler o quadro, conversa, celular) ficando de 6 a 25 s em cada', () => {
    const { crowd, brains } = office(4)
    for (const b of brains) setStatus(b, status('idle', { idleSince: 0 }), 0)
    const done = new Set<Leisure>()
    const dwell: number[] = []
    const last = brains.map(() => ({ l: null as Leisure | null, t: 0 }))
    const postit = new Set<string>()
    let notes = 0
    // Quase 10 min (o cochilo é aos SLEEP_AFTER_SEC).
    run(crowd, SLEEP_AFTER_SEC - 20, () =>
      brains.forEach((b, i) => {
        if (b.leisure === 'postit') postit.add(b.action)
        if (b.prop === 'note') notes++
        const prev = last[i]
        if (prev.l && b.leisure !== prev.l) {
          done.add(prev.l)
          // Permanência de quem terminou sozinho (não puxado para conversa); o celular conta andando.
          if (prev.l !== 'chat' && b.leisure === null && b.mode === 'free') dwell.push(prev.t)
        }
        prev.l = b.leisure
        prev.t = b.leisureT
      })
    )
    expect([...done].sort()).toEqual(['chat', 'coffee', 'phone', 'plant', 'postit', 'shelf', 'window'])
    expect(dwell.length).toBeGreaterThan(20)
    // No quadro só lê e confere: nenhum papel inventado na mão nem gesto de prender.
    expect(postit.has('readBoard') && postit.has('admire')).toBe(true)
    expect(postit.has('stick')).toBe(false)
    expect(notes).toBe(0)
    for (const d of dwell) {
      expect(d).toBeGreaterThanOrEqual(DWELL_MIN - 0.11)
      expect(d).toBeLessThanOrEqual(DWELL_MAX + 0.11)
    }
    // Ninguém dorme antes da hora.
    expect(brains.every((b) => b.mode === 'free')).toBe(true)
  })

  it('conversa: os dois se encontram, ficam de frente e revezam quem fala', () => {
    const { crowd, brains } = office(2)
    for (const b of brains) setStatus(b, status('idle', { idleSince: 0 }), 0)
    run(crowd, 0.1)
    expect(crowd.pairUp(brains[0])).toBe(true)
    const [a, b] = brains
    run(crowd, 12)
    expect(a.leisure).toBe('chat')
    expect(a.arrived && b.arrived).toBe(true)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(1, 1)
    const facing = (p: Brain, q: Brain): number => Math.abs(turnToward(p.yaw, Math.atan2(-(q.x - p.x), -(q.z - p.z)), Math.PI) - p.yaw)
    expect(facing(a, b)).toBeLessThan(0.15)
    expect(facing(b, a)).toBeLessThan(0.15)
    expect(a.look).toBe('point')
    const turns = new Set<string>()
    run(crowd, Math.min(6.5, a.leisureDur - a.leisureT - 0.2), () => {
      expect([a.action, b.action].sort()).toEqual(['listen', 'talk'])
      turns.add(a.action)
    })
    expect(turns.size).toBe(2)
  })

  it('depois de SLEEP_AFTER_SEC cochila: um no pufe e o outro na mesa, com "z"', () => {
    const { crowd, brains } = office(2)
    setStatus(brains[0], status('idle', { idleSince: -SLEEP_AFTER_SEC - 5 }), 0)
    setStatus(brains[1], status('idle', { idleSince: -(SLEEP_AFTER_SEC - 20) }), 0)
    run(crowd, 10)
    expect(brains[0].mode).toBe('sleep')
    expect(brains[1].mode).toBe('free')
    run(crowd, 30)
    expect(brains[1].mode).toBe('sleep')
    expect(brains.map((b) => b.action).sort()).toEqual(['napDesk', 'napPufe'])
    expect(brains.every((b) => b.zzz && b.sit === 1)).toBe(true)
    expect(brains.find((b) => b.action === 'napPufe')!.seat).toBe('pufe')
  })
})

describe('cérebro: trabalhando', () => {
  it('senta na própria mesa e o gesto segue a ferramenta', () => {
    const { crowd, brains, room } = office(1)
    const b = brains[0]
    setStatus(b, status('idle', { idleSince: 0 }), 0)
    run(crowd, 30)
    expect(b.sit).toBe(0)
    setStatus(b, status('working', { tool: 'edit' }), crowd.t)
    run(crowd, 15)
    const seat = seatOf(room.desks[0])
    expect([b.sit, b.seat]).toEqual([1, 'chair'])
    expect(Math.hypot(b.x - seat.x, b.z - seat.z)).toBeLessThan(0.02)
    expect(b.action).toBe('typeFast')
    expect(b.look).toBe('point')
    setStatus(b, status('working', { tool: 'read' }), crowd.t)
    run(crowd, 0.5)
    expect(b.action).toBe('readScreen')
    setStatus(b, status('working', { tool: 'bash' }), crowd.t)
    run(crowd, 0.5)
    expect(b.action).toBe('type')
    run(crowd, 1.5)
    expect(b.action).toBe('drum')
    setStatus(b, status('working', { tool: 'web' }), crowd.t)
    run(crowd, 0.3)
    expect(b.action).toBe('web')
    react(b, { type: 'tool', name: 'Agent', kind: 'task', target: 'executor' }, crowd)
    expect(b.reaction).toBe('handoff')
  })

  it('pedido: "!" com pulinho, corre até a mesa, senta e estala os dedos; quem dormia acorda assustado', () => {
    const { crowd, brains } = office(1)
    const b = brains[0]
    setStatus(b, status('idle', { idleSince: -SLEEP_AFTER_SEC - 1 }), 0)
    run(crowd, 25)
    expect([b.mode, b.seat, b.zzz]).toEqual(['sleep', 'pufe', true])
    react(b, { type: 'request', text: 'faz o deploy' }, crowd)
    setStatus(b, status('working'), crowd.t)
    expect(b.fx & FX.bang).toBeTruthy()
    const seen: Reaction[] = []
    const tap = reactions(b, seen)
    seen.push(b.reaction!)
    let top = 0
    run(crowd, 20, () => {
      tap()
      top = Math.max(top, b.speed)
    })
    expect(seen).toEqual(['scared', 'alert', 'knuckles'])
    expect(top).toBeGreaterThan(2.5)
    expect(b.zzz).toBe(false)
    expect([b.mode, b.seat, b.sit, b.action]).toEqual(['work', 'chair', 1, 'type'])
  })

  it('permissão: levanta ao lado da cadeira, vira para a câmera e acena com a plaquinha; depois volta a sentar', () => {
    const { crowd, brains } = office(1)
    const b = brains[0]
    setStatus(b, status('working'), 0)
    run(crowd, 1)
    setStatus(b, status('waiting-permission'), crowd.t)
    run(crowd, 4)
    expect(b.sit).toBe(0)
    expect([b.action, b.prop, b.look]).toEqual(['wave', 'sign', 'camera'])
    const toCam = Math.atan2(-(CAM.x - b.x), -(CAM.z - b.z))
    expect(Math.abs(turnToward(b.yaw, toCam, Math.PI) - b.yaw)).toBeLessThan(0.1)
    setStatus(b, status('working'), crowd.t)
    run(crowd, 4)
    expect([b.sit, b.prop]).toEqual([1, null])
  })

  it('resultado, erro, fim, contexto baixo e travamento viram reações (com efeitos)', () => {
    const { crowd, brains } = office(1)
    const b = brains[0]
    setStatus(b, status('working', { tool: 'bash' }), 0)
    run(crowd, 1)
    const seen: Reaction[] = []
    const tap = reactions(b, seen)
    react(b, { type: 'test-result', passed: 12, failed: 0 }, crowd)
    run(crowd, 1.3, tap)
    react(b, { type: 'test-result', passed: 11, failed: 1 }, crowd)
    run(crowd, 2, tap)
    b.fx = 0
    react(b, { type: 'error', message: 'API Error: 529' }, crowd)
    expect(b.fx & FX.smoke && b.fx & FX.sweat).toBeTruthy()
    run(crowd, 2.2, tap)
    b.fx = 0
    react(b, { type: 'done', summary: { edited: [], created: [], commands: [] } }, crowd)
    expect(b.fx & FX.confetti).toBeTruthy()
    run(crowd, 2, tap)
    expect(seen.slice(0, 3)).toEqual(['fistpump', 'handsHead', 'facepalm'])
    expect(['celebrate', 'stretch']).toContain(seen[3])
    // Contexto baixo: digita mais devagar e boceja de vez em quando.
    setStatus(b, status('working', { contextPct: 9 }), crowd.t)
    react(b, { type: 'context-low', pct: 9 }, crowd)
    const yawns: Reaction[] = []
    run(crowd, 40, reactions(b, yawns))
    expect(b.workSpeed).toBeLessThan(1)
    // Além do bocejo do evento, outros de vez em quando (a cada 9–18 s).
    expect(yawns.filter((r) => r === 'yawn').length).toBeGreaterThanOrEqual(2)
    // Travado: olha o relógio e tamborila.
    setStatus(b, status('working', { stalled: true }), crowd.t)
    react(b, { type: 'stalled', ms: 120_000 }, crowd)
    const watches: Reaction[] = []
    run(crowd, 20, reactions(b, watches))
    expect(watches.filter((r) => r === 'watch').length).toBeGreaterThanOrEqual(2)
    expect(b.action).toBe('drum')
  })

  it('limite de uso: os afetados fazem fila na máquina de café e saem dela quando volta', () => {
    const { crowd, brains } = office(3)
    for (const b of brains) setStatus(b, status('error', { usageOut: true }), 0)
    run(crowd, 25)
    expect(brains.every((b) => b.mode === 'queue' && b.arrived)).toBe(true)
    const kinds = brains.map((b) => `${b.poi!.kind}:${b.poi!.index}`).sort()
    expect(kinds).toEqual(['coffee:0', 'queue:1', 'queue:2'])
    const head = brains.find((b) => b.poi!.kind === 'coffee')!
    expect([head.action, head.prop]).toEqual(['sip', 'cup'])
    expect(brains.filter((b) => b !== head).every((b) => b.action === 'wait')).toBe(true)
    // O da frente volta a trabalhar; o próximo anda para a máquina.
    setStatus(head, status('working'), crowd.t)
    run(crowd, 12)
    expect(head.mode).toBe('work')
    expect(brains.filter((b) => b.mode === 'queue').map((b) => `${b.poi!.kind}:${b.poi!.index}`).sort()).toEqual(['coffee:0', 'queue:1'])
  })
})

describe('cérebro: visitante (especialista delegado)', () => {
  it('entra pela porta, senta na mesa dele e, ao voltar, sai pela porta', () => {
    const spec = model('x', { key: 'role:r1:executor', role: 'executor', placement: { kind: 'seat', seatKind: 'especialista', slot: 'executor' }, trackId: 't1' })
    const { crowd, brains, room } = office(1, [spec], true)
    const v = brains[1]
    expect(v.visible).toBe(false)
    setStatus(v, status('working', { tool: 'read' }), 0)
    run(crowd, 0.1)
    expect(v.visible).toBe(true)
    expect(v.x).toBeLessThan(room.x)
    let crossed = false
    run(crowd, 25, () => {
      crossed ||= v.x > room.x && v.x < room.x + 1
    })
    expect(crossed).toBe(true)
    expect([v.mode, v.seat, v.sit]).toEqual(['work', 'chair', 1])
    setStatus(v, status('done'), crowd.t)
    run(crowd, 25)
    expect([v.mode, v.visible]).toEqual(['away', false])
    expect(v.x).toBeLessThan(room.x)
  })
})

describe('cérebro: determinismo', () => {
  it('mesmo sorteio e mesmos passos → mesma trajetória', () => {
    const trace = (): string[] => {
      const { crowd, brains } = office(3)
      for (const b of brains) setStatus(b, status('idle', { idleSince: 0 }), 0)
      const out: string[] = []
      run(crowd, 120, () => out.push(brains.map((b) => `${b.x.toFixed(4)},${b.z.toFixed(4)},${b.mode},${b.leisure},${b.action}`).join('|')))
      return out
    }
    expect(trace()).toEqual(trace())
  })

  it('gira pelo menor ângulo', () => {
    expect(turnToward(3, -3, 10)).toBeCloseTo(3 + (2 * Math.PI - 6))
    expect(turnToward(0.1, -0.1, 10)).toBeCloseTo(-0.1)
    expect(turnToward(0, Math.PI / 2, 0.2)).toBeCloseTo(0.2)
  })
})
