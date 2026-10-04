import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Color, Vector3 } from 'three'
import { BATTERY_COLORS } from './battery'
import { buildRoom } from './decor'
import { CELLS, EnergyPanel, PULSE_SPACING, pulseSpeed } from './energyPanel'
import { createEnergyKit } from './energyKit'
import { createKit } from './kit'
import { layoutOffice } from './layout'
import { DOOR, ENERGY_PANEL, RIGHT_FACE_X, RIGHT_WALL_Z1, zoneAt } from './officePlan'
import { Particles } from './particles'
import type { OfficePower, PowerLevel } from './power'

const NOW = new Date(2026, 9, 2, 14, 0).getTime()
const power = (level: PowerLevel, pct: number, drainPerMin = 0): OfficePower => ({
  pct,
  level,
  resetsAt: new Date(2026, 9, 2, 23, 40).getTime(),
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

function setup() {
  const kit = createKit(1)
  const ek = createEnergyKit()
  const panel = new EnergyPanel(kit, ek)
  const room = layoutOffice({ rooms: [], characters: [] }).rooms[0]
  const view = buildRoom(kit, room, () => {})
  const zone = view.zone(zoneAt(ENERGY_PANEL.x, ENERGY_PANEL.z))
  panel.attach(zone)
  const cells = (): string[] => {
    const c = new Color()
    return Array.from({ length: CELLS }, (_, i) => (panel['cells'].getColorAt(i, c), `#${c.getHexString()}`))
  }
  const lit = (): number => cells().filter((h) => h !== '#1a1f29').length
  const done = (): void => {
    panel.dispose()
    view.dispose()
    ek.dispose()
    kit.dispose()
  }
  return { kit, ek, panel, zone, cells, lit, done }
}

describe('quadro de energia (o que era a usina)', () => {
  it('fica na parede da direita, entre a porta e o fim da parede, virado para dentro, no grupo da zona dele; sem torre nem cabos', () => {
    const { panel, zone, done } = setup()
    expect(zone.id).toBe('island1')
    expect(panel.group.parent).toBe(zone.group)
    expect(panel.conduit.parent).toBe(zone.group)
    const p = panel.group.position
    expect(p.x).toBeCloseTo(RIGHT_FACE_X)
    expect(p.z - ENERGY_PANEL.w / 2).toBeGreaterThan(DOOR.z + DOOR.width / 2)
    expect(p.z + ENERGY_PANEL.w / 2).toBeLessThan(RIGHT_WALL_Z1)
    // A frente (o +Z do armário) olha para −X: para dentro do escritório.
    const front = new Vector3(0, 0, 1).applyQuaternion(panel.group.quaternion)
    expect(front.x).toBeCloseTo(-1)
    expect(zone.group.getObjectByName('power-cables')).toBeUndefined()
    done()
  })

  it('10 células acesas = energia restante, na cor do nível; o painel só redesenha quando o texto muda', () => {
    const { panel, lit, cells, done } = setup()
    const hex = (c: string): string => `#${new Color(c).getHexString()}`
    panel.setPower(power('cheia', 72), NOW)
    expect(lit()).toBe(8)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.high))
    const draws = panel.panelDraws
    panel.setPower(power('cheia', 72), NOW + 1_000)
    expect(panel.panelDraws).toBe(draws)
    panel.setPower(power('economia', 42), NOW)
    expect(panel.panelDraws).toBe(draws + 1)
    expect(lit()).toBe(5)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.mid))
    panel.setPower(power('alerta', 12), NOW)
    expect(lit()).toBe(2)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.low))
    panel.setPower(power('apagao', 0), NOW)
    expect(lit()).toBe(0)
    done()
  })

  it('recarga: com carga nova as células sobem direto (não passam por zero)', () => {
    const { panel, lit, done } = setup()
    const seen: number[] = []
    for (const pct of [30, 30, 55, 80, 100]) {
      panel.setPower(power(pct >= 50 ? 'cheia' : 'economia', pct), NOW)
      seen.push(lit())
    }
    expect(seen).toEqual([3, 3, 6, 8, 10])
    done()
  })

  it('placa da economia acesa só na economia; giroflex só no alerta', () => {
    const { panel, done } = setup()
    const eco = (): string => panel['ecoMat'].color.getHexString()
    const giro = (): boolean => panel['giro'].visible
    panel.setPower(power('cheia', 80), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([false, false])
    panel.setPower(power('economia', 40), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([true, false])
    panel.setPower(power('alerta', 10), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([false, true])
    done()
  })

  it('pulsos correm no eletroduto na velocidade do consumo (offset da textura, sem geometria nova); no apagão param e saem faíscas', () => {
    const { panel, ek, done } = setup()
    const particles = new Particles()
    const puff = vi.spyOn(particles, 'puff')
    const geo = panel.conduit.geometry
    expect(pulseSpeed(2, 'cheia')).toBeGreaterThan(pulseSpeed(1, 'cheia'))
    expect(pulseSpeed(0, 'cheia')).toBe(0)
    expect(pulseSpeed(5, 'apagao')).toBe(0)
    const travel = (p: OfficePower): number => {
      panel.setPower(p, NOW)
      const o0 = ek.tex.pulse.offset.x
      let t = 0
      for (let k = 0; k < 3; k++) panel.animate((t += 0.1), 0.1, particles)
      return ((((o0 - ek.tex.pulse.offset.x) % 1) + 1) % 1) * PULSE_SPACING
    }
    const slow = travel(power('cheia', 70, 1))
    const fast = travel(power('cheia', 70, 3))
    expect(slow).toBeGreaterThan(0)
    expect(fast).toBeGreaterThan(slow * 1.8)
    expect(travel(power('cheia', 70, 0))).toBe(0)
    expect(travel(power('apagao', 0, 2))).toBe(0)
    let t = 100
    for (let k = 0; k < 100; k++) panel.animate((t += 0.1), 0.1, particles)
    const sparks = puff.mock.calls.filter((c) => c[0] === 'spark').length
    expect(sparks).toBeGreaterThan(0)
    expect(sparks / 6).toBeLessThanOrEqual(10 / 1.5 + 1)
    expect(panel.conduit.geometry).toBe(geo)
    particles.dispose()
    done()
  })

  it('zona dele fora da tela (ou no LONGE): não anima nem solta faísca', () => {
    const { panel, zone, done } = setup()
    const particles = new Particles()
    panel.setPower(power('alerta', 10, 2), NOW)
    panel.updateView()
    expect(panel.animate(1, 0.1, particles)).toBeGreaterThan(0)
    zone.lod.culled = true
    panel.updateView()
    expect([panel.visible, panel.near]).toEqual([false, false])
    expect(panel.animate(1.1, 0.1, particles)).toBe(0)
    zone.lod.culled = false
    zone.lod.level = 2
    panel.updateView()
    expect([panel.visible, panel.near]).toEqual([true, false])
    particles.dispose()
    done()
  })
})
