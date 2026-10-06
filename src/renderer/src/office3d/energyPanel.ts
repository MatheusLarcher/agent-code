/**
 * QUADRO DE ENERGIA: a fonte de energia do escritório, um armário cinza claro
 * na parede da direita, ao lado da ilha 1, virado para dentro (−X). As contas
 * Claude conectadas são as baterias dele (accountBank.ts):
 *   - a TOMADA (esquerda): a conta em destaque, com as 10 células de sempre
 *     num encaixe escuro, a moldura acesa na cor do nível e o plugue no alto,
 *     de onde sai o eletroduto (os pulsos na velocidade do consumo: offset da
 *     textura, sem geometria por quadro);
 *   - a DOCA (direita, depois do divisor): até 4 pilhas finas, uma por conta
 *     conectada que não está em destaque, na ordem do usuário, a ~45% do
 *     brilho; a luzinha em cima pulsa quando a conta tem agente trabalhando.
 *     Encaixe sem conta não aparece; com uma conta só, some o divisor;
 *   - o painel do alto (CanvasTexture escura, redesenhada só quando o texto
 *     muda) e a fita clara de nomes embaixo (energyPanelPaint.ts);
 *   - a placa "Modo economia 🌱", o giroflex no alerta, a última célula
 *     piscando e, no apagão, a célula de baixo pulsando vermelho e as faíscas.
 * Trocou a conta em destaque: as células da tomada apagam e sobem de baixo
 * para cima (SWAP_S). Todas as células (10 + 4 × 10) numa InstancedMesh só,
 * nenhuma luz nova. Fica no grupo da zona dele (island1): some junto no
 * culling. Recarga (carga nova) só sobe as células — nunca mostra zerar.
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
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  SRGBColorSpace,
  type Material
} from 'three'
import type { BankAccount } from './accountBank'
import { BATTERY_COLORS } from './battery'
import type { ZoneView } from './decor'
import type { EnergyKit } from './energyKit'
import { drawPanel, drawStrip, featuredName, PANEL_PX, panelSig, STRIP_PX, stripSig } from './energyPanelPaint'
import type { Kit } from './kit'
import { ENERGY_PANEL, RIGHT_FACE_X, RIGHT_WALL_H } from './officePlan'
import type { Particles } from './particles'
import { LEVEL_COLORS, type OfficePower, type PowerLevel } from './power'
import { canvas2d } from './textures'

export const CELLS = 10
/** Encaixes da doca (x no armário) e as células de cada um. */
export const SLOT_X: readonly number[] = [0.0, 0.16, 0.32, 0.48]
export const SLOT_CELLS = 10
/** Quanto dura a troca de bateria (as células da tomada sobem de baixo para cima). */
export const SWAP_S = 0.6
/** Um pulso de energia a cada PULSE_SPACING m de eletroduto. */
export const PULSE_SPACING = 0.9
/** Onde o quadro fica (centro, no chão): a 1ª zona a apagar e a acender é a mais perto dele. */
export const PANEL_SPOT = { x: ENERGY_PANEL.x, z: ENERGY_PANEL.z } as const
/** A tomada (x no armário) e o passo das células dela e das da doca. */
const FEAT_X = -0.39
const CELL_STEP = 0.094
const SLOT_STEP = 0.088
/** Brilho das pilhas da doca (as cores do nível, apagadas). */
const DOCK_DIM = 0.45
/** O armário em cinza claro (escolha do usuário); encaixes escuros para as células acenderem. */
const SKIN = { body: 0xb7bcc1, door: 0xc9cdd2, handle: 0x6c727a, divider: 0x9fa4aa, slot: 0x232927, plug: 0x1c2022 } as const
const LED_OFF = 0x2a2f38
/** O eletroduto: sobe do plugue até perto do alto da parede e corre para o fundo até aqui (z). */
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
const ZERO = new Matrix4().makeScale(0, 0, 0)
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

interface Painted {
  texture: CanvasTexture
  ctx: CanvasRenderingContext2D | null
  sig: string
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
  private readonly panel: Painted
  private readonly strip: Painted
  private readonly frameMat: MeshBasicMaterial
  private readonly divider: Mesh
  private readonly slots: Array<{ group: Group; led: MeshBasicMaterial }> = []
  private readonly ecoMat: MeshBasicMaterial
  private readonly giro = new Group()
  private readonly spin = new Group()
  private readonly giroDome: MeshBasicMaterial
  readonly conduit: Mesh
  private zone: ZoneView | null = null
  private level: PowerLevel | null = null
  private lit = -1
  private cellLevel: PowerLevel | null | undefined = undefined
  private color = '#000'
  /** A doca em vigor (as contas nos encaixes) e quantas não couberam. */
  private dock: BankAccount[] = []
  private more = 0
  private accountId: string | null | undefined = undefined
  /** 0 → 1 durante a troca de bateria; 1 parado. */
  private refill = 1
  private speed = 0
  private nextSpark = 0
  private sparkN = 0

