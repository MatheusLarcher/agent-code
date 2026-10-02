import { describe, expect, it } from 'vitest'
import { actionPose, reactionPose } from './gestures'
import {
  BLEND_S,
  CH,
  CHANNELS,
  envelope,
  LEG,
  locomotion,
  newPose,
  REACTION_S,
  SHIN,
  sitLower,
  smooth,
  standPose,
  strideLength,
  THIGH,
  type Action,
  type Pose,
  type Reaction
} from './poses'
import { PELVIS_Y } from './rig'

/** Tornozelo no plano do passo: avanço (m, para a frente) e altura do chão. */
function ankle(p: Pose, side: 'L' | 'R'): { x: number; y: number } {
  const leg = p[side === 'L' ? CH.legL : CH.legR]
  const knee = p[side === 'L' ? CH.kneeL : CH.kneeR]
  const hipY = PELVIS_Y + p[CH.pelvisY] + p[CH.hop] - 0.02
  return {
    x: THIGH * Math.sin(leg) + SHIN * Math.sin(leg - knee) - p[CH.pelvisZ],
    y: hipY - THIGH * Math.cos(leg) - SHIN * Math.cos(leg - knee)
  }
}

const REST = PELVIS_Y - 0.02 - LEG
const ACTIONS: Action[] = [
  'none', 'idle', 'sitIdle', 'type', 'typeFast', 'readScreen', 'drum', 'web', 'assist', 'wave', 'brew', 'sip', 'grabBook', 'readBook', 'lookOut',
  'stretchUp', 'water', 'readBoard', 'stick', 'admire', 'talk', 'listen', 'phone', 'wait', 'napDesk', 'napPufe'
]

describe('locomoção', () => {
  it.each([
    ['caminhada', 0],
    ['meio-termo', 0.5],
    ['corrida', 1]
  ])('%s: o pé de apoio fica parado no chão enquanto o corpo anda (fase pela distância)', (_, run) => {
    const stride = strideLength(run)
    const p = newPose()
    const planted = { L: [] as number[][], R: [] as number[][] }
    const open = { L: false, R: false }
    let lowest = Infinity
    for (let k = 0; k <= 800; k++) {
      const dist = (k / 400) * stride // dois ciclos
      locomotion(p, dist / stride, 1, run)
      for (const side of ['L', 'R'] as const) {
        const a = ankle(p, side)
        lowest = Math.min(lowest, a.y)
        const down = Math.abs(a.y - REST) < 1e-4
        if (down && !open[side]) planted[side].push([])
        if (down) planted[side][planted[side].length - 1].push(dist + a.x)
        open[side] = down
      }
    }
    // Nunca afunda no chão.
    expect(lowest).toBeGreaterThan(REST - 1e-4)
    for (const side of ['L', 'R'] as const) {
      const steps = planted[side].filter((s) => s.length > 5)
      expect(steps.length, side).toBeGreaterThanOrEqual(2)
      // No chão, a posição do pé no mundo não muda (≤ 1 mm).
      for (const s of steps) expect(Math.max(...s) - Math.min(...s), side).toBeLessThan(1e-3)
    }
  })

  it('passada da corrida é maior que a da caminhada; parado é a pose em pé', () => {
    expect(strideLength(1)).toBeGreaterThan(strideLength(0) * 1.5)
    const a = newPose()
    const b = newPose()
    locomotion(a, 0.37, 0, 0)
    standPose(b)
    expect([...a]).toEqual([...b])
  })

  it('quadril sobe e desce duas vezes por ciclo; braços em contrafase com as pernas', () => {
    const p = newPose()
    const ys: number[] = []
    for (let k = 0; k < 100; k++) {
      locomotion(p, k / 100, 1, 0)
      ys.push(p[CH.pelvisY])
      // Perna esquerda à frente → braço esquerdo para trás.
      if (Math.abs(p[CH.legL]) > 0.3) expect(Math.sign(p[CH.armFwdL])).toBe(-Math.sign(p[CH.legL]))
    }
    const peaks = ys.filter((y, i) => y > ys[(i + 99) % 100] && y >= ys[(i + 1) % 100]).length
    expect(peaks).toBe(2)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.01)
  })
})

