/**
 * USINA DE TOKENS: a fonte de energia do escritório, à esquerda do prédio e
 * dentro do enquadramento inicial (officeFrame). Uma torre-bateria com 10
 * células (acesas = energia restante; verde → amarela → vermelha, as mesmas
 * cores da bateria do HUD), o painel "⚡ 72% · reseta 23:40" numa CanvasTexture
 * redesenhada só quando o texto muda, a placa "Modo economia 🌱" (acende na
 * economia), o giroflex laranja (alerta) e um cabo da usina até cada sala, com
 * pulsos de energia correndo para as salas — offset da textura do cabo, sem
 * geometria por quadro. Pulsos na velocidade do consumo (drainPerMin); no
 * apagão param, o cabo fica morto e solta faíscas de vez em quando.
 *
 * Os cabos são fitas no chão (uma geometria só para todos, refeita quando as
 * salas mudam): da usina para trás do prédio, ao longo dele, pelo vão à
 * esquerda de cada sala, até a caixa de luz na parede dela.
 */
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  SRGBColorSpace,
  Vector3,
  type Frustum,
  type Material
} from 'three'
import { BATTERY_COLORS } from './battery'
import type { FrameBox } from './cameraRig'
import type { EnergyKit } from './energyKit'
import type { Kit } from './kit'
import { buildingBounds, type RoomLayout } from './layout'
import { LOD_BOUNDS } from './lod'
import type { Particles } from './particles'
import { LEVEL_COLORS, POWER_LABEL, powerPanelText, type OfficePower, type PowerLevel } from './power'
import { canvas2d } from './textures'

export const CELLS = 10
/** Distância da usina até a parede esquerda do prédio e quanto ela fica para dentro (z) do fundo. */
const PLANT_GAP = 3.9
const PLANT_BACK = 3
/** A torre é modelada em metros "de maquete" e aumentada por isto. */
const PLANT_SCALE = 1.2
/** Altura do topo (giroflex), já na escala — o enquadramento inicial inclui. */
export const PLANT_TOP = 3.35 * PLANT_SCALE
const TOP_LOCAL = 3.35
/** Um pulso de energia a cada PULSE_SPACING m de cabo. */
export const PULSE_SPACING = 0.9
const CABLE_W = 0.1
const CABLE_Y = 0.025

/** Onde fica a usina (centro da base); null sem salas. */
export function plantSpot(rooms: readonly RoomLayout[]): { x: number; z: number } | null {
  const b = buildingBounds(rooms as RoomLayout[])
  return b ? { x: b.minX - PLANT_GAP, z: b.minZ + PLANT_BACK } : null
}

/** O enquadramento do prédio com a usina: a caixa no chão (salas + usina) e os cantos do alto da torre. */
export function officeFrame(rooms: readonly RoomLayout[], height: number): { box: FrameBox; extra: Array<{ x: number; y: number; z: number }> } | null {
  const b = buildingBounds(rooms as RoomLayout[])
  const p = plantSpot(rooms)
  if (!b || !p) return null
  const box: FrameBox = { minX: Math.min(b.minX, p.x - 1), maxX: b.maxX, minZ: Math.min(b.minZ, p.z - 0.8), maxZ: Math.max(b.maxZ, p.z + 1), height }
  const extra: Array<{ x: number; y: number; z: number }> = []
  for (const dx of [-1.2, 1.2]) for (const dz of [-0.7, 0.7]) extra.push({ x: p.x + dx, y: PLANT_TOP, z: p.z + dz })
  return { box, extra }
}

/** Velocidade dos pulsos (m/s) pelo consumo: parado sem consumo, mais rápido quanto mais gasta. */
export function pulseSpeed(drainPerMin: number, level: PowerLevel | null): number {
  if (level === 'apagao' || !(drainPerMin > 0)) return 0
  return Math.min(3.5, 0.25 + 0.5 * drainPerMin)
}

