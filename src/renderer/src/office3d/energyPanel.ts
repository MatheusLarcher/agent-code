/**
 * QUADRO DE ENERGIA: a fonte de energia do escritório, um armário na parede da
 * direita logo depois da porta, virado para dentro (−X) — o que era a usina de
 * tokens fora do prédio (dec-quadro-energia). Mostra:
 *   - 10 células numa coluna (acesas = energia restante; verde → amarela →
 *     vermelha, as cores da bateria do HUD);
 *   - o painel "⚡ 72% · recarrega às 23:40" (CanvasTexture redesenhada só
 *     quando o texto muda);
 *   - a placa "Modo economia 🌱" (acende na economia) e o giroflex laranja (alerta);
 *   - o eletroduto que sobe do armário e corre no alto da parede, com os pulsos
 *     de energia na velocidade do consumo (offset da textura, sem geometria por
 *     quadro); no apagão param, as células apagam e o armário solta faíscas.
 * Fica no grupo da zona dele (island1): some junto no culling. Recarga (carga
 * nova) só sobe as células — nunca mostra zerar por isso.
 */
import {
  AdditiveBlending,
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
  type Material
} from 'three'
import type { ZoneView } from './decor'
import type { EnergyKit } from './energyKit'
import type { Kit } from './kit'
import { ENERGY_PANEL, RIGHT_FACE_X, RIGHT_WALL_H } from './officePlan'
import type { Particles } from './particles'
import { BATTERY_COLORS } from './battery'
import { LEVEL_COLORS, POWER_LABEL, powerPanelText, type OfficePower, type PowerLevel } from './power'
import { canvas2d } from './textures'

export const CELLS = 10
/** Um pulso de energia a cada PULSE_SPACING m de eletroduto. */
export const PULSE_SPACING = 0.9
/** Onde o quadro fica (centro, no chão): a 1ª zona a apagar e a acender é a mais perto dele. */
export const PANEL_SPOT = { x: ENERGY_PANEL.x, z: ENERGY_PANEL.z } as const
/** O eletroduto: sobe do armário até perto do alto da parede e corre para o fundo até aqui (z). */
const CONDUIT_END_Z = 0.6
const CONDUIT_Y = RIGHT_WALL_H - 0.06
const CONDUIT_W = 0.06

/** Velocidade dos pulsos (m/s) pelo consumo: parado sem consumo, mais rápido quanto mais gasta. */
export function pulseSpeed(drainPerMin: number, level: PowerLevel | null): number {
  if (level === 'apagao' || !(drainPerMin > 0)) return 0
  return Math.min(3.5, 0.25 + 0.5 * drainPerMin)
}

const CONDUIT_COLORS: Readonly<Record<PowerLevel, number>> = { cheia: 0x5fe6ff, economia: 0xb4f25a, alerta: 0xffa53a, apagao: 0x3a3f48 }
const CELL_OFF = new Color(0x1a1f29)
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

/** A fita do eletroduto na parede (x = a face da parede): pontos (z, y) em sequência, UV ao longo dela. */
function conduitGeometry(points: ReadonlyArray<readonly [number, number]>): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const x = RIGHT_FACE_X - 0.012
  let s = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const [az, ay] = points[i]
    const [bz, by] = points[i + 1]
    const len = Math.hypot(bz - az, by - ay)
    const nz = (-(by - ay) / len) * (CONDUIT_W / 2)
    const ny = ((bz - az) / len) * (CONDUIT_W / 2)
    const v0 = pos.length / 3
    pos.push(x, ay + ny, az + nz, x, ay - ny, az - nz, x, by + ny, bz + nz, x, by - ny, bz - nz)
    uv.push(s / PULSE_SPACING, 1, s / PULSE_SPACING, 0, (s + len) / PULSE_SPACING, 1, (s + len) / PULSE_SPACING, 0)
    index.push(v0, v0 + 1, v0 + 2, v0 + 2, v0 + 1, v0 + 3)
    s += len
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

