import { describe, expect, it } from 'vitest'
import { CameraRig, easeInOut, monitorPose, shortestAngle, TWEEN_MS } from './cameraRig'
import { clampDt, dragModeFor, isClick, isTypingTarget, MAX_DT, MoveKeys, moveDelta, RUN_FACTOR, WALK_SPEED } from './input'

const plain = { tagName: 'DIV' } as unknown as EventTarget

describe('isTypingTarget', () => {
  it('reconhece campos de texto e contentEditable', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingTarget({ tagName: tag } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget(plain)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('funciona com elementos reais do DOM', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('canvas'))).toBe(false)
  })
})

describe('MoveKeys', () => {
  it('consome WASD fora de campos e ignora dentro deles', () => {
    const k = new MoveKeys()
    expect(k.down({ key: 'w', target: plain })).toBe(true)
    expect(k.down({ key: 'a', target: { tagName: 'TEXTAREA' } as unknown as EventTarget })).toBe(false)
    expect(k.down({ key: 'x', target: plain })).toBe(false)
    expect(k.down({ key: 's', target: plain, ctrlKey: true })).toBe(false)
    expect(k.has('w')).toBe(true)
    expect(k.has('a')).toBe(false)
    k.up({ key: 'W' })
    expect(k.moving).toBe(false)
  })

  it('blur limpa teclas e Shift', () => {
    const k = new MoveKeys()
    k.down({ key: 'd', target: plain })
    k.down({ key: 'Shift', target: plain })
    k.clear()
    expect(k.moving).toBe(false)
    expect(k.shift).toBe(false)
  })
})

describe('moveDelta / clampDt', () => {
  it('limita dt a 0.1 s', () => {
    expect(clampDt(5)).toBe(MAX_DT)
    expect(clampDt(0.016)).toBeCloseTo(0.016)
    expect(clampDt(-1)).toBe(0)
    expect(clampDt(NaN)).toBe(0)
  })

  it('W anda para -Z com yaw 0; Shift acelera; dt longo é cortado', () => {
    const k = new MoveKeys()
    k.down({ key: 'w', target: plain })
    const d = moveDelta(k, 0, 1)
    expect(d.dx).toBeCloseTo(0)
    expect(d.dz).toBeCloseTo(-WALK_SPEED * MAX_DT)
    k.down({ key: 'Shift', target: plain })
    expect(moveDelta(k, 0, 0.05).dz).toBeCloseTo(-WALK_SPEED * RUN_FACTOR * 0.05)
  })

  it('D anda para a direita da câmera e a diagonal não é mais rápida', () => {
    const k = new MoveKeys()
    k.down({ key: 'd', target: plain })
    expect(moveDelta(k, 0, 0.1).dx).toBeCloseTo(WALK_SPEED * 0.1)
    k.down({ key: 'w', target: plain })
    const d = moveDelta(k, Math.PI / 2, 0.1)
    expect(Math.hypot(d.dx, d.dz)).toBeCloseTo(WALK_SPEED * 0.1)
  })
})

describe('mouse', () => {
  it('mapeia botões e clique curto', () => {
    expect(dragModeFor(0)).toBe('orbit')
    expect(dragModeFor(2)).toBe('pan')
    expect(dragModeFor(1)).toBe('pan')
    expect(dragModeFor(3)).toBeNull()
    expect(isClick(2, 2)).toBe(true)
    expect(isClick(10, 0)).toBe(false)
  })
})

describe('CameraRig', () => {
  it('easeInOut e ângulo mais curto', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(1)).toBe(1)
    expect(shortestAngle(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2)
  })

  it('tween chega ao destino em ~400 ms e para', () => {
    const rig = new CameraRig({ tx: 0, ty: 0, tz: 0, yaw: 1, pitch: 0.8, distance: 20 })
    const to = monitorPose({ x: 5, y: 1, z: 2 }, { fovDeg: 50, aspect: 1.5 })
    rig.flyTo(to, 1000)
    expect(rig.step(1000 + TWEEN_MS / 2)).toBe(true)
    expect(rig.pose.tx).toBeGreaterThan(0)
    expect(rig.pose.tx).toBeLessThan(5)
    expect(rig.step(1000 + TWEEN_MS)).toBe(false)
    expect(rig.pose).toEqual(to)
    expect(rig.tweening).toBe(false)
  })

  it('mexer na câmera cancela o tween; zoom e arfagem têm limites', () => {
    const rig = new CameraRig({ tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0.5, distance: 10 })
    rig.flyTo(monitorPose({ x: 1, y: 1, z: 1 }, { fovDeg: 50, aspect: 1.5 }), 0)
    rig.move(1, 0)
    expect(rig.tweening).toBe(false)
    rig.zoom(1e6)
    expect(rig.pose.distance).toBe(60)
    rig.orbit(0, 1e6)
    expect(rig.pose.pitch).toBeLessThanOrEqual(1.45)
  })
})
