/**
 * Partículas do Escritório 3D em POOLS fixos — zero alocação por quadro:
 *   confete  CONFETTI_MAX papeizinhos; cada estouro usa até CONFETTI_BURST e
 *            vive CONFETTI_LIFE s (pool cheio recicla o mais antigo);
 *   puffs    vapor do café (branco, sobe), fumaça do erro (cinza, sobe), gota
 *            de suor e água do regador (azuis, caem) e faísca do cabo da usina
 *            no apagão (amarela, pula e cai; sem luz, então brilha no escuro).
 * Cada pool é UM InstancedMesh (uma chamada de desenho) com as vivas no começo
 * do buffer: `count` = quantas estão vivas, então nada morto é desenhado; quem
 * morre troca de lugar com a última viva. `update(dt)` devolve se ainda há algo
 * vivo (o laço sob demanda continua só enquanto houver).
 */
import { Color, DoubleSide, Group, IcosahedronGeometry, InstancedMesh, MeshBasicMaterial, Object3D, PlaneGeometry, type BufferGeometry, type Material } from 'three'
import { rng as mulberry } from './textures'

export const CONFETTI_MAX = 30
export const CONFETTI_BURST = 18
export const CONFETTI_LIFE = 1.2
export const PUFF_MAX = 48

export type PuffKind = 'steam' | 'smoke' | 'sweat' | 'drop' | 'spark'

const CONFETTI_COLORS = [0xff5d73, 0xffd23f, 0x3ccf6e, 0x4aa3ff, 0xb56bff, 0xff9f43].map((c) => new Color(c))
const PUFF: Record<PuffKind, { color: Color; life: number; size: number; grow: number; gravity: number; up: number }> = {
  steam: { color: new Color(0xf5f5f5), life: 1.6, size: 0.014, grow: 0.03, gravity: 0, up: 0.22 },
  smoke: { color: new Color(0x6b6f78), life: 1.3, size: 0.05, grow: 0.11, gravity: 0, up: 0.5 },
  sweat: { color: new Color(0x8fd3ff), life: 0.75, size: 0.03, grow: 0, gravity: -4, up: 0.6 },
  drop: { color: new Color(0x5aa9ff), life: 0.6, size: 0.022, grow: 0, gravity: -6, up: 0 },
  spark: { color: new Color(0xffd36b), life: 0.55, size: 0.024, grow: 0, gravity: -5, up: 1.3 }
}
const KIND_ID: Record<PuffKind, number> = { steam: 0, smoke: 1, sweat: 2, drop: 3, spark: 4 }
const KINDS: PuffKind[] = ['steam', 'smoke', 'sweat', 'drop', 'spark']

const dummy = new Object3D()
const swapColor = new Color()

class Pool {
  readonly mesh: InstancedMesh
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  readonly spin: Float32Array
  readonly kind: Uint8Array
  private readonly fields: Array<Float32Array | Uint8Array>
  /** Vivas ocupam [0, alive). */
  alive = 0

  constructor(geo: BufferGeometry, mat: Material, readonly size: number) {
    const f = (): Float32Array => new Float32Array(size)
    this.px = f()
    this.py = f()
    this.pz = f()
    this.vx = f()
    this.vy = f()
    this.vz = f()
    this.age = f()
    this.life = f()
    this.spin = f()
    this.kind = new Uint8Array(size)
    this.fields = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.spin, this.kind]
    this.mesh = new InstancedMesh(geo, mat, size)
    this.mesh.frustumCulled = false
    for (let i = 0; i < size; i++) this.mesh.setColorAt(i, CONFETTI_COLORS[0])
    this.mesh.count = 0
  }

  /** Vaga nova no fim das vivas; pool cheio recicla a mais velha. */
  take(): number {
    if (this.alive < this.size) {
      this.mesh.count = ++this.alive
      return this.alive - 1
    }
    let oldest = 0
    for (let i = 1; i < this.size; i++) if (this.age[i] > this.age[oldest]) oldest = i
    return oldest
  }

  /** Mata `i`: a última viva vem para o lugar dela. */
  kill(i: number): void {
    const last = --this.alive
    if (i !== last) {
      for (let k = 0; k < this.fields.length; k++) this.fields[k][i] = this.fields[k][last]
      this.mesh.getColorAt(last, swapColor)
      this.mesh.setColorAt(i, swapColor)
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    }
    this.life[last] = 0
    this.mesh.count = this.alive
  }
}

export class Particles {
  readonly group = new Group()
  private readonly confetti: Pool
  private readonly puffs: Pool
  private readonly geos: BufferGeometry[]
  private readonly mats: Material[]
  private readonly rnd: () => number

