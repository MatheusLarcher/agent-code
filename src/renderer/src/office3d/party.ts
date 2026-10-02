/**
 * Festa do apagão — os efeitos (three). Nada é luz de verdade:
 *   por sala   a bola de discoteca desce do teto sobre o tapete (gira, com um
 *              halo), as manchas coloridas varrem chão e parede do fundo
 *              (InstancedMesh aditiva, uma chamada) e, se alguém come pizza, a
 *              caixa aberta fica na cadeira dele;
 *   no prédio  aviõezinhos de papel cruzando as salas da festa (pool fixo) e
 *              confete caindo da bola (o pool de particles.ts).
 * Só nas salas à vista e PERTO/MÉDIO; no LONGE a sala fica só no escuro com a
 * emergência (blackout.ts). Na volta da luz a bola sobe e some. Nada aloca por
 * quadro: matrizes e cores vão para os buffers das InstancedMesh.
 */
import { Color, Group, InstancedMesh, Mesh, Object3D, Sprite } from 'three'
import { beatAt } from './dance'
import { SEAT_Y } from './decor'
import { ORDER_SPOTS, type EnergyKit } from './energyKit'
import type { Kit } from './kit'
import { SEAT_FRONT, type RoomLayout } from './layout'
import type { Lod } from './lod'
import type { Particles } from './particles'
import { rng } from './textures'

export const SPOTS = 16
const FLOOR_SPOTS = 12
export const PLANES = 8
const BALL_DOWN = 2.15
const BALL_UP = 4
const CORD_TOP = 4.6
const DROP_S = 1.6
const RISE_S = 1.2
const SPOT_COLORS = [0xff4fa3, 0x3fd8ff, 0xffe14a, 0x6dff7a, 0xb46bff, 0xff8a3a].map((c) => new Color(c))

const dummy = new Object3D()
dummy.rotation.order = 'YXZ'

/** A bola desce com um quiquezinho no fim. */
const easeOutBack = (k: number): number => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2)

export class RoomPartyFx {
  readonly root = new Group()
  /** 0 = bola lá em cima (escondida) … 1 = embaixo, festa rolando. */
  drop = 0
  /** A sala pode ter efeito de festa neste quadro (à vista, PERTO/MÉDIO, bola descendo). */
  eligible = false
  readonly ball: Mesh
  readonly bounds: { x0: number; x1: number; z0: number; z1: number }
  private readonly cord: Mesh
  private readonly glow: Sprite
  private readonly spots: InstancedMesh
  private readonly pizza = new Group()
  private target = 0
  private readonly cx: number
  private readonly cz: number
  private readonly backZ: number

  constructor(kit: Kit, ek: EnergyKit, parent: Group, room: RoomLayout, rug: { x: number; z: number }) {
    this.cx = rug.x
    this.cz = rug.z
    this.backZ = room.z + 0.075
    this.bounds = { x0: room.x + 0.4, x1: room.x + room.width - 0.4, z0: room.z + 0.4, z1: room.z + room.depth - 0.2 }
    this.cord = new Mesh(kit.geo.cyl, ek.mat.cord)
    this.ball = new Mesh(ek.geo.ball, ek.mat.ball)
    this.glow = new Sprite(ek.mat.ballGlow)
    this.glow.scale.setScalar(1.1)
    this.spots = new InstancedMesh(kit.geo.plane, ek.mat.spot, SPOTS)
    for (let k = 0; k < SPOTS; k++) this.spots.setColorAt(k, SPOT_COLORS[k % SPOT_COLORS.length])
    this.spots.renderOrder = ORDER_SPOTS
    this.spots.frustumCulled = false
    this.glow.renderOrder = ORDER_SPOTS
    // Caixa de pizza aberta: fundo, pizza (já sem uma fatia) e a tampa em pé.
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
    this.pizza.add(base, top, lid)
    this.pizza.visible = false
    this.root.add(this.cord, this.ball, this.glow, this.spots, this.pizza)
    this.root.visible = false
    parent.add(this.root)
  }

  /** Festa ligada (a bola desce) ou desligada (sobe e some). */
  setOn(on: boolean): void {
    this.target = on ? 1 : 0
    if (on) this.root.visible = true
  }

  /** Caixa de pizza na cadeira desta mesa; null tira. */
  setPizza(desk: { x: number; z: number } | null): void {
    this.pizza.visible = desk !== null
    if (desk) this.pizza.position.set(desk.x, SEAT_Y + 0.07, desk.z + SEAT_FRONT)
  }

  /** Um quadro (só salas à vista); `lod` da sala. Devolve true enquanto anima. */
  animate(t: number, dt: number, lod: Lod): boolean {
    const step = this.target > this.drop ? dt / DROP_S : -dt / RISE_S
    if (this.drop !== this.target) this.drop = Math.max(0, Math.min(1, this.drop + step))
    if (this.drop <= 0 && this.target === 0) {
      this.root.visible = false
      this.eligible = false
      return false
    }
    const near = lod < 2
    this.root.visible = near
    this.eligible = near && this.drop > 0.5
    if (!near) return false
    const y = BALL_UP + (BALL_DOWN - BALL_UP) * (this.target === 1 ? easeOutBack(this.drop) : this.drop)
    this.ball.position.set(this.cx, y, this.cz)
    this.ball.rotation.y = t * 0.9
    this.glow.position.set(this.cx, y, this.cz)
    this.cord.scale.set(0.012, CORD_TOP - y, 0.012)
    this.cord.position.set(this.cx, (CORD_TOP + y) / 2, this.cz)
    const spinning = this.drop >= 0.98 && this.target === 1
    this.spots.visible = spinning
    if (spinning) this.placeSpots(t)
    return true
  }

