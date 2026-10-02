/**
 * O projetor de UMA sala (three): a tela retrátil presa no alto da parede do
 * fundo (rolo, suportes, borda preta, pano e a barra de baixo, que desce por
 * cima da placa do projeto) e o projetor pendurado no teto, no corredor entre
 * as mesas do meio, com o facho de luz falso (malha aditiva) e o brilho da lente.
 *
 *   setWant(down)   a tela desce (DROP_S, com um quique) ou sobe (RISE_S);
 *   animate(...)    um quadro da sala À VISTA: a descida, e a imagem que acende
 *                   (LIT_S) com a tela toda embaixo e a sala com energia. Fora
 *                   da tela, `snap` põe tudo no estado final, sem animar o atraso;
 *   paint(...)      desenha a imagem (projectorPaint) na textura e no telão grande.
 *
 * LOD da sala: no LONGE somem o facho, o brilho e o projetor (fica a tela). Na
 * hora em que a imagem começa a acender, `onLit` avisa a cena (os agentes da
 * sala olham para a tela). `dispose` libera o que é da sala: textura, os
 * materiais clonados e o grupo.
 */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, Sprite, type Material, type Object3D } from 'three'
import { PROJECTOR_KEY } from './engineTypes'
import type { Kit } from './kit'
import type { Lod } from './lod'
import { BEAM_OPACITY, CEILING_Y, CLOTH_H, CLOTH_W, IMG_H, IMG_W, IMG_Y, LENS, PROJ_Y, PROJ_Z, SCREEN_Z, TOP_Y, type ProjectorKit } from './projectorKit'
import { paintProjector, PROJ_H, PROJ_W, type ProjectorView } from './projectorPaint'
import { canvas2d } from './textures'

export const DROP_S = 2.2
export const RISE_S = 1.6
export const LIT_S = 0.7

/** Desce com um quiquezinho no fim (como a bola da festa). */
const easeOutBack = (k: number): number => 1 + 1.9 * Math.pow(k - 1, 3) + 0.9 * Math.pow(k - 1, 2)

export class RoomProjector {
  readonly root = new Group()
  /** 0 = enrolada no alto … 1 = toda embaixo. */
  drop = 0
  /** 0 = apagada … 1 = imagem acesa. */
  lit = 0
  /** A tela deve descer. */
  want = false
  readonly texture: CanvasTexture
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly cloth: Mesh
  private readonly border: Mesh
  private readonly bar: Mesh
  private readonly image: Mesh
  private readonly imageMat: MeshBasicMaterial
  private readonly beam: Mesh
  private readonly beamMat: MeshBasicMaterial
  private readonly glow: Sprite
  private readonly led: Mesh
  private readonly rig = new Group()
  private mirrorCtx: CanvasRenderingContext2D | null = null
  /** Último nível aplicado (o LONGE esconde o projetor e o facho). */
  private level: Lod | -1 = -1
  /** Chave de pick da tela embaixo (montada uma vez: a descida não aloca). */
  private readonly pickKey: string
  /** A imagem começou a acender (avisa uma vez por acendida). */
  onLit: () => void = () => {}

