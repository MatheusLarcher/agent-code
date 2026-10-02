import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstancedMesh, Mesh, PerspectiveCamera, type Light, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { flicker, FLICKER_SLOT_S, LIGHTS_BACK_S, LIGHTS_OUT_S, roomDelay, roomLight } from './blackout'
import { cameraPosition, type CameraPose } from './cameraRig'
import type { RoomView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { layoutOffice, type RoomLayout } from './layout'
import type { OfficePower, PowerLevel } from './power'
import { OfficeScene } from './scene'

const T0 = 14_916_667 * DEMO_LOOP_MS
const PCT: Record<PowerLevel, number> = { cheia: 80, economia: 40, alerta: 10, apagao: 0 }
const power = (level: PowerLevel, drainPerMin = 0): OfficePower => ({
  pct: PCT[level],
  level,
  resetsAt: T0 + 60 * 60_000,
  drainPerMin,
  rejected: level === 'apagao',
  samples: []
})

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('piscadas do alerta (flicker)', () => {
  it('determinística por seed, curta e no máximo 2 por fatia; seeds diferentes piscam diferente', () => {
    const samples = (seed: number): number[] => Array.from({ length: 6_000 }, (_, i) => flicker(seed, i / 100))
    expect(samples(7)).toEqual(samples(7))
    expect(samples(7)).not.toEqual(samples(8))
    // Conta começos de piscada por fatia e a duração de cada uma.
    const s = samples(7)
    const perSlot = new Map<number, number>()
    let run = 0
    let blinks = 0
    for (let i = 0; i < s.length; i++) {
      const dark = s[i] < 1
      if (dark && (i === 0 || s[i - 1] === 1)) {
        blinks++
        const slot = Math.floor(i / 100 / FLICKER_SLOT_S)
        perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1)
      }
      run = dark ? run + 1 : 0
      expect(run, 'piscada curta').toBeLessThanOrEqual(17)
    }
    expect(blinks).toBeGreaterThan(5)
    expect(Math.max(...perSlot.values())).toBeLessThanOrEqual(2)
    expect(Math.min(...s)).toBeGreaterThan(0)
  })
})

describe('transição sala a sala (roomLight)', () => {
  it('apagão: cada sala treme e apaga na sua vez, todas em ~1,5 s; a 1ª da fila primeiro', () => {
    const n = 5
    expect(LIGHTS_OUT_S).toBeCloseTo(1.5)
    expect(roomDelay('out', 0, n)).toBe(0)
    expect(roomDelay('out', 4, n)).toBeGreaterThan(roomDelay('out', 1, n))
    for (let i = 0; i < n; i++) {
      expect(roomLight('out', -0.01, i, n, 3)).toBe(1)
      expect(roomLight('out', LIGHTS_OUT_S, i, n, 3)).toBe(0)
    }
    // No meio da queda: a 1ª sala já está no escuro e a última ainda acesa.
    expect(roomLight('out', 0.7, 0, n, 3)).toBe(0)
    expect(roomLight('out', 0.7, 4, n, 3)).toBe(1)
    // Treme (acende e apaga) antes de apagar de vez.
    const shake = Array.from({ length: 60 }, (_, k) => roomLight('out', k / 100, 0, n, 3))
    expect(new Set(shake.map((v) => v > 0.5)).size).toBe(2)
  })

  it('luz voltou: acende sala a sala piscando, todas acesas em ~2 s', () => {
    const n = 5
    expect(LIGHTS_BACK_S).toBeCloseTo(2)
    for (let i = 0; i < n; i++) {
      expect(roomLight('back', 0, i, n, 3)).toBeLessThan(1)
      expect(roomLight('back', LIGHTS_BACK_S, i, n, 3)).toBe(1)
    }
    expect(roomLight('back', 0.9, 0, n, 3)).toBe(1)
    expect(roomLight('back', 0.9, 4, n, 3)).toBe(0)
  })
})

function camera(pose: CameraPose): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 16 / 9, 0.05, 250)
  const p = cameraPosition(pose)
  cam.position.set(p.x, p.y, p.z)
  cam.lookAt(pose.tx, pose.ty, pose.tz)
  cam.updateMatrixWorld()
  return cam
}

