/**
 * Festa do apagão — os efeitos (three). Sem bola de discoteca nem manchas
 * coloridas (amb-festa): ficam a caixa de pizza aberta na cadeira de quem come,
 * os aviõezinhos de papel cruzando as zonas da festa (pool fixo) e o confete,
 * jogado por quem está dançando e comemora (a reação 'celebrate' do cérebro:
 * o personagem solta o confete, characters.ts).
 *
 * Só nas zonas à vista e PERTO/MÉDIO (`PartyZone.eligible`); no LONGE a zona fica
 * só no escuro com a emergência (zonePower.ts). Nada aloca por quadro: matrizes
 * vão para o buffer da InstancedMesh.
 */
import { Group, InstancedMesh, Mesh, Object3D } from 'three'
import { pushReaction, type Brain } from './brainBody'
import { CHAIR_CENTER_Z, SEAT_TOP } from './chairModel'
import type { EnergyKit } from './energyKit'
import type { Kit } from './kit'
import { deskPoint, SEAT_FRONT, type Placed } from './officePlan'
import { rng } from './textures'

export const PLANES = 8

const dummy = new Object3D()
dummy.rotation.order = 'YXZ'

/** Uma zona da festa: onde os aviões voam e se ela pode ter efeito neste quadro. */
export interface PartyZone {
  readonly bounds: { x0: number; x1: number; z0: number; z1: number }
  /** À vista, PERTO/MÉDIO e com a festa ligada. */
  eligible: boolean
}

/** A caixa de pizza aberta: fundo, pizza (já sem uma fatia) e a tampa em pé, na cadeira de quem come. */
export class PizzaBox {
  readonly root = new Group()

  constructor(kit: Kit, ek: EnergyKit) {
    const base = new Mesh(kit.geo.box, ek.mat.pizzaBox)
    base.scale.set(0.38, 0.05, 0.38)
    const top = new Mesh(kit.geo.plane, ek.mat.pizzaTop)
    top.scale.set(0.36, 0.36, 1)
    top.rotation.x = -Math.PI / 2
    top.position.y = 0.027
    const lid = new Mesh(kit.geo.box, ek.mat.pizzaBox)
    lid.scale.set(0.38, 0.02, 0.38)
    lid.position.set(0, 0.17, -0.2)
    lid.rotation.x = -1.35
    this.root.add(base, top, lid)
    this.root.visible = false
  }

  /** Na cadeira desta mesa (a tampa para o lado da mesa), presa ao grupo da zona dela; null tira. */
  set(desk: Placed | null, parent: Group | null): void {
    this.root.visible = desk !== null && parent !== null
    if (!desk || !parent) return
    if (this.root.parent !== parent) parent.add(this.root)
    const p = deskPoint(desk, 0, SEAT_FRONT + CHAIR_CENTER_Z)
    this.root.position.set(p.x, SEAT_TOP + 0.03, p.z)
    this.root.rotation.y = desk.yaw
  }

  dispose(): void {
    this.root.removeFromParent()
  }
}

/** Aviõezinhos de papel e o confete de quem comemora dançando (pools do escritório). */
export class PartyPools {
  readonly planes: InstancedMesh
  private readonly zone: Array<PartyZone | null> = new Array<PartyZone | null>(PLANES).fill(null)
  private readonly path = new Float32Array(PLANES * 8)
  private readonly rnd = rng(23)
  private nextConfetti = 0
  private turn = 0
  private dancer = 0

  constructor(ek: EnergyKit, parent: Object3D) {
    this.planes = new InstancedMesh(ek.geo.dart, ek.mat.paper, PLANES)
    this.planes.count = 0
    this.planes.frustumCulled = false
    this.planes.name = 'paper-planes'
    parent.add(this.planes)
  }

  /** Sorteia um voo novo do avião `i` dentro da zona `z` (de um canto a outro, pelo alto). */
  private launch(i: number, z: PartyZone): void {
    const b = z.bounds
    const r = this.rnd
    const p = this.path
    const o = i * 8
    p[o] = b.x0 + r() * (b.x1 - b.x0)
    p[o + 1] = 1.3 + r() * 0.35
    p[o + 2] = b.z0 + r() * (b.z1 - b.z0)
    p[o + 3] = b.x0 + r() * (b.x1 - b.x0)
    p[o + 4] = 0.9 + r() * 0.4
    p[o + 5] = b.z0 + r() * (b.z1 - b.z0)
    p[o + 6] = Math.max(1.4, Math.hypot(p[o + 3] - p[o], p[o + 5] - p[o + 2]) / 2.2)
    p[o + 7] = -r() * 1.2
    this.zone[i] = z
  }

  /**
   * Um quadro: aviões nas zonas elegíveis (as outras não recebem) e, a cada
   * 2,4–3,6 s, um dos que dançam (`dancers`, à vista) comemora e joga confete.
   * Devolve true se há algo voando.
   */
  animate(t: number, dt: number, zones: readonly PartyZone[], dancers: readonly Brain[]): boolean {
    let eligible = 0
    for (let i = 0; i < zones.length; i++) if (zones[i].eligible) eligible++
    if (eligible === 0) {
      this.planes.count = 0
      this.zone.fill(null)
      return false
    }
    const p = this.path
    let n = 0
    for (let i = 0; i < PLANES; i++) {
      const z = this.zone[i]
      if (!z || !z.eligible) {
        this.launch(i, this.pick(zones))
        continue
      }
      const o = i * 8
      p[o + 7] += dt
      const k = p[o + 7] / p[o + 6]
      if (k >= 1) {
        this.launch(i, this.pick(zones))
        continue
      }
      if (k < 0) continue
      const arc = 0.35 * Math.sin(Math.PI * k)
      const x = p[o] + (p[o + 3] - p[o]) * k
      const y = p[o + 1] + (p[o + 4] - p[o + 1]) * k + arc
      const zz = p[o + 2] + (p[o + 5] - p[o + 2]) * k
      const vx = p[o + 3] - p[o]
      const vz = p[o + 5] - p[o + 2]
      const vy = p[o + 4] - p[o + 1] + 0.35 * Math.PI * Math.cos(Math.PI * k)
      dummy.position.set(x, y, zz)
      dummy.rotation.set(Math.atan2(vy, Math.hypot(vx, vz)), Math.atan2(-vx, -vz), 0.25 * Math.sin(t * 5 + i))
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      this.planes.setMatrixAt(n++, dummy.matrix)
    }
    this.planes.count = n
    this.planes.instanceMatrix.needsUpdate = true
    if (t >= this.nextConfetti && dancers.length > 0) {
      this.nextConfetti = t + 2.4 + this.rnd() * 1.2
      this.dancer = (this.dancer + 1) % dancers.length
      pushReaction(dancers[this.dancer], 'celebrate')
    }
    return true
  }

  /** A próxima zona elegível, em rodízio. */
  private pick(zones: readonly PartyZone[]): PartyZone {
    for (let k = 0; k < zones.length; k++) {
      const z = zones[(this.turn + k) % zones.length]
      if (z.eligible) {
        this.turn = (this.turn + k + 1) % zones.length
        return z
      }
    }
    return zones[0]
  }

  dispose(): void {
    this.planes.removeFromParent()
    this.planes.dispose()
  }
}
