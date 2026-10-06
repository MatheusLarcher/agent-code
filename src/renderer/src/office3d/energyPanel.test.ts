import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Color, Matrix4, Mesh, MeshLambertMaterial, Vector3 } from 'three'
import type { BankAccount } from './accountBank'
import { BATTERY_COLORS } from './battery'
import { buildRoom } from './decor'
import { CELLS, EnergyPanel, PULSE_SPACING, pulseSpeed, SLOT_CELLS, SLOT_X, SWAP_S } from './energyPanel'
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

const acc = (id: string, name: string, pct: number | null, busy = 0): BankAccount => ({
  id,
  name,
  email: null,
  pct,
  level: pct === null ? null : pct < 1 ? 'apagao' : pct < 20 ? 'alerta' : pct < 50 ? 'economia' : 'cheia',
  resetsAt: null,
  weekUsed: null,
  busy,
  at: NOW
})
const withBank = (bank: BankAccount[], accountId: string, pct = 72, level: PowerLevel = 'cheia'): OfficePower => ({ ...power(level, pct, 1), accountId, bank })

describe('quadro de energia com as contas (tomada e doca)', () => {
  const dockCells = (panel: EnergyPanel, slot: number): number => {
    const m = new Matrix4()
    let n = 0
    for (let i = 0; i < SLOT_CELLS; i++) {
      panel['cells'].getMatrixAt(CELLS + slot * SLOT_CELLS + i, m)
      if (m.elements[0] !== 0) n++
    }
    return n
  }

  it('o armário é cinza claro e mais largo (1,30 m), com todas as células numa InstancedMesh só', () => {
    const { panel, done } = setup()
    expect(ENERGY_PANEL.w).toBeCloseTo(1.3)
    expect(panel['cells'].count).toBe(CELLS + SLOT_X.length * SLOT_CELLS)
    const body = panel.group.children.find((c) => c instanceof Mesh && Math.abs(c.scale.x - ENERGY_PANEL.w) < 1e-6) as Mesh
    expect((body.material as MeshLambertMaterial).color.getHexString()).toBe('b7bcc1')
    done()
  })

  it('a doca mostra só as contas conectadas fora do destaque (0 a 4); encaixe sem conta não aparece; uma conta só, sem divisor', () => {
    const { panel, done } = setup()
    const bank = [acc('a', 'Pessoal', 72, 2), acc('b', 'Empresa', 18, 1), acc('c', 'Reserva', 100), acc('d', 'Quarta', 40), acc('e', 'Quinta', 60)]
    for (let n = 1; n <= 5; n++) {
      panel.setPower(withBank(bank.slice(0, n), 'a'), NOW)
      expect(panel.docked.names).toEqual(bank.slice(1, n).map((b) => b.name))
      expect(panel['divider'].visible).toBe(n > 1)
      for (let s = 0; s < SLOT_X.length; s++) {
        expect(panel['slots'][s].group.visible).toBe(s < n - 1)
        expect(dockCells(panel, s)).toBe(s < n - 1 ? SLOT_CELLS : 0)
      }
    }
    // Sem lista de contas: a tomada sozinha, como antes.
    panel.setPower(power('cheia', 72), NOW)
    expect(panel.docked).toEqual({ names: [], more: 0 })
    done()
  })

  it('mais de 5 conectadas: as 4 primeiras da ordem na doca e "+N" na fita', () => {
    const { panel, done } = setup()
    const bank = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => acc(id, id.toUpperCase(), 50))
    panel.setPower(withBank(bank, 'c'), NOW)
    expect(panel.docked).toEqual({ names: ['A', 'B', 'D', 'E'], more: 2 })
    done()
  })

  it('a doca acende a ~45% do brilho do nível; a luzinha pulsa só na conta com agente trabalhando', () => {
    const { panel, done } = setup()
    const particles = new Particles()
    panel.setPower(withBank([acc('a', 'Pessoal', 72, 2), acc('b', 'Empresa', 18, 1), acc('c', 'Reserva', 100)], 'a'), NOW)
    const c = new Color()
    panel['cells'].getColorAt(CELLS + 0 * SLOT_CELLS, c)
    expect(c.getHex()).toBe(new Color(BATTERY_COLORS.low).multiplyScalar(0.45).getHex())
    panel.animate(0.4, 0.016, particles)
    expect(panel['slots'][0].led.color.getHexString()).not.toBe('2a2f38')
    expect(panel['slots'][1].led.color.getHexString()).toBe('2a2f38')
    particles.dispose()
    done()
  })

  it('o painel só redesenha quando o texto muda (inclusive as contas da direita)', () => {
    const { panel, done } = setup()
    const bank = [acc('a', 'Pessoal', 72), acc('b', 'Empresa', 18)]
    panel.setPower(withBank(bank, 'a'), NOW)
    const draws = panel.panelDraws
    panel.setPower(withBank(bank, 'a'), NOW + 1_000)
    expect(panel.panelDraws).toBe(draws)
    panel.setPower(withBank([bank[0], acc('b', 'Empresa', 17)], 'a'), NOW)
    expect(panel.panelDraws).toBe(draws + 1)
    done()
  })

  it('troca de conta em destaque: as células da tomada apagam e sobem de baixo para cima em ~0,6 s', () => {
    const { panel, lit, done } = setup()
    const particles = new Particles()
    const bank = [acc('a', 'Pessoal', 0), acc('r', 'Reserva', 100)]
    panel.setPower(withBank(bank, 'a', 72), NOW)
    expect(lit()).toBe(8)
    panel.setPower(withBank(bank, 'r', 100), NOW)
    expect(lit()).toBe(0)
    const seen: number[] = []
    let t = 0
    for (let k = 0; k < 8; k++) {
      panel.animate((t += 0.1), 0.1, particles)
      seen.push(lit())
    }
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen[0]).toBeLessThan(10)
    expect(seen[seen.length - 1]).toBe(10)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(SWAP_S).toBeCloseTo(0.6)
    particles.dispose()
    done()
  })
})