function setupScene(now = T0 + 10_000) {
  const s = new OfficeScene()
  const feed = demoFeed(now)
  const model = deriveOfficeModel(feed, now)
  const layout = layoutOffice(model)
  s.sync(layout, feed, { snapshot: snapshotOf(feed, model, now), events: [], wallNow: now, t: 0 })
  const rooms = (s as unknown as { rooms: Map<string, RoomView> }).rooms
  const near = (r: RoomLayout): PerspectiveCamera => camera({ tx: r.x + r.width / 2, ty: 0, tz: r.z + r.depth / 2, yaw: 0, pitch: 0.8, distance: 9 })
  const far = camera({ tx: 20, ty: 0, tz: 9, yaw: 0, pitch: 0.85, distance: 60 })
  /** Anda `secs` segundos em quadros de 0,05 s a partir de `t0`; devolve o relógio no fim. */
  const run = (t0: number, secs: number): number => {
    let t = t0
    for (let k = 0; k < Math.round(secs / 0.05); k++) s.animate((t += 0.05), 0.05)
    return t
  }
  return { s, layout, rooms, near, far, run, feed }
}

const lights = (root: Object3D): Light[] => {
  const out: Light[] = []
  root.traverse((o) => {
    if ((o as Light).isLight) out.push(o as Light)
  })
  return out
}

describe('luz por nível na cena (sem luz nova em tempo de execução)', () => {
  it('o número de luzes é o mesmo em todos os níveis, nas transições e na festa', () => {
    const { s, run } = setupScene()
    const base = lights(s.scene)
    expect(base).toHaveLength(3)
    let t = 0
    const seen: number[] = []
    for (const [level, event] of [
      ['economia', 'economia'],
      ['alerta', 'alerta'],
      ['apagao', 'apagao'],
      ['cheia', 'luz-voltou']
    ] as const) {
      s.setPower(power(level), event, t)
      for (let k = 0; k < 8; k++) {
        t = run(t, 0.5)
        seen.push(lights(s.scene).length)
      }
      expect(lights(s.scene)).toEqual(base)
    }
    expect(new Set(seen)).toEqual(new Set([3]))
    s.dispose()
  })

  it('economia: luz menor e metade das luminárias apagadas; apagão: quase escuro, monitores pretos, emergência, SAÍDA e luar', () => {
    const { s, layout, rooms, near, run } = setupScene(T0 + 30_000)
    const [r0] = layout.rooms
    s.updateView(near(r0))
    const v = rooms.get(r0.id)!
    const kit = s['kit']
    const [hemi] = lights(s.scene)
    const day = hemi.intensity
    s.setPower(power('economia'), 'economia', 0)
    let t = run(0, 0.2)
    expect(hemi.intensity).toBeLessThan(day)
    expect(v.lamps.map((l) => l.shade.material === kit.mat.shade)).toEqual([true, false])
    s.setPower(power('apagao'), 'apagao', t)
    t = run(t, LIGHTS_OUT_S + 0.3)
    expect(hemi.intensity).toBeLessThan(day * 0.6)
    expect(v.lamps.every((l) => l.shade.material === kit.mat.shadeOff)).toBe(true)
    expect(v.screens.every((sc) => (sc.mesh as Mesh).material === kit.mat.screenOff)).toBe(true)
    expect(v.skies.every((m) => m.material === kit.mat.skyNight)).toBe(true)
    const fx = v.group.children.filter((o) => o.visible && ((o as Mesh).renderOrder ?? 0) > 0)
    // Escurecimento, luar, halos da emergência e a placa SAÍDA (desenhados depois da sala).
    expect(fx.length).toBeGreaterThanOrEqual(4)
    expect(fx.some((o) => o instanceof InstancedMesh && (o as InstancedMesh).count === 4)).toBe(true)
    // A luz volta: monitores acesos de novo (a página estava guardada) e as luminárias também.
    s.setPower(power('cheia'), 'luz-voltou', t)
    t = run(t, LIGHTS_BACK_S + 0.3)
    expect(hemi.intensity).toBeCloseTo(day, 3)
    expect(v.screens.some((sc) => sc.state === 'on' && (sc.mesh as Mesh).material !== kit.mat.screenOff)).toBe(true)
    expect(v.lamps.every((l) => l.shade.material === kit.mat.shade)).toBe(true)
    expect(v.group.children.filter((o) => o.visible && ((o as Mesh).renderOrder ?? 0) === 1)).toHaveLength(0)
    s.dispose()
  })

  it('a queda é sala a sala: no meio dela umas já apagaram e outras não', () => {
    const { s, layout, rooms, run } = setupScene()
    s.setPower(power('apagao'), 'apagao', 0)
    run(0, 0.75)
    const dark = layout.rooms.map((r) => s.energy.isDark(r.id))
    expect(dark).toContain(true)
    expect(dark).toContain(false)
    run(0.75, 1)
    expect(layout.rooms.every((r) => s.energy.isDark(r.id))).toBe(true)
    expect(rooms.size).toBe(5)
    s.dispose()
  })
})
