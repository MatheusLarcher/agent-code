/**
 * A bandeja da fila na cena (three): uma mesinha alta encostada na parede do
 * fundo, à esquerda do kanban (officePlan.QUEUE_TRAY), com uma bandeja rasa e
 * as folhas empilhadas — uma por prompt na fila, até TRAY_SHOWN; passou
 * disso, a etiqueta "+K". Fila parada: clipe vermelho na folha de cima. Uma
 * caixa invisível por cima é o alvo do mouse (TRAY_KEY: a dica com o motivo).
 *
 * As malhas nascem uma vez; `set` só liga, desliga e move (nada aloca por quadro).
 */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Sprite, SpriteMaterial, SRGBColorSpace, type Material, type Vector3 } from 'three'
import type { Kit } from '../kit'
import { QUEUE_TRAY } from '../officePlan'
import { TRAY_KEY, TRAY_SHOWN, type TrayLook } from './queueTray'

/** Uma folha (A4 na escala dos bonecos) e o passo entre as folhas da pilha. */
const SHEET = { w: 0.21, t: 0.004, d: 0.28 }
const SHEET_STEP = 0.006
/** Fundo da bandeja (y do topo do fundo, a partir do chão). */
const TRAY_FLOOR = QUEUE_TRAY.h + 0.012
/** Cada folha um pouco torta, de um jeito fixo (pilha feita à mão). */
const JITTER: ReadonlyArray<readonly [number, number, number]> = [
  [0.006, -0.004, 0.03],
  [-0.008, 0.005, -0.045],
  [0.004, 0.006, 0.02],
  [-0.003, -0.006, -0.025]
]

export class TrayView {
  readonly root = new Group()
  /** O alvo do mouse (invisível). */
  readonly pick: Mesh
  private readonly sheets: Mesh[] = []
  private readonly clip: Mesh
  private readonly label: Sprite
  private readonly canvas: HTMLCanvasElement
  private readonly texture: CanvasTexture
  private readonly own: Material[] = []
  private drawn = { sheets: -1, more: -1, stopped: false }

  constructor(kit: Kit, parent: Group) {
    const T = QUEUE_TRAY
    this.root.position.set(T.x, 0, T.z)
    parent.add(this.root)
    const box = (mat: Material, w: number, h: number, d: number, x: number, y: number, z: number): Mesh => {
      const m = new Mesh(kit.geo.box, mat)
      m.scale.set(w, h, d)
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      this.root.add(m)
      return m
    }
    // A mesinha: tampo, coluna e base.
    box(kit.mat.deskTop, T.w, 0.04, T.d, 0, T.h - 0.02, 0)
    box(kit.mat.deskLeg, 0.06, T.h - 0.07, 0.06, 0, (T.h - 0.04) / 2, 0)
    box(kit.mat.deskLeg, T.w * 0.7, 0.03, T.d * 0.75, 0, 0.015, 0)
    // A bandeja rasa: o fundo e as quatro bordas.
    const bw = SHEET.w + 0.07
    const bd = SHEET.d + 0.06
    box(kit.mat.charcoal, bw, 0.012, bd, 0, T.h + 0.006, 0)
    for (const s of [-1, 1]) {
      box(kit.mat.charcoal, bw, 0.03, 0.012, 0, T.h + 0.015, (s * bd) / 2)
      box(kit.mat.charcoal, 0.012, 0.03, bd, (s * bw) / 2, T.h + 0.015, 0)
    }
    for (let i = 0; i < TRAY_SHOWN; i++) {
      const [dx, dz, rot] = JITTER[i]
      const s = box(kit.mat.paper, SHEET.w, SHEET.t, SHEET.d, dx, TRAY_FLOOR + SHEET.t / 2 + i * SHEET_STEP, dz)
      s.rotation.y = rot
      s.castShadow = false
      this.sheets.push(s)
    }
    // O clipe vermelho (fila parada), preso à borda de trás da folha de cima.
    const red = new MeshLambertMaterial({ color: 0xd8342c })
    this.own.push(red)
    this.clip = box(red, 0.04, 0.014, 0.05, 0, 0, -SHEET.d / 2 + 0.02)
    // "+K": etiqueta na frente da bandeja (sprite: sempre de frente para a câmera).
    this.canvas = document.createElement('canvas')
    this.canvas.width = 128
    this.canvas.height = 64
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    const labelMat = new SpriteMaterial({ map: this.texture, transparent: true })
    this.own.push(labelMat)
    this.label = new Sprite(labelMat)
    this.label.scale.set(0.17, 0.085, 1)
    this.label.position.set(bw / 2 + 0.02, T.h + 0.09, bd / 2)
    this.root.add(this.label)
    const pickMat = new MeshBasicMaterial({ visible: false })
    this.own.push(pickMat)
    this.pick = new Mesh(kit.geo.box, pickMat)
    this.pick.scale.set(T.w + 0.06, 0.32, T.d + 0.06)
    this.pick.position.set(0, T.h + 0.12, 0)
    this.pick.userData.charKey = TRAY_KEY
    this.root.add(this.pick)
    this.set({ sheets: 0, more: 0, stopped: false, tip: '' })
  }

  /** A bandeja passa a mostrar `look` (folhas, "+K" e o clipe). */
  set(look: TrayLook): void {
    const d = this.drawn
    if (d.sheets === look.sheets && d.more === look.more && d.stopped === look.stopped) return
    this.drawn = { sheets: look.sheets, more: look.more, stopped: look.stopped }
    this.sheets.forEach((s, i) => (s.visible = i < look.sheets))
    this.clip.visible = look.stopped && look.sheets > 0
    this.clip.position.y = TRAY_FLOOR + (look.sheets - 1) * SHEET_STEP + SHEET.t + 0.007
    this.label.visible = look.more > 0
    if (look.more > 0) this.drawLabel(`+${look.more}`)
  }

  /** Quantas folhas estão à vista (testes). */
  get visibleSheets(): number {
    return this.sheets.filter((s) => s.visible).length
  }

  get clipped(): boolean {
    return this.clip.visible
  }

  private drawLabel(text: string): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, 128, 64)
    ctx.fillStyle = 'rgba(32, 30, 28, 0.85)'
    ctx.beginPath()
    ctx.roundRect(8, 8, 112, 48, 14)
    ctx.fill()
    ctx.fillStyle = '#fff6e6'
    ctx.font = 'bold 34px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 64, 33)
    this.texture.needsUpdate = true
  }

  /** O ponto acima da bandeja (no mundo), onde a dica aparece. */
  anchor(out: Vector3): Vector3 {
    return this.root.localToWorld(out.set(0, QUEUE_TRAY.h + 0.3, 0))
  }

  dispose(): void {
    this.root.removeFromParent()
    for (const m of this.own) m.dispose()
    this.texture.dispose()
  }
}
