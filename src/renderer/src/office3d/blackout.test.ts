import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Color, InstancedMesh, Mesh, PerspectiveCamera, type Light, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { flicker, FLICKER_SLOT_S, LIGHTS_BACK_S, LIGHTS_OUT_S, roomDelay, roomLight } from './blackout'
import { cameraPosition, type CameraPose } from './cameraRig'
import type { RoomView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { layoutOffice } from './layout'
import { ZONES } from './officePlan'
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
  samples: [],
  accountId: null,
  bank: []
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
  /** O escritório inteiro de cima (todas as zonas à vista, PERTO/MÉDIO). */
  const whole = camera({ tx: 0, ty: 0, tz: 1.1, yaw: 0, pitch: 1.2, distance: 17 })
  const far = camera({ tx: 20, ty: 0, tz: 9, yaw: 0, pitch: 0.85, distance: 60 })
  /** Anda `secs` segundos em quadros de 0,05 s a partir de `t0`; devolve o relógio no fim. */
  const run = (t0: number, secs: number): number => {
    let t = t0
    for (let k = 0; k < Math.round(secs / 0.05); k++) s.animate((t += 0.05), 0.05)
    return t
  }
  return { s, layout, rooms, whole, far, run, feed }
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

  it('economia: luz menor e metade das luminárias apagadas; apagão: quase escuro, monitores pretos, emergência, SAÍDA e luar pelo vidro', () => {
    const { s, layout, rooms, whole, run } = setupScene(T0 + 30_000)
    const [r0] = layout.rooms
    s.updateView(whole)
    const v = rooms.get(r0.id)!
    const lounge = v.lamps.filter((l) => l.zone === 'lounge')
    const kit = s['kit']
    const [hemi] = lights(s.scene)
    const day = hemi.intensity
    s.setPower(power('economia'), 'economia', 0)
    let t = run(0, 0.2)
    expect(hemi.intensity).toBeLessThan(day)
    expect(lounge.map((l) => l.shade.material === kit.mat.shade)).toEqual([true, false])
    s.setPower(power('apagao'), 'apagao', t)
    t = run(t, LIGHTS_OUT_S + 0.3)
    expect(hemi.intensity).toBeLessThan(day * 0.6)
    expect(v.lamps.every((l) => l.shade.material === kit.mat.shadeOff)).toBe(true)
    expect([...v.screens, v.consoleScreen].every((sc) => (sc.mesh as Mesh).material === kit.mat.screenOff)).toBe(true)
    expect(v.skies.every((m) => m.material === kit.mat.skyNight)).toBe(true)
    // Apagão parado: UM escurecimento para o escritório (não um por zona); emergência, halos, luar e SAÍDA
    // são malhas únicas na casca, e cada zona acende as instâncias dela.
    const shell = v.zone('shell').group.children
    const dims = (o: Object3D[]): Object3D[] => o.filter((x) => x.visible && (x as Mesh).renderOrder === 1)
    expect(dims(shell)).toHaveLength(1)
    for (const { id } of ZONES) expect(dims(v.zone(id).group.children), id).toHaveLength(0)
    const glows = shell.find((o): o is InstancedMesh => o instanceof InstancedMesh && o.material === s.energy.kit.mat.glow)!
    const moon = shell.find((o): o is InstancedMesh => o instanceof InstancedMesh && o.material === s.energy.kit.mat.moon)!
    const exit = shell.find((o) => o instanceof Mesh && o.material === s.energy.kit.mat.exit)!
    expect([glows.visible, moon.visible, exit.visible]).toEqual([true, true, true])
    const shared = (s.energy as unknown as { shared: { glowAt: Map<string, { from: number; n: number }>; moonAt: Map<string, { from: number; n: number }> } }).shared
    const c = new Color()
    const lit = (im: InstancedMesh, i: number): boolean => (im.getColorAt(i, c), c.r + c.g + c.b > 0.05)
    for (const { id } of ZONES) {
      const g = shared.glowAt.get(id)!
      expect(g.n, id).toBeGreaterThan(0)
      // As duas emergências de uma zona alternam: pelo menos uma acesa forte ou fraca, nunca preta.
      for (let i = 0; i < g.n; i++) expect(lit(glows, g.from + i), id).toBe(true)
      const m = shared.moonAt.get(id)!
      expect(m.n > 0, id).toBe(['lounge', 'island2', 'island0'].includes(id))
      for (let i = m.from * 2; i < (m.from + m.n) * 2; i++) expect(lit(moon, i), id).toBe(true)
    }
    // A luz volta: monitores acesos de novo (a página estava guardada) e as luminárias também.
    s.setPower(power('cheia'), 'luz-voltou', t)
    t = run(t, LIGHTS_BACK_S + 0.3)
    expect(hemi.intensity).toBeCloseTo(day, 3)
    expect(v.screens.some((sc) => sc.state === 'on' && (sc.mesh as Mesh).material !== kit.mat.screenOff)).toBe(true)
    expect(v.lamps.every((l) => l.shade.material === kit.mat.shade)).toBe(true)
    for (const { id } of [...ZONES, { id: 'shell' as const }]) expect(dims(v.zone(id).group.children), id).toHaveLength(0)
    expect([glows.visible, moon.visible, exit.visible]).toEqual([false, false, false])
    expect(v.skies.every((m) => m.material === kit.mat.sky)).toBe(true)
    s.dispose()
  })

  it('a queda é zona a zona a partir do quadro de energia (island1 primeiro); a volta também', () => {
    const { s, rooms, run } = setupScene()
    s.setPower(power('apagao'), 'apagao', 0)
    run(0, 0.75)
    const dark = ZONES.map((z) => s.energy.zoneDark(z.id))
    expect(s.energy.zoneDark('island1')).toBe(true)
    expect(dark).toContain(false)
    run(0.75, 1)
    expect(ZONES.every((z) => s.energy.zoneDark(z.id))).toBe(true)
    expect(s.boardDark()).toBe(true)
    s.setPower(power('cheia'), 'luz-voltou', 2)
    run(2, 0.9)
    expect(s.energy.zoneDark('island1')).toBe(false)
    expect(ZONES.map((z) => s.energy.zoneDark(z.id))).toContain(true)
    run(2.9, LIGHTS_BACK_S)
    expect(ZONES.some((z) => s.energy.zoneDark(z.id))).toBe(false)
    expect(rooms.size).toBe(1)
    s.dispose()
  })
})