  constructor(
    private readonly kit: Kit,
    private readonly pk: ProjectorKit,
    parent: Object3D,
    readonly roomId: string,
    anchor: { x: number; z: number }
  ) {
    this.root.position.set(anchor.x, 0, anchor.z)
    this.root.name = 'projector'
    this.pickKey = `${PROJECTOR_KEY}${roomId}`
    const box = (mat: Material, w: number, h: number, d: number, x: number, y: number, z: number, into: Object3D = this.root): Mesh => {
      const m = new Mesh(kit.geo.box, mat)
      m.scale.set(w, h, d)
      m.position.set(x, y, z)
      into.add(m)
      return m
    }
    // Rolo no alto da parede, com dois suportes até ela.
    box(pk.mat.housing, CLOTH_W + 0.34, 0.13, 0.14, 0, TOP_Y + 0.07, SCREEN_Z).castShadow = true
    for (const x of [-1.45, 1.45]) box(pk.mat.bracket, 0.05, 0.04, SCREEN_Z - 0.04, x, TOP_Y + 0.02, SCREEN_Z / 2)
    // Pano (com a borda preta atrás), a barra de baixo: escalam com a descida.
    this.border = box(pk.mat.border, CLOTH_W + 0.12, 1, 0.012, 0, TOP_Y, SCREEN_Z - 0.008)
    this.cloth = new Mesh(kit.geo.plane, pk.mat.cloth)
    this.cloth.position.set(0, TOP_Y, SCREEN_Z)
    this.root.add(this.cloth)
    this.bar = box(pk.mat.housing, CLOTH_W + 0.18, 0.05, 0.05, 0, TOP_Y, SCREEN_Z)
    // A imagem projetada: textura própria, aparece (opacidade) quando acende.
    const { canvas, ctx } = canvas2d(PROJ_W, PROJ_H)
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = kit.anisotropy
    this.imageMat = new MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0, toneMapped: false })
    this.image = new Mesh(kit.geo.plane, this.imageMat)
    this.image.scale.set(IMG_W, IMG_H, 1)
    this.image.position.set(0, IMG_Y, SCREEN_Z + 0.004)
    this.image.visible = false
    this.root.add(this.image)
    // O projetor no teto: chapa, haste, corpo, lente e o LED.
    const plate = new Mesh(kit.geo.cyl, kit.mat.metal)
    plate.scale.set(0.24, 0.025, 0.24)
    plate.position.set(0, CEILING_Y, PROJ_Z)
    const pole = new Mesh(kit.geo.cyl, kit.mat.metal)
    pole.scale.set(0.035, CEILING_Y - PROJ_Y - 0.06, 0.035)
    pole.position.set(0, (CEILING_Y + PROJ_Y + 0.06) / 2, PROJ_Z)
    this.rig.add(plate, pole)
    box(pk.mat.body, 0.32, 0.1, 0.27, 0, PROJ_Y, PROJ_Z, this.rig).castShadow = true
    const lens = new Mesh(kit.geo.cyl, pk.mat.lens)
    lens.scale.set(0.08, 0.05, 0.08)
    lens.rotation.x = Math.PI / 2
    lens.position.set(LENS.x, LENS.y, LENS.z + 0.03)
    this.rig.add(lens)
    this.led = box(pk.mat.ledOff, 0.02, 0.02, 0.01, -0.1, PROJ_Y + 0.02, PROJ_Z - 0.136, this.rig)
    this.root.add(this.rig)
    // O facho e o brilho da lente (materiais por sala: a opacidade é dela).
    this.beamMat = pk.mat.beam.clone()
    this.beam = new Mesh(pk.geo.beam, this.beamMat)
    this.beam.renderOrder = 2
    this.beam.visible = false
    this.glow = new Sprite(pk.mat.glow.clone())
    this.glow.position.set(LENS.x, LENS.y, LENS.z - 0.01)
    this.glow.scale.setScalar(0.42)
    this.glow.renderOrder = 2
    this.glow.visible = false
    this.root.add(this.beam, this.glow)
    this.place()
    parent.add(this.root)
  }

  /** Pano, borda e barra na altura da descida (a imagem só com a tela toda embaixo). */
  private place(): void {
    const k = this.want ? easeOutBack(this.drop) : this.drop
    const h = Math.max(0.0001, CLOTH_H * k)
    this.cloth.scale.set(CLOTH_W, h, 1)
    this.cloth.position.y = TOP_Y - h / 2
    this.cloth.visible = this.drop > 0.002
    this.border.scale.y = h + 0.06 * Math.min(1, k * 4)
    this.border.position.y = TOP_Y - this.border.scale.y / 2
    this.border.visible = this.cloth.visible
    this.bar.position.y = TOP_Y - h - 0.02
    const key = this.drop >= 0.98 ? this.pickKey : null
    this.cloth.userData.charKey = key
    this.image.userData.charKey = key
  }

  /** Acesa (ou acendendo): a imagem, o facho e o brilho na intensidade `lit`. */
  private shine(): void {
    const on = this.lit > 0.001
    this.image.visible = on
    this.imageMat.opacity = this.lit
    const far = this.level === 2
    this.beam.visible = on && !far
    this.beamMat.opacity = BEAM_OPACITY * this.lit
    this.glow.visible = on && !far
    ;(this.glow.material as Material).opacity = 0.9 * this.lit
    this.led.material = on ? this.pk.mat.ledOn : this.pk.mat.ledOff
  }

  setWant(down: boolean): void {
    this.want = down
  }

  /** Fora da tela: tudo direto no estado final (sem animar o atraso). */
  snap(dark: boolean): void {
    this.drop = this.want ? 1 : 0
    this.lit = this.want && !dark ? 1 : 0
    this.place()
    this.shine()
  }

  /** Nível da sala: no LONGE, sem projetor, facho e brilho. */
  setLevel(level: Lod): void {
    if (level === this.level) return
    this.level = level
    this.rig.visible = level < 2
    this.shine()
  }

  /** Um quadro da sala à vista; `dark` = sala sem energia (projetor desligado). true enquanto anima. */
  animate(dt: number, dark: boolean): boolean {
    let moving = false
    const target = this.want ? 1 : 0
    if (this.drop !== target) {
      // Antes de subir, a imagem apaga.
      if (target === 1 || this.lit <= 0) this.drop = Math.max(0, Math.min(1, this.drop + (target === 1 ? dt / DROP_S : -dt / RISE_S)))
      this.place()
      moving = true
    }
    const litTarget = this.want && this.drop >= 1 && !dark ? 1 : 0
    if (this.lit !== litTarget) {
      const was = this.lit
      this.lit = Math.max(0, Math.min(1, this.lit + (litTarget ? dt / LIT_S : -dt / (LIT_S / 2))))
      if (was === 0 && this.lit > 0) this.onLit()
      this.shine()
      moving = true
    }
    return moving
  }

  /** Centro da imagem no mundo (para onde os agentes olham). */
  center(out: { x: number; y: number; z: number }): void {
    out.x = this.root.position.x
    out.y = IMG_Y
    out.z = this.root.position.z + SCREEN_Z
  }

  /** Telas clicáveis (só com a tela toda embaixo). */
  pickTargets(out: Object3D[]): void {
    if (this.drop < 0.98) return
    out.push(this.cloth)
    if (this.image.visible) out.push(this.image)
  }

  /** O telão grande (overlay) recebe cada desenho também; null desliga. */
  setMirror(canvas: HTMLCanvasElement | null): void {
    try {
      this.mirrorCtx = canvas ? canvas.getContext('2d') : null
    } catch {
      this.mirrorCtx = null
    }
  }

  get mirroring(): boolean {
    return this.mirrorCtx !== null
  }

  /** Desenha a imagem; `texture` false = só o telão grande (a sala não está à vista). */
  paint(view: ProjectorView, texture = true): void {
    if (texture && this.ctx) {
      paintProjector(this.ctx, PROJ_W, PROJ_H, view)
      this.texture.needsUpdate = true
    }
    const m = this.mirrorCtx
    if (m) paintProjector(m, m.canvas.width, m.canvas.height, view)
  }

  dispose(): void {
    this.root.removeFromParent()
    this.texture.dispose()
    this.imageMat.dispose()
    this.beamMat.dispose()
    ;(this.glow.material as Material).dispose()
    this.mirrorCtx = null
  }
}