  constructor(
    kit: Kit,
    private readonly ek: EnergyKit
  ) {
    const { w, h, d, y0 } = ENERGY_PANEL
    const lam = (color: number): MeshLambertMaterial => this.own(new MeshLambertMaterial({ color }))
    const part = (mat: Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, parent: Group = this.group, shadow = true): Mesh => {
      const m = new Mesh(kit.geo.box, mat)
      m.scale.set(sx, sy, sz)
      m.position.set(x, y, z)
      m.castShadow = shadow
      m.receiveShadow = true
      parent.add(m)
      return m
    }
    // Armário cinza claro, mais largo, com a porta um pouco à frente, o puxador e o divisor entre a tomada e a doca.
    part(lam(SKIN.body), w, h, d, 0, y0 + h / 2, d / 2)
    part(lam(SKIN.door), w - 0.06, h - 0.06, 0.02, 0, y0 + h / 2, d + 0.01)
    part(lam(SKIN.handle), 0.025, 0.16, 0.03, w / 2 - 0.06, y0 + h * 0.36, d + 0.03)
    this.divider = part(lam(SKIN.divider), 0.012, 0.98, 0.012, -0.12, y0 + 0.6, d + 0.026, this.group, false)
    const cellY0 = y0 + 0.2
    // A tomada: o encaixe escuro, a moldura acesa na cor do nível e o plugue no alto (de onde sai o eletroduto).
    const slotMat = lam(SKIN.slot)
    const fy = cellY0 + 4.5 * CELL_STEP
    const fh = CELLS * CELL_STEP + 0.03
    part(slotMat, 0.39, CELLS * CELL_STEP + 0.02, 0.012, FEAT_X, fy, d + 0.02, this.group, false)
    this.frameMat = this.own(new MeshBasicMaterial({ color: LEVEL_COLORS.cheia }))
    for (const [sx, sy, x, y] of [
      [0.4, 0.012, FEAT_X, fy + fh / 2],
      [0.4, 0.012, FEAT_X, fy - fh / 2],
      [0.012, fh, FEAT_X - 0.2, fy],
      [0.012, fh, FEAT_X + 0.2, fy]
    ]) part(this.frameMat, sx, sy, 0.01, x, y, d + 0.03, this.group, false)
    part(lam(SKIN.plug), 0.14, 0.07, 0.06, FEAT_X, cellY0 + CELLS * CELL_STEP + 0.03, d + 0.03)
    // A doca: o encaixe escuro de cada pilha e a luzinha "em uso" em cima (material básico, sem luz nova).
    for (const x of SLOT_X) {
      const g = new Group()
      part(slotMat, 0.13, SLOT_CELLS * SLOT_STEP + 0.05, 0.012, x, y0 + 0.24 + 4.5 * SLOT_STEP, d + 0.02, g, false)
      const led = this.own(new MeshBasicMaterial({ color: LED_OFF }))
      const bulb = new Mesh(kit.geo.dome, led)
      bulb.scale.setScalar(0.12)
      bulb.position.set(x, y0 + 0.24 + SLOT_CELLS * SLOT_STEP + 0.035, d + 0.03)
      g.add(bulb)
      g.visible = false
      this.group.add(g)
      this.slots.push({ group: g, led })
    }
    // Todas as células numa InstancedMesh só: as 10 da tomada e as 4 × 10 da doca (sem conta: escala 0).
    this.cells = new InstancedMesh(kit.geo.box, this.cellsMat, CELLS + SLOT_X.length * SLOT_CELLS)
    for (let i = 0; i < this.cells.count; i++) {
      if (i < CELLS) {
        dummy.position.set(FEAT_X, cellY0 + i * CELL_STEP, d + 0.027)
        dummy.scale.set(0.36, 0.072, 0.02)
        dummy.updateMatrix()
        this.cells.setMatrixAt(i, dummy.matrix)
      } else this.cells.setMatrixAt(i, ZERO)
      this.cells.setColorAt(i, CELL_OFF)
    }
    this.group.add(this.cells)
    // Painel largo no alto da porta e a fita clara de nomes embaixo das baterias.
    this.panel = { ...canvasTexture(PANEL_PX.w, PANEL_PX.h), sig: '' }
    const face = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ map: this.panel.texture })))
    face.scale.set(1.2, 0.234, 1)
    face.position.set(0, y0 + h - 0.16, d + 0.025)
    this.group.add(face)
    this.strip = { ...canvasTexture(STRIP_PX.w, STRIP_PX.h), sig: '' }
    const tape = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ map: this.strip.texture })))
    tape.scale.set(1.2, 0.1125, 1)
    tape.position.set(0, y0 + 0.075, d + 0.025)
    this.group.add(tape)
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
    ecoSign.position.set(w / 2 + 0.32, y0 + h - 0.25, 0.012)
    this.group.add(ecoSign)
    // Giroflex em cima da tomada: cúpula laranja e dois fachos girando (aditivos).
    this.giroDome = this.own(new MeshBasicMaterial({ color: 0xff8a1f }))
    const dome = new Mesh(kit.geo.dome, this.giroDome)
    dome.scale.set(0.5, 0.4, 0.5)
    const beams = new Mesh(kit.geo.plane, this.own(new MeshBasicMaterial({ color: 0xff9a2e, map: ek.tex.glow, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })))
    beams.scale.set(1.3, 0.18, 1)
    beams.rotation.x = -Math.PI / 2
    beams.renderOrder = 2
    this.spin.add(beams)
    this.giro.add(dome, this.spin)
    this.giro.position.set(FEAT_X, y0 + h + 0.05, d / 2)
    this.giro.visible = false
    this.group.add(this.giro)
    // Virado para −X (o +Z local aponta para dentro do escritório; o +X local, para a frente do prédio).
    this.group.position.set(RIGHT_FACE_X, 0, ENERGY_PANEL.z)
    this.group.rotation.y = -Math.PI / 2
    // O eletroduto (coordenadas do mundo, na face da parede): sai do plugue da tomada, sobe e corre no alto para o fundo.
    const plugZ = ENERGY_PANEL.z + FEAT_X
    this.conduit = new Mesh(conduitGeometry([[plugZ, y0 + h], [plugZ, CONDUIT_Y], [CONDUIT_END_Z, CONDUIT_Y]]), ek.mat.cable)
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

  /** As contas na doca agora (na ordem dos encaixes) e quantas não couberam (o "+N" da fita). */
  get docked(): { names: string[]; more: number } {
    return { names: this.dock.map((b) => b.name), more: this.more }
  }

  /** Energia nova: tomada e doca, painel e fita (só se o texto mudou), placa da economia, giroflex e a cor do eletroduto. */
  setPower(power: OfficePower | null, now: number): void {
    const level = power?.level ?? null
    this.level = level
    this.speed = power ? pulseSpeed(power.drainPerMin, level) : 0
    // Trocou a conta em destaque: outra bateria na tomada — as células apagam e sobem de baixo para cima.
    const accountId = power?.accountId ?? null
    if (this.accountId !== undefined && this.accountId !== null && accountId !== null && accountId !== this.accountId) this.refill = 0
    this.accountId = accountId
    const lit = !power || level === 'apagao' || power.unread ? 0 : Math.max(1, Math.min(CELLS, Math.ceil(power.pct / 10)))
    this.color = power ? LEVEL_COLORS[power.level] : '#000'
    this.frameMat.color.set(power ? LEVEL_COLORS[power.level] : '#5a6170')
    if (lit !== this.lit || level !== this.cellLevel || this.refill < 1) {
      this.lit = lit
      this.cellLevel = level
      this.paintFeatured()
    }
    this.setDock(power)
    this.ecoMat.color.set(level === 'economia' ? 0xffffff : 0x3a4038)
    this.giro.visible = level === 'alerta'
    this.ek.mat.cable.color.set(level ? CONDUIT_COLORS[level] : 0x4a8fa0)
    this.drawTexts(power, now)
  }

  /** As células da tomada: acesas até a carga (na troca, só até onde a bateria nova já subiu), na cor do nível. */
  private paintFeatured(): void {
    const shown = this.refill >= 1 ? this.lit : Math.min(this.lit, Math.floor(this.refill * CELLS))
    for (let i = 0; i < CELLS; i++) this.cells.setColorAt(i, i < shown ? tmp.set(this.color) : CELL_OFF)
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
  }

  /** A doca: as conectadas fora do destaque (até 4) nos encaixes; encaixe sem conta some; uma conta só, sem divisor. */
  private setDock(power: OfficePower | null): void {
    const spares = power ? power.bank.filter((b) => b.id !== power.accountId) : []
    this.dock = spares.slice(0, SLOT_X.length)
    this.more = spares.length - this.dock.length
    this.divider.visible = this.dock.length > 0
    const { y0, d } = ENERGY_PANEL
    this.slots.forEach((slot, s) => {
      const acc = this.dock[s]
      slot.group.visible = !!acc
      const n = acc && acc.pct !== null ? Math.round(acc.pct / 10) : 0
      for (let i = 0; i < SLOT_CELLS; i++) {
        const k = CELLS + s * SLOT_CELLS + i
        if (acc) {
          dummy.position.set(SLOT_X[s], y0 + 0.24 + i * SLOT_STEP, d + 0.027)
          dummy.scale.set(0.1, 0.06, 0.018)
          dummy.updateMatrix()
          this.cells.setMatrixAt(k, dummy.matrix)
        } else this.cells.setMatrixAt(k, ZERO)
        this.cells.setColorAt(k, acc && acc.level && i < n ? tmp.set(LEVEL_COLORS[acc.level]).multiplyScalar(DOCK_DIM) : CELL_OFF)
      }
      if (!acc || !acc.busy) slot.led.color.set(LED_OFF)
    })
    this.cells.instanceMatrix.needsUpdate = true
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true
  }

  /** O painel e a fita: cada um só é redesenhado quando o texto dele muda. */
  private drawTexts(power: OfficePower | null, now: number): void {
    const spares = power ? power.bank.filter((b) => b.id !== power.accountId) : []
    const sig = panelSig(power, spares, now)
    if (sig !== this.panel.sig) {
      this.panel.sig = sig
      this.panelDraws++
      if (this.panel.ctx) {
        drawPanel(this.panel.ctx, power, spares, now)
        this.panel.texture.needsUpdate = true
      }
    }
    const name = featuredName(power)
    const ssig = stripSig(name, this.dock, this.more)
    if (ssig === this.strip.sig) return
    this.strip.sig = ssig
    if (this.strip.ctx) {
      drawStrip(this.strip.ctx, name, FEAT_X, this.dock, SLOT_X, this.more, (x) => ((x + 0.6) / 1.2) * STRIP_PX.w)
      this.strip.texture.needsUpdate = true
    }
  }

  /** A zona do quadro está à vista? E fora do LONGE (faísca pede quadro cheio)? */
  updateView(): void {
    const lod = this.zone?.lod
    this.visible = !lod || !lod.culled
    this.near = this.visible && (!lod || lod.level < 2)
  }

  /** Um quadro: troca de bateria, luzinhas da doca, pulsos, giroflex, célula piscando e faíscas. Devolve o ritmo pedido (0, 1 baixo). */
  animate(t: number, dt: number, particles: Particles): 0 | 1 {
    if (!this.visible) return 0
    let rate: 0 | 1 = 0
    // A troca de bateria: a nova sobe de baixo para cima.
    if (this.refill < 1) {
      this.refill = Math.min(1, this.refill + dt / SWAP_S)
      this.paintFeatured()
      rate = 1
    }
    // A luzinha das pilhas da doca com agente trabalhando pulsa.
    for (let s = 0; s < this.dock.length; s++) {
      const acc = this.dock[s]
      if (!acc.busy || !acc.level) continue
      this.slots[s].led.color.set(LEVEL_COLORS[acc.level]).multiplyScalar(0.55 + 0.45 * Math.max(0, Math.sin(t * 4)))
      rate = 1
    }
    if (this.speed > 0) {
      const map = this.ek.tex.pulse
      map.offset.x = (map.offset.x - (this.speed * dt) / PULSE_SPACING) % 1
      rate = 1
    }
    if (this.level === 'alerta' && this.refill >= 1) {
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
    // Da frente da tomada, na altura das células.
    const x = RIGHT_FACE_X - ENERGY_PANEL.d - 0.05
    const z = ENERGY_PANEL.z + FEAT_X + (h(2) - 0.5) * 0.4
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
    this.strip.texture.dispose()
    for (const m of this.mats) {
      const map = (m as MeshBasicMaterial).map
      if (map && map !== this.ek.tex.glow) map.dispose()
      m.dispose()
    }
    this.zone = null
  }
}