const CABLE_COLORS: Readonly<Record<PowerLevel, number>> = { cheia: 0x5fe6ff, economia: 0xb4f25a, alerta: 0xffa53a, apagao: 0x3a3f48 }
const PANEL_COLORS = LEVEL_COLORS
const CELL_OFF = new Color(0x1a1f29)
/** Cores prontas para o quadro (nada de converter texto em cor por quadro). */
const CELL_LOW = new Color(BATTERY_COLORS.low)
const CELL_DEAD = new Color(0x5a1010)
const dummy = new Object3D()
const tmp = new Color()

function canvasTexture(w: number, h: number): { texture: CanvasTexture; ctx: CanvasRenderingContext2D | null } {
  const { canvas, ctx } = canvas2d(w, h)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return { texture, ctx }
}

export class PowerPlant {
  readonly group = new Group()
  /** Caixa da usina e dos cabos (culling). */
  readonly box = new Box3()
  visible = false
  /** À vista e fora do LONGE: só aí saem faíscas (partícula pede quadro cheio; no LONGE o laço fica em ~30/s). */
  near = false
  /** Quantas vezes o painel foi redesenhado (só quando o texto muda). */
  panelDraws = 0
  private readonly mats: Material[] = []
  private readonly cells: InstancedMesh
  private readonly cellsMat = new MeshBasicMaterial({ color: 0xffffff })
  private readonly panel: { texture: CanvasTexture; ctx: CanvasRenderingContext2D | null; sig: string }
  private readonly eco: Mesh
  private readonly ecoMat: MeshBasicMaterial
  private readonly giro = new Group()
  private readonly spin = new Group()
  private readonly giroBeams: Mesh
  private readonly giroDome: MeshBasicMaterial
  private cables: Mesh | null = null
  private junctions: InstancedMesh | null = null
  /** Pontos dos cabos (x, z) em sequência — para sortear onde sai a faísca. */
  private path = new Float32Array(0)
  private level: PowerLevel | null = null
  private lit = -1
  private cellLevel: PowerLevel | null | undefined = undefined
  private speed = 0
  private nextSpark = 0
  private sparkN = 0
  private sig = ''