describe('sentar', () => {
  it('na cadeira: quadril no assento e pés no chão; no pufe: afunda e estica as pernas', () => {
    const p = newPose()
    sitLower(p, 'chair')
    // Quadril no assento (topo em SEAT_Y + 0,04 = 0,40; almofada afunda um pouco).
    expect(PELVIS_Y + p[CH.pelvisY]).toBeCloseTo(0.44, 2)
    expect(Math.abs(ankle(p, 'L').y - REST)).toBeLessThan(0.01)
    sitLower(p, 'pufe')
    expect(PELVIS_Y + p[CH.pelvisY]).toBeLessThan(0.32)
    expect(ankle(p, 'L').x).toBeGreaterThan(0.3)
  })
})

describe('biblioteca de poses', () => {
  it('toda ação e reação dá canais finitos, em qualquer instante', () => {
    const p = newPose()
    const params = { speed: 1, seed: 1.3, side: -1 }
    for (const t of [0, 0.25, 0.9, 1.7, 3.2, 11]) {
      for (const a of ACTIONS) {
        standPose(p)
        actionPose(p, a, t, params)
        expect(p.every(Number.isFinite), `${a}@${t}`).toBe(true)
      }
      for (const r of Object.keys(REACTION_S) as Reaction[]) {
        reactionPose(p, r, Math.min(t, REACTION_S[r]), params, t > 1)
        expect(p.every(Number.isFinite), `${r}@${t}`).toBe(true)
      }
    }
    expect(p.length).toBe(CHANNELS)
  })

  it('gestos que contam o que está acontecendo', () => {
    const p = newPose()
    const params = { speed: 1, seed: 0, side: 1 }
    const at = (a: Action, t = 0.5): Pose => (standPose(p), actionPose(p, a, t, params), p)
    // Permissão: braço direito erguido (plaquinha acima da cabeça).
    expect(at('wave')[CH.armFwdR]).toBeGreaterThan(2.4)
    // Lendo a tela: inclina para a frente; web: recosta com a mão no queixo.
    expect(at('readScreen')[CH.lean]).toBeGreaterThan(0.2)
    expect(at('web')[CH.lean]).toBeLessThan(-0.1)
    expect(at('web')[CH.elbowR]).toBeGreaterThan(2)
    // Cochilo: olhos fechados.
    expect(at('napDesk')[CH.eyes]).toBe(0)
    expect(at('napPufe')[CH.eyes]).toBe(0)
    const r = (x: Reaction, t: number): Pose => (standPose(p), reactionPose(p, x, t, params, false), p)
    expect(r('alert', 0.2)[CH.hop]).toBeGreaterThan(0.05)
    expect(r('fistpump', 0.5)[CH.armFwdR]).toBeGreaterThan(2)
    expect(r('handsHead', 0.9)[CH.elbowL]).toBeGreaterThan(1.5)
    expect(r('facepalm', 1)[CH.elbowR]).toBeGreaterThan(2)
    expect(r('yawn', 1)[CH.mouth]).toBeGreaterThan(0.8)
    expect(r('handoff', 0.9)[CH.twist]).toBeLessThan(-0.3)
  })

  it('crossfade de ~0,2 s com easing; reações entram e saem do zero', () => {
    expect(BLEND_S).toBeCloseTo(0.2)
    expect([smooth(0), smooth(0.5), smooth(1)]).toEqual([0, 0.5, 1])
    // Easing: começa e termina devagar.
    expect(smooth(0.05)).toBeLessThan(0.05)
    expect(smooth(0.95)).toBeGreaterThan(0.95)
    for (const [r, dur] of Object.entries(REACTION_S)) {
      expect(envelope(0, dur), r).toBe(0)
      expect(envelope(dur, dur), r).toBeCloseTo(0)
      expect(envelope(dur / 2, dur), r).toBeGreaterThan(0.9)
    }
  })
})
