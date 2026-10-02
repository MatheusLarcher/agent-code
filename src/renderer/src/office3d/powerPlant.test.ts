import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Color, Frustum, Group, Matrix4, PerspectiveCamera } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { BATTERY_COLORS } from './battery'
import { cameraPosition, framePose } from './cameraRig'
import { demoFeed } from './demoFeed'
import { createEnergyKit } from './energyKit'
import { createKit } from './kit'
import { buildingBounds, layoutOffice } from './layout'
import { Particles } from './particles'
import type { OfficePower, PowerLevel } from './power'
import { CELLS, officeFrame, plantSpot, PowerPlant, PULSE_SPACING, pulseSpeed } from './powerPlant'

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
  const plant = new PowerPlant(kit, ek)
  const scene = new Group()
  const layout = layoutOffice(deriveOfficeModel(demoFeed(), NOW))
  plant.sync(layout.rooms, scene)
  const cells = (): string[] => {
    const c = new Color()
    return Array.from({ length: CELLS }, (_, i) => (plant['cells'].getColorAt(i, c), `#${c.getHexString()}`))
  }
  const lit = (): number => cells().filter((h) => h !== '#1a1f29').length
  const done = (): void => {
    plant.dispose()
    ek.dispose()
    kit.dispose()
  }
  return { kit, ek, plant, scene, layout, cells, lit, done }
}

describe('usina de tokens', () => {
  it('fica à esquerda do prédio e entra no enquadramento inicial (com o alto da torre)', () => {
    const { layout, done } = setup()
    const b = buildingBounds(layout.rooms)!
    const p = plantSpot(layout.rooms)!
    expect(p.x).toBeLessThan(b.minX - 2)
    expect(p.z).toBeGreaterThan(b.minZ)
    const f = officeFrame(layout.rooms, 1.8)!
    expect(f.box.minX).toBeLessThan(p.x)
    // Pose do enquadramento: os cantos do alto da torre aparecem na tela.
    const pose = framePose(f.box, { fovDeg: 50, aspect: 16 / 9 }, undefined, undefined, f.extra)
    const cam = new PerspectiveCamera(50, 16 / 9, 0.05, 250)
    const c = cameraPosition(pose)
    cam.position.set(c.x, c.y, c.z)
    cam.lookAt(pose.tx, pose.ty, pose.tz)
    cam.updateMatrixWorld()
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
    for (const q of f.extra) expect(frustum.containsPoint(cam.position.clone().set(q.x, q.y, q.z))).toBe(true)
    done()
  })

  it('10 células acesas = energia restante, na cor do nível; o painel só redesenha quando o texto muda', () => {
    const { plant, lit, cells, done } = setup()
    const hex = (c: string): string => `#${new Color(c).getHexString()}`
    plant.setPower(power('cheia', 72), NOW)
    expect(lit()).toBe(8)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.high))
    const draws = plant.panelDraws
    plant.setPower(power('cheia', 72), NOW + 1_000)
    expect(plant.panelDraws).toBe(draws)
    plant.setPower(power('economia', 42), NOW)
    expect(plant.panelDraws).toBe(draws + 1)
    expect(lit()).toBe(5)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.mid))
    plant.setPower(power('alerta', 12), NOW)
    expect(lit()).toBe(2)
    expect(cells()[0]).toBe(hex(BATTERY_COLORS.low))
    plant.setPower(power('apagao', 0), NOW)
    expect(lit()).toBe(0)
    done()
  })

  it('placa da economia acesa só na economia; giroflex só no alerta', () => {
    const { plant, done } = setup()
    const eco = (): string => plant['ecoMat'].color.getHexString()
    const giro = (): boolean => plant['giro'].visible
    plant.setPower(power('cheia', 80), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([false, false])
    plant.setPower(power('economia', 40), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([true, false])
    plant.setPower(power('alerta', 10), NOW)
    expect([eco() === 'ffffff', giro()]).toEqual([false, true])
    done()
  })

  it('pulsos correm para as salas na velocidade do consumo (offset da textura, sem geometria nova); no apagão param e saem faíscas', () => {
    const { plant, ek, scene, done } = setup()
    const particles = new Particles()
    const puff = vi.spyOn(particles, 'puff')
    const cable = scene.children.find((o) => o.name === 'power-cables')!
    const geo = (cable as unknown as { geometry: unknown }).geometry
    expect(pulseSpeed(2, 'cheia')).toBeGreaterThan(pulseSpeed(1, 'cheia'))
    expect(pulseSpeed(0, 'cheia')).toBe(0)
    expect(pulseSpeed(5, 'apagao')).toBe(0)
    /** Metros que o pulso andou em 0,3 s (o offset dá a volta em 1: medido módulo 1). */
    const travel = (p: OfficePower): number => {
      plant.setPower(p, NOW)
      const o0 = ek.tex.pulse.offset.x
      let t = 0
      for (let k = 0; k < 3; k++) plant.animate((t += 0.1), 0.1, particles)
      return ((((o0 - ek.tex.pulse.offset.x) % 1) + 1) % 1) * PULSE_SPACING
    }
    const slow = travel(power('cheia', 70, 1))
    const fast = travel(power('cheia', 70, 3))
    expect(slow).toBeGreaterThan(0)
    expect(fast).toBeGreaterThan(slow * 1.8)
    expect(travel(power('cheia', 70, 0))).toBe(0)
    expect(travel(power('apagao', 0, 2))).toBe(0)
    // Apagão: faíscas de vez em quando (no máximo uma a cada 1,5 s).
    let t = 100
    for (let k = 0; k < 100; k++) plant.animate((t += 0.1), 0.1, particles)
    const sparks = puff.mock.calls.filter((c) => c[0] === 'spark').length
    expect(sparks).toBeGreaterThan(0)
    expect(sparks / 6).toBeLessThanOrEqual(10 / 1.5 + 1)
    expect((cable as unknown as { geometry: unknown }).geometry).toBe(geo)
    particles.dispose()
    done()
  })

  it('fora da tela não anima (o laço sob demanda pode parar)', () => {
    const { plant, done } = setup()
    const particles = new Particles()
    plant.setPower(power('alerta', 10, 2), NOW)
    expect(plant.animate(1, 0.1, particles)).toBeGreaterThan(0)
    const cam = new PerspectiveCamera(50, 1, 0.05, 250)
    cam.position.set(400, 10, 400)
    cam.lookAt(400, 0, 300)
    cam.updateMatrixWorld()
    plant.updateView(new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)), cam.position)
    expect(plant.visible).toBe(false)
    expect(plant.near).toBe(false)
    expect(plant.animate(1.1, 0.1, particles)).toBe(0)
    particles.dispose()
    done()
  })
})