  constructor(
    private readonly kit: Kit,
    private readonly ek: EnergyKit
  ) {
    const lam = (color: number): MeshLambertMaterial => this.own(new MeshLambertMaterial({ color }))
    const part = (mat: Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, geo: BufferGeometry = kit.geo.box): Mesh => {
      const m = new Mesh(geo, mat)
      m.scale.set(sx, sy, sz)
      m.position.set(x, y, z)
      this.group.add(m)
      return m
    }
    // Base, corpo da bateria, polo "+" e a faixa do raio.
    part(lam(0x6b6f78), 1.7, 0.12, 1.5, 0, 0.06, 0)
    part(lam(0x232838), 1.15, 2.3, 0.95, 0, 1.27, 0)
    part(lam(0xb9bec6), 0.36, 0.2, 0.36, 0, 2.52, 0, kit.geo.cyl)
    part(lam(0xf2c230), 1.17, 0.1, 0.97, 0, 2.3, 0)
    this.cells = new InstancedMesh(kit.geo.box, this.cellsMat, CELLS)
    for (let i = 0; i < CELLS; i++) {
      dummy.position.set(0, 0.36 + i * 0.19, 0.48)
      dummy.scale.set(0.82, 0.15, 0.04)
      dummy.updateMatrix()
      this.cells.setMatrixAt(i, dummy.matrix)
      this.cells.setColorAt(i, CELL_OFF)
    }
    this.group.add(this.cells)
    // Painel inclinado para a câmera, com moldura.
    const { texture, ctx } = canvasTexture(512, 160)
    this.panel = { texture, ctx, sig: '' }
    const pg = new Group()
    pg.position.set(0, 2.92, 0.15)
    pg.rotation.x = -0.35
    this.group.add(pg)
    const frame = new Mesh(kit.geo.box, lam(0x15171b))
    frame.scale.set(2.02, 0.66, 0.06)
    const face = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ map: texture })))
    face.scale.set(1.92, 0.6, 1)
    face.position.z = 0.032
    pg.add(frame, face)
    // Placa "Modo economia 🌱" num braço à direita da torre.
    const eco = canvasTexture(256, 64)
    if (eco.ctx) {
      eco.ctx.fillStyle = '#1f7a3a'
      eco.ctx.fillRect(0, 0, 256, 64)
      eco.ctx.fillStyle = '#f1ffe8'
      eco.ctx.font = 'bold 30px "Segoe UI", "Segoe UI Emoji", sans-serif'
      eco.ctx.textAlign = 'center'
      eco.ctx.textBaseline = 'middle'
      eco.ctx.fillText('Modo economia 🌱', 128, 34)
    }
    this.ecoMat = this.own(new MeshBasicMaterial({ map: eco.texture, color: 0x3a4038 }))
    part(lam(0x2b2b2b), 0.4, 0.04, 0.04, 0.75, 1.6, 0.2)
    this.eco = new Mesh(kit.geo.plane, this.ecoMat)
    this.eco.scale.set(1.1, 0.28, 1)
    this.eco.position.set(1.2, 1.6, 0.23)
    this.group.add(this.eco)
    // Giroflex no alto do painel: cúpula laranja e dois fachos girando (aditivos).
    this.giroDome = this.own(new MeshBasicMaterial({ color: 0xff8a1f }))
    const dome = new Mesh(kit.geo.head, this.giroDome)
    dome.scale.set(1, 0.8, 1)
    this.giroBeams = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ color: 0xff9a2e, map: ek.tex.glow, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })))
    this.giroBeams.scale.set(2.6, 0.32, 1)
    this.giroBeams.rotation.x = -Math.PI / 2
    this.giroBeams.renderOrder = 2
    this.spin.add(this.giroBeams)
    this.giro.add(dome, this.spin)
    this.giro.position.set(0, TOP_LOCAL - 0.12, 0.05)
    this.giro.visible = false
    this.group.add(this.giro)
    this.group.scale.setScalar(PLANT_SCALE)
    this.group.visible = false
  }

  private own<T extends Material>(m: T): T {
    this.mats.push(m)
    return m
  }

  /** Salas mudaram: a usina vai para o lado do prédio e os cabos são refeitos. */
  sync(rooms: readonly RoomLayout[], scene: Group | Object3D): void {
    const p = plantSpot(rooms)
    const sig = p ? rooms.map((r) => `${r.x},${r.z}`).join(';') : ''
    if (sig === this.sig) return
    this.sig = sig
    this.disposeCables()
    if (!p) {
      this.group.visible = false
      this.visible = false
      this.group.removeFromParent()
      return
    }
    if (!this.group.parent) scene.add(this.group)
    this.group.position.set(p.x, 0, p.z)
    this.buildCables(rooms, p, scene)
    // Sem câmera ainda (updateView), fica à vista, como o resto da cena.
    this.group.visible = true
    this.visible = true
    this.near = true
  }

  /** Fita de cada sala: da usina para o fundo, ao longo do prédio, pelo vão à esquerda da sala e até a parede dela. */
  private buildCables(rooms: readonly RoomLayout[], p: { x: number; z: number }, scene: Group | Object3D): void {
    const b = buildingBounds(rooms as RoomLayout[])!
    const sorted = [...rooms].sort((a, c) => a.x - c.x || a.z - c.z)
    const pts: number[] = []
    const starts: number[] = []
    sorted.forEach((r, k) => {
      const row = Math.round((r.z - b.minZ) / 4) % 3
      const xs = p.x + 0.7 * PLANT_SCALE + 0.1 * k
      const zb = b.minZ - 0.7 - 0.1 * k
      const xg = r.x - 1.15 + 0.15 * row
      const ze = r.z + 0.45 + 0.1 * row
      starts.push(pts.length / 2)
      pts.push(xs, p.z, xs, zb, xg, zb, xg, ze, r.x - 0.06, ze)
    })
    this.path = new Float32Array(pts)
    const pos: number[] = []
    const uv: number[] = []
    const index: number[] = []
    for (let c = 0; c < starts.length; c++) {
      const from = starts[c]
      const to = c + 1 < starts.length ? starts[c + 1] : pts.length / 2
      let s = 0
      for (let i = from; i < to - 1; i++) {
        const ax = pts[i * 2]
        const az = pts[i * 2 + 1]
        const bx = pts[i * 2 + 2]
        const bz = pts[i * 2 + 3]
        const len = Math.hypot(bx - ax, bz - az)
        if (len < 1e-4) continue
        const nx = (-(bz - az) / len) * (CABLE_W / 2)
        const nz = ((bx - ax) / len) * (CABLE_W / 2)
        const v0 = pos.length / 3
        pos.push(ax + nx, CABLE_Y, az + nz, ax - nx, CABLE_Y, az - nz, bx + nx, CABLE_Y, bz + nz, bx - nx, CABLE_Y, bz - nz)
        uv.push(s / PULSE_SPACING, 1, s / PULSE_SPACING, 0, (s + len) / PULSE_SPACING, 1, (s + len) / PULSE_SPACING, 0)
        index.push(v0, v0 + 1, v0 + 2, v0 + 2, v0 + 1, v0 + 3)
        s += len
      }
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
    geo.setIndex(index)
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    this.cables = new Mesh(geo, this.ek.mat.cable)
    this.cables.name = 'power-cables'
    scene.add(this.cables)
    // Caixa de luz na parede de cada sala, onde o cabo chega.
    this.junctions = new InstancedMesh(this.kit.geo.box, this.ek.mat.junction, Math.max(1, sorted.length))
    sorted.forEach((r, k) => {
      const e = starts[k] + 4
      dummy.position.set(this.path[e * 2] - 0.06, 0.24, this.path[e * 2 + 1])
      dummy.scale.set(0.1, 0.34, 0.26)
      dummy.updateMatrix()
      this.junctions!.setMatrixAt(k, dummy.matrix)
    })
    this.junctions.count = sorted.length
    this.junctions.computeBoundingSphere()
    scene.add(this.junctions)
    this.box.makeEmpty()
    for (let i = 0; i < pts.length; i += 2) this.box.expandByPoint(new Vector3(pts[i], 0, pts[i + 1]))
    this.box.expandByPoint(new Vector3(p.x - 1.2, PLANT_TOP + 0.5, p.z - 1.2)).expandByPoint(new Vector3(p.x + 2.2, 0, p.z + 1.2))
  }

  /** Energia nova: células, painel (só se o texto mudou), placa da economia, giroflex e a cor do cabo. */
  setPower(power: OfficePower | null, now: number): void {
    const level = power?.level ?? null
    this.level = level
    this.speed = power ? pulseSpeed(power.drainPerMin, level) : 0
    const lit = !power || level === 'apagao' ? 0 : Math.max(1, Math.min(CELLS, Math.ceil(power.pct / 10)))
    if (lit !== this.lit || level !== this.cellLevel) {
      this.lit = lit
      this.cellLevel = level
      // A cor segue o nível (verde cheia, amarela economia, vermelha alerta), como a barra.
      const color = power ? PANEL_COLORS[power.level] : '#000'
      for (let i = 0; i < CELLS; i++) this.cells.setColorAt(i, i < lit ? tmp.set(color) : CELL_OFF)
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
    }
    this.ecoMat.color.set(level === 'economia' ? 0xffffff : 0x3a4038)
    this.giro.visible = level === 'alerta'
    this.ek.mat.cable.color.set(level ? CABLE_COLORS[level] : 0x4a8fa0)
    this.drawPanel(power, now)
  }

  private drawPanel(power: OfficePower | null, now: number): void {
    const line = power ? powerPanelText(power, now) : '⚡ --%'
    const sub = power ? `ENERGIA DO ESCRITÓRIO · ${POWER_LABEL[power.level]}` : 'Sem leitura da sessão de 5h'
    const sig = `${line}|${sub}|${power?.level ?? ''}`
    if (sig === this.panel.sig) return
    this.panel.sig = sig
    this.panelDraws++
    const ctx = this.panel.ctx
    if (!ctx) return
    ctx.fillStyle = '#0d1016'
    ctx.fillRect(0, 0, 512, 160)
    ctx.strokeStyle = power ? PANEL_COLORS[power.level] : '#5a6170'
    ctx.lineWidth = 6
    ctx.strokeRect(6, 6, 500, 148)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = power ? PANEL_COLORS[power.level] : '#aab1bd'
    let size = 58
    ctx.font = `bold ${size}px "Segoe UI", "Segoe UI Emoji", sans-serif`
    while (size > 30 && ctx.measureText(line).width > 470) {
      size -= 4
      ctx.font = `bold ${size}px "Segoe UI", "Segoe UI Emoji", sans-serif`
    }
    ctx.fillText(line, 256, 62)
    ctx.fillStyle = '#cfd5de'
    ctx.font = '600 24px "Segoe UI", sans-serif'
    ctx.fillText(sub, 256, 122)
    this.panel.texture.needsUpdate = true
  }

  /** A câmera mudou: a usina (e os cabos) estão à vista? E perto o bastante para faísca valer o quadro? */
  updateView(frustum: Frustum, cam: Vector3): void {
    const on = this.group.parent !== null && !this.box.isEmpty() && frustum.intersectsBox(this.box)
    this.visible = on
    this.near = on && this.box.distanceToPoint(cam) < LOD_BOUNDS[1]
    this.group.visible = on
    if (this.cables) this.cables.visible = on
    if (this.junctions) this.junctions.visible = on
  }

  /** Um quadro: pulsos, giroflex, célula piscando e faíscas. Devolve o ritmo pedido (0, 1 baixo, 2 cheio). */
  animate(t: number, dt: number, particles: Particles): 0 | 1 | 2 {
    if (!this.visible) return 0
    let rate: 0 | 1 = 0
    if (this.speed > 0) {
      const map = this.ek.tex.pulse
      map.offset.x = (map.offset.x - (this.speed * dt) / PULSE_SPACING) % 1
      rate = 1
    }
    if (this.level === 'alerta') {
      this.spin.rotation.y = t * 4.5
      this.giroDome.color.setRGB(1, 0.42 + 0.25 * Math.max(0, Math.sin(t * 9)), 0.08)
      // A última célula acesa pisca.
      const top = Math.max(0, this.lit - 1)
      this.cells.setColorAt(top, Math.sin(t * 7) > 0 ? CELL_LOW : CELL_OFF)
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
      rate = 1
    } else if (this.level === 'apagao') {
      // Bateria morta: a célula de baixo pulsa vermelho fraco; o cabo solta faíscas de vez em quando.
      this.cells.setColorAt(0, tmp.copy(CELL_DEAD).multiplyScalar(0.5 + 0.5 * Math.max(0, Math.sin(t * 3))))
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
      if (this.near && t >= this.nextSpark) this.spark(t, particles)
      rate = 1
    }
    return rate
  }

  private spark(t: number, particles: Particles): void {
    const n = this.path.length / 2
    this.sparkN++
    const h = (k: number): number => {
      const s = Math.sin(this.sparkN * 91.7 + k * 13.1) * 43_758.5453
      return s - Math.floor(s)
    }
    this.nextSpark = t + 1.5 + 2.5 * h(1)
    if (n < 2) return
    const i = Math.floor(h(2) * (n - 1))
    const f = h(3)
    const x = this.path[i * 2] + (this.path[i * 2 + 2] - this.path[i * 2]) * f
    const z = this.path[i * 2 + 1] + (this.path[i * 2 + 3] - this.path[i * 2 + 1]) * f
    for (let k = 0; k < 6; k++) particles.puff('spark', x, 0.05, z, (h(4 + k) - 0.5) * 1.6, (h(10 + k) - 0.5) * 1.6)
  }

  private disposeCables(): void {
    if (this.cables) {
      this.cables.removeFromParent()
      this.cables.geometry.dispose()
      this.cables = null
    }
    if (this.junctions) {
      this.junctions.removeFromParent()
      this.junctions.dispose()
      this.junctions = null
    }
    this.path = new Float32Array(0)
  }

  dispose(): void {
    this.disposeCables()
    this.group.removeFromParent()
    this.cells.dispose()
    this.cellsMat.dispose()
    this.panel.texture.dispose()
    for (const m of this.mats) {
      const map = (m as MeshBasicMaterial).map
      if (map && map !== this.ek.tex.glow) map.dispose()
      m.dispose()
    }
  }
}
