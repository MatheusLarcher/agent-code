/**
 * A TV da sala de reunião (three) — o que antes era o projetor de cada sala.
 * A tela escura da TV é de decorBack.ts; aqui fica só a IMAGEM por cima dela:
 * a página do navegador/Android em teste (projectorPaint.ts), numa textura
 * própria, centrada (16:9) na tela ~2:1.
 *
 *   setWant(on)     a TV liga (a imagem acende em LIT_S) ou desliga (apaga);
 *   animate(...)    um quadro da zona À VISTA: a imagem acendendo/apagando. Fora
 *                   da tela, `snap` põe tudo no estado final, sem animar o atraso;
 *   paint(...)      desenha a imagem na textura e no telão grande (o overlay).
 *
 * `drop` ficou do projetor (a API de quem usa): 1 com a TV ligada, 0 desligada.
 * Na hora em que a imagem começa a acender, `onLit` avisa a cena (quem está
 * perto olha para a TV). `dispose` libera textura e material.
 */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, type Object3D } from 'three'
import { PROJECTOR_KEY } from './engineTypes'
import type { Kit } from './kit'
import type { Lod } from './lod'
import { IMG_H, IMG_W, type ProjectorKit } from './projectorKit'
import { paintProjector, PROJ_H, PROJ_W, type ProjectorView } from './projectorPaint'
import { canvas2d } from './textures'

export const LIT_S = 0.5

export class RoomProjector {
  readonly root = new Group()
  /** 1 com a TV ligada, 0 desligada (compat do projetor). */
  drop = 0
  /** 0 = apagada … 1 = imagem acesa. */
  lit = 0
  /** A TV deve estar ligada. */
  want = false
  readonly texture: CanvasTexture
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly image: Mesh
  private readonly imageMat: MeshBasicMaterial
  private mirrorCtx: CanvasRenderingContext2D | null = null
  private readonly pickKey: string
  /** A imagem começou a acender (avisa uma vez por acendida). */
  onLit: () => void = () => {}

  constructor(
    kit: Kit,
    _pk: ProjectorKit,
    parent: Object3D,
    readonly roomId: string,
    private readonly tv: { x: number; y: number; z: number }
  ) {
    this.root.name = 'tv-image'
    this.pickKey = `${PROJECTOR_KEY}${roomId}`
    const { canvas, ctx } = canvas2d(PROJ_W, PROJ_H)
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = kit.anisotropy
    this.imageMat = new MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0, toneMapped: false })
    this.image = new Mesh(kit.geo.plane, this.imageMat)
    this.image.scale.set(IMG_W, IMG_H, 1)
    this.image.position.set(tv.x, tv.y, tv.z + 0.004)
    this.image.visible = false
    this.image.userData.charKey = this.pickKey
    this.root.add(this.image)
    parent.add(this.root)
  }

  private shine(): void {
    this.image.visible = this.lit > 0.001
    this.imageMat.opacity = this.lit
  }

  setWant(on: boolean): void {
    this.want = on
  }

  /** Fora da tela: tudo direto no estado final (sem animar o atraso). */
  snap(dark: boolean): void {
    this.drop = this.want ? 1 : 0
    this.lit = this.want && !dark ? 1 : 0
    this.shine()
  }

  /** Nível da zona: a imagem vale em qualquer distância (no LONGE não é redesenhada). */
  setLevel(_level: Lod): void {}

  /** Um quadro da zona à vista; `dark` = sem energia (TV desligada). true enquanto anima. */
  animate(dt: number, dark: boolean): boolean {
    this.drop = this.want ? 1 : 0
    const target = this.want && !dark ? 1 : 0
    if (this.lit === target) return false
    const was = this.lit
    this.lit = Math.max(0, Math.min(1, this.lit + (target ? dt / LIT_S : -dt / (LIT_S / 2))))
    if (was === 0 && this.lit > 0) this.onLit()
    this.shine()
    return true
  }

  /** Centro da imagem no mundo (para onde os agentes olham). */
  center(out: { x: number; y: number; z: number }): void {
    out.x = this.tv.x
    out.y = this.tv.y
    out.z = this.tv.z
  }

  /** A imagem clicável (só acesa). */
  pickTargets(out: Object3D[]): void {
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

  /** Desenha a imagem; `texture` false = só o telão grande (a zona não está à vista). */
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
    this.mirrorCtx = null
  }
}