  /** Manchas girando em volta da bola: no chão (achatadas) e na parede do fundo; pulsam na batida. */
  private placeSpots(t: number): void {
    const beat = beatAt(t)
    const pump = 1 + 0.18 * Math.max(0, Math.cos(2 * Math.PI * (beat - Math.floor(beat))))
    const b = this.bounds
    for (let k = 0; k < SPOTS; k++) {
      const th = k * 2.399 + t * (k % 2 === 0 ? 0.55 : -0.42)
      if (k < FLOOR_SPOTS) {
        const r = 1 + (k % 4) * 0.75
        dummy.position.set(
          Math.max(b.x0, Math.min(b.x1, this.cx + r * Math.cos(th) * 1.4)),
          0.014 + k * 0.0006,
          Math.max(b.z0, Math.min(b.z1, this.cz - 0.6 + r * Math.sin(th) * 0.8))
        )
        dummy.rotation.set(-Math.PI / 2, 0, 0)
        dummy.scale.setScalar(0.55 * pump)
      } else {
        dummy.position.set(Math.max(b.x0, Math.min(b.x1, this.cx + 4.2 * Math.sin(th))), 1 + 0.3 * Math.sin(th * 1.3 + k), this.backZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(0.5 * pump)
      }
      dummy.updateMatrix()
      this.spots.setMatrixAt(k, dummy.matrix)
    }
    this.spots.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.root.removeFromParent()
    this.spots.dispose()
  }
}

/** Aviõezinhos de papel e confete das salas em festa (pools do prédio). */
export class PartyPools {
  readonly planes: InstancedMesh
  private readonly room: Array<RoomPartyFx | null> = new Array<RoomPartyFx | null>(PLANES).fill(null)
  private readonly path = new Float32Array(PLANES * 8)
  private readonly rnd = rng(23)
  private nextConfetti = 0
  private turn = 0

  constructor(ek: EnergyKit, parent: Object3D) {
    this.planes = new InstancedMesh(ek.geo.dart, ek.mat.paper, PLANES)
    this.planes.count = 0
    this.planes.frustumCulled = false
    this.planes.name = 'paper-planes'
    parent.add(this.planes)
  }

  /** Sorteia um voo novo do avião `i` dentro da sala `fx` (de um canto a outro, pelo alto). */
  private launch(i: number, fx: RoomPartyFx): void {
    const b = fx.bounds
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
    this.room[i] = fx
  }

  /**
   * Um quadro: aviões nas salas elegíveis (as outras não recebem) e confete
   * caindo da bola a cada 2,4–3,6 s. Devolve true se há algo voando.
   */
  animate(t: number, dt: number, rooms: readonly RoomPartyFx[], particles: Particles): boolean {
    let eligible = 0
    for (let i = 0; i < rooms.length; i++) if (rooms[i].eligible) eligible++
    if (eligible === 0) {
      this.planes.count = 0
      this.room.fill(null)
      return false
    }
    const p = this.path
    let n = 0
    for (let i = 0; i < PLANES; i++) {
      let fx = this.room[i]
      if (!fx || !fx.eligible) {
        fx = this.pick(rooms)
        this.launch(i, fx)
      }
      const o = i * 8
      p[o + 7] += dt
      const k = p[o + 7] / p[o + 6]
      if (k >= 1) {
        this.launch(i, this.pick(rooms))
        continue
      }
      if (k < 0) continue
      const arc = 0.35 * Math.sin(Math.PI * k)
      const x = p[o] + (p[o + 3] - p[o]) * k
      const y = p[o + 1] + (p[o + 4] - p[o + 1]) * k + arc
      const z = p[o + 2] + (p[o + 5] - p[o + 2]) * k
      const vx = p[o + 3] - p[o]
      const vz = p[o + 5] - p[o + 2]
      const vy = p[o + 4] - p[o + 1] + 0.35 * Math.PI * Math.cos(Math.PI * k)
      dummy.position.set(x, y, z)
      dummy.rotation.set(Math.atan2(vy, Math.hypot(vx, vz)), Math.atan2(-vx, -vz), 0.25 * Math.sin(t * 5 + i))
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      this.planes.setMatrixAt(n++, dummy.matrix)
    }
    this.planes.count = n
    this.planes.instanceMatrix.needsUpdate = true
    if (t >= this.nextConfetti) {
      this.nextConfetti = t + 2.4 + this.rnd() * 1.2
      const fx = this.pick(rooms)
      particles.confettiBurst(fx.ball.position.x, fx.ball.position.y - 0.25, fx.ball.position.z, 12)
    }
    return true
  }

  /** A próxima sala elegível, em rodízio. */
  private pick(rooms: readonly RoomPartyFx[]): RoomPartyFx {
    for (let k = 0; k < rooms.length; k++) {
      const fx = rooms[(this.turn + k) % rooms.length]
      if (fx.eligible) {
        this.turn = (this.turn + k + 1) % rooms.length
        return fx
      }
    }
    return rooms[0]
  }

  dispose(): void {
    this.planes.removeFromParent()
    this.planes.dispose()
  }
}