export class EnergyPanel {
  /** O armário (no referencial dele: X ao longo da parede, Z para dentro do escritório). */
  readonly group = new Group()
  visible = true
  /** À vista e fora do LONGE: só aí saem faíscas. */
  near = true
  /** Quantas vezes o painel foi redesenhado (só quando o texto muda). */
  panelDraws = 0
  private readonly mats: Material[] = []
  private readonly cells: InstancedMesh
  private readonly cellsMat = new MeshBasicMaterial({ color: 0xffffff })
  private readonly panel: { texture: CanvasTexture; ctx: CanvasRenderingContext2D | null; sig: string }
  private readonly ecoMat: MeshBasicMaterial
  private readonly giro = new Group()
  private readonly spin = new Group()
  private readonly giroDome: MeshBasicMaterial
  readonly conduit: Mesh
  private zone: ZoneView | null = null
  private level: PowerLevel | null = null
  private lit = -1
  private cellLevel: PowerLevel | null | undefined = undefined
  private speed = 0
  private nextSpark = 0
  private sparkN = 0

  constructor(
    kit: Kit,
    private readonly ek: EnergyKit
  ) {
    const { w, h, d, y0 } = ENERGY_PANEL
    const lam = (color: number): MeshLambertMaterial => this.own(new MeshLambertMaterial({ color }))
    const part = (mat: Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, parent: Group = this.group): Mesh => {
      const m = new Mesh(kit.geo.box, mat)
      m.scale.set(sx, sy, sz)
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      parent.add(m)
      return m
    }
    // Armário charcoal com a porta um pouco à frente e o puxador.
    part(lam(0x2c3330), w, h, d, 0, y0 + h / 2, d / 2)
    part(lam(0x36423b), w - 0.06, h - 0.06, 0.02, 0, y0 + h / 2, d + 0.01)
    part(lam(0xb9bec6), 0.025, 0.16, 0.03, w / 2 - 0.07, y0 + h * 0.45, d + 0.03)
    // As 10 células numa coluna, de baixo para cima.
    this.cells = new InstancedMesh(kit.geo.box, this.cellsMat, CELLS)
    for (let i = 0; i < CELLS; i++) {
      dummy.position.set(-0.06, y0 + 0.16 + i * 0.098, d + 0.027)
      dummy.scale.set(0.36, 0.072, 0.02)
      dummy.updateMatrix()
      this.cells.setMatrixAt(i, dummy.matrix)
      this.cells.setColorAt(i, CELL_OFF)
    }
    this.group.add(this.cells)
    // Painel no alto da porta do armário.
    const { texture, ctx } = canvasTexture(512, 160)
    this.panel = { texture, ctx, sig: '' }
    const face = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ map: texture })))
    face.scale.set(0.6, 0.1875, 1)
    face.position.set(0, y0 + h - 0.16, d + 0.025)
    this.group.add(face)
    // Placa "Modo economia 🌱" na parede, ao lado do armário (para a frente: do outro lado fica a porta).
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
    const ecoSign = new Mesh(kit.geo.plane, this.ecoMat)
    ecoSign.scale.set(0.46, 0.115, 1)
    ecoSign.position.set(w / 2 + 0.3, y0 + h - 0.25, 0.012)
    this.group.add(ecoSign)
    // Giroflex em cima do armário: cúpula laranja e dois fachos girando (aditivos).
    this.giroDome = this.own(new MeshBasicMaterial({ color: 0xff8a1f }))
    const dome = new Mesh(kit.geo.head, this.giroDome)
    dome.scale.set(0.5, 0.4, 0.5)
    const beams = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ color: 0xff9a2e, map: ek.tex.glow, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })))
    beams.scale.set(1.3, 0.18, 1)
    beams.rotation.x = -Math.PI / 2
    beams.renderOrder = 2
    this.spin.add(beams)
    this.giro.add(dome, this.spin)
    this.giro.position.set(0, y0 + h + 0.05, d / 2)
    this.giro.visible = false
    this.group.add(this.giro)
    // Virado para −X (o +Z local aponta para dentro do escritório).
    this.group.position.set(RIGHT_FACE_X, 0, ENERGY_PANEL.z)
    this.group.rotation.y = -Math.PI / 2
    // O eletroduto (coordenadas do mundo, na face da parede): sobe do armário e corre no alto para o fundo.
    this.conduit = new Mesh(conduitGeometry([[ENERGY_PANEL.z, y0 + h], [ENERGY_PANEL.z, CONDUIT_Y], [CONDUIT_END_Z, CONDUIT_Y]]), ek.mat.cable)
    this.conduit.name = 'power-conduit'
  }

  private own<T extends Material>(m: T): T {
    this.mats.push(m)
    return m
  }

  /** Prende o quadro e o eletroduto no grupo da zona dele (culling e LOD da zona). */
  attach(zone: ZoneView): void {
    if (this.zone === zone) return
    this.zone = zone
    zone.group.add(this.group, this.conduit)
  }

  /** Energia nova: células, painel (só se o texto mudou), placa da economia, giroflex e a cor do eletroduto. */
  setPower(power: OfficePower | null, now: number): void {
    const level = power?.level ?? null
    this.level = level
    this.speed = power ? pulseSpeed(power.drainPerMin, level) : 0
    const lit = !power || level === 'apagao' ? 0 : Math.max(1, Math.min(CELLS, Math.ceil(power.pct / 10)))
    if (lit !== this.lit || level !== this.cellLevel) {
      this.lit = lit
      this.cellLevel = level
      // A cor segue o nível (verde cheia, amarela economia, vermelha alerta), como a barra.
      const color = power ? LEVEL_COLORS[power.level] : '#000'
      for (let i = 0; i < CELLS; i++) this.cells.setColorAt(i, i < lit ? tmp.set(color) : CELL_OFF)
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
    }
    this.ecoMat.color.set(level === 'economia' ? 0xffffff : 0x3a4038)
    this.giro.visible = level === 'alerta'
    this.ek.mat.cable.color.set(level ? CONDUIT_COLORS[level] : 0x4a8fa0)
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
    ctx.strokeStyle = power ? LEVEL_COLORS[power.level] : '#5a6170'
    ctx.lineWidth = 6
    ctx.strokeRect(6, 6, 500, 148)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = power ? LEVEL_COLORS[power.level] : '#aab1bd'
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

  /** A zona do quadro está à vista? E fora do LONGE (faísca pede quadro cheio)? */
  updateView(): void {
    const lod = this.zone?.lod
    this.visible = !lod || !lod.culled
    this.near = this.visible && (!lod || lod.level < 2)
  }

  /** Um quadro: pulsos, giroflex, célula piscando e faíscas. Devolve o ritmo pedido (0, 1 baixo). */
  animate(t: number, dt: number, particles: Particles): 0 | 1 {
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
      this.cells.setColorAt(Math.max(0, this.lit - 1), Math.sin(t * 7) > 0 ? CELL_LOW : CELL_OFF)
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
      rate = 1
    } else if (this.level === 'apagao') {
      // Bateria morta: a célula de baixo pulsa vermelho fraco; o armário solta faíscas de vez em quando.
      this.cells.setColorAt(0, tmp.copy(CELL_DEAD).multiplyScalar(0.5 + 0.5 * Math.max(0, Math.sin(t * 3))))
      if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
      if (this.near && t >= this.nextSpark) this.spark(t, particles)
      rate = 1
    }
    return rate
  }

  private spark(t: number, particles: Particles): void {
    this.sparkN++
    const h = (k: number): number => {
      const s = Math.sin(this.sparkN * 91.7 + k * 13.1) * 43_758.5453
      return s - Math.floor(s)
    }
    this.nextSpark = t + 1.5 + 2.5 * h(1)
    // Da frente do armário, na altura das células.
    const x = RIGHT_FACE_X - ENERGY_PANEL.d - 0.05
    const z = ENERGY_PANEL.z + (h(2) - 0.5) * ENERGY_PANEL.w * 0.8
    const y = ENERGY_PANEL.y0 + 0.2 + h(3) * 0.9
    for (let k = 0; k < 6; k++) particles.puff('spark', x, y, z, -0.4 - h(4 + k) * 0.8, (h(10 + k) - 0.5) * 1.6)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.conduit.removeFromParent()
    this.conduit.geometry.dispose()
    this.cells.dispose()
    this.cellsMat.dispose()
    this.panel.texture.dispose()
    for (const m of this.mats) {
      const map = (m as MeshBasicMaterial).map
      if (map && map !== this.ek.tex.glow) map.dispose()
      m.dispose()
    }
    this.zone = null
  }
}