  constructor(seed = 7) {
    this.rnd = mulberry(seed)
    const paper = new PlaneGeometry(1, 1.6)
    const ball = new IcosahedronGeometry(1, 1)
    const confettiMat = new MeshBasicMaterial({ side: DoubleSide })
    const puffMat = new MeshBasicMaterial({ transparent: true, opacity: 0.78, depthWrite: false })
    this.geos = [paper, ball]
    this.mats = [confettiMat, puffMat]
    this.confetti = new Pool(paper, confettiMat, CONFETTI_MAX)
    this.puffs = new Pool(ball, puffMat, PUFF_MAX)
    this.confetti.mesh.name = 'confetti'
    this.puffs.mesh.name = 'puffs'
    this.group.add(this.confetti.mesh, this.puffs.mesh)
  }

  /** Estouro de confete em (x, y, z): até CONFETTI_BURST papeizinhos para cima e para os lados. */
  confettiBurst(x: number, y: number, z: number, count = CONFETTI_BURST): void {
    const p = this.confetti
    const r = this.rnd
    for (let n = 0; n < Math.min(count, CONFETTI_MAX); n++) {
      const i = p.take()
      const a = r() * Math.PI * 2
      const out = 0.6 + r() * 0.9
      p.px[i] = x
      p.py[i] = y
      p.pz[i] = z
      p.vx[i] = Math.cos(a) * out
      p.vz[i] = Math.sin(a) * out
      p.vy[i] = 1.6 + r() * 1.4
      p.age[i] = 0
      p.life[i] = CONFETTI_LIFE * (0.8 + 0.2 * r())
      p.spin[i] = r() * 10
      p.mesh.setColorAt(i, CONFETTI_COLORS[Math.floor(r() * CONFETTI_COLORS.length) % CONFETTI_COLORS.length])
    }
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true
  }

  /** Uma bolinha: vapor/fumaça sobem; suor/gota caem (com o empurrão dx, dz). */
  puff(kind: PuffKind, x: number, y: number, z: number, dx = 0, dz = 0): void {
    const p = this.puffs
    const spec = PUFF[kind]
    const r = this.rnd
    const i = p.take()
    p.px[i] = x + (r() - 0.5) * 0.04
    p.py[i] = y
    p.pz[i] = z + (r() - 0.5) * 0.04
    p.vx[i] = dx + (r() - 0.5) * 0.08
    p.vy[i] = spec.up * (0.8 + 0.4 * r())
    p.vz[i] = dz + (r() - 0.5) * 0.08
    p.age[i] = 0
    p.life[i] = spec.life * (0.85 + 0.3 * r())
    p.kind[i] = KIND_ID[kind]
    p.mesh.setColorAt(i, spec.color)
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true
  }

  get live(): number {
    return this.confetti.alive + this.puffs.alive
  }

  /** Avança tudo; true se ainda há partícula viva. */
  update(dt: number): boolean {
    if (this.confetti.alive > 0) this.stepConfetti(dt)
    if (this.puffs.alive > 0) this.stepPuffs(dt)
    return this.live > 0
  }

  private stepConfetti(dt: number): void {
    const p = this.confetti
    const drag = Math.exp(-1.8 * dt)
    for (let i = 0; i < p.alive; ) {
      p.age[i] += dt
      if (p.age[i] >= p.life[i]) {
        p.kill(i) // a última viva veio para `i`: processa de novo
        continue
      }
      p.vx[i] *= drag
      p.vz[i] *= drag
      p.vy[i] = p.vy[i] * drag - 5.5 * dt
      p.px[i] += p.vx[i] * dt
      p.py[i] += p.vy[i] * dt
      p.pz[i] += p.vz[i] * dt
      const k = p.age[i] / p.life[i]
      const s = 0.045 * (k > 0.8 ? (1 - k) / 0.2 : 1)
      dummy.position.set(p.px[i], p.py[i], p.pz[i])
      dummy.rotation.set(p.spin[i] + p.age[i] * 9, p.spin[i] * 0.7 + p.age[i] * 6, p.age[i] * 4)
      dummy.scale.set(s, s, s)
      dummy.updateMatrix()
      p.mesh.setMatrixAt(i, dummy.matrix)
      i++
    }
    p.mesh.instanceMatrix.needsUpdate = true
  }

  private stepPuffs(dt: number): void {
    const p = this.puffs
    for (let i = 0; i < p.alive; ) {
      p.age[i] += dt
      if (p.age[i] >= p.life[i]) {
        p.kill(i)
        continue
      }
      const spec = PUFF[KINDS[p.kind[i]]]
      p.vy[i] += spec.gravity * dt
      p.px[i] += p.vx[i] * dt
      p.py[i] += p.vy[i] * dt
      p.pz[i] += p.vz[i] * dt
      const k = p.age[i] / p.life[i]
      // Cresce e some no fim (sem transparência por instância: encolhe).
      const s = (spec.size + spec.grow * k) * Math.min(1, (1 - k) * 4) * Math.min(1, k * 8 + 0.3)
      dummy.position.set(p.px[i], p.py[i], p.pz[i])
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(s, spec.gravity < 0 ? s * 1.5 : s, s)
      dummy.updateMatrix()
      p.mesh.setMatrixAt(i, dummy.matrix)
      i++
    }
    p.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.group.removeFromParent()
    this.confetti.mesh.dispose()
    this.puffs.mesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
