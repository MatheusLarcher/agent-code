/**
 * A tela HTML do foco (o turno do agente no formato do chat) encaixada na tela
 * do monitor desenhado, em repouso e no voo da câmera: os 4 cantos da tela (o
 * plano SCREEN_W × SCREEN_H da cena, em MONITOR_SCREEN_FRONT) são projetados
 * com a câmera viva e uma homografia (`matrix3d`, quadTransform.ts) leva o
 * retângulo do elemento até eles, com o keystone da arfagem. O tamanho de
 * layout é o da tela projetada na pose FINAL do foco (o `monitorPose` do motor,
 * mesmo fov e aspect), calculado uma vez por foco ou redimensionamento: no voo
 * o conteúdo não refaz o layout, só o transform muda (left/top ficam no 0 do
 * CSS). Roda a cada quadro com o foco aberto (vetor e cantos de rascunho) e só
 * escreve no estilo o que mudou — com a câmera parada, nada aloca; canto atrás
 * da câmera ou fora do near/far esconde. Sem monitor (personagem sem mesa), um
 * cartão centrado, sem transform.
 *
 * `PointAnchor` é o da prévia do hover: um cartão de tamanho próprio que fica
 * acima de um ponto do mundo (o alto do monitor do agente), centrado e sem sair
 * do palco — só o `transform` muda, e só quando o px muda.
 */
import { Vector3, type Camera, type PerspectiveCamera } from 'three'
import { MONITOR_HALF_H, MONITOR_HALF_W, MONITOR_SCREEN_FRONT, monitorPose, projectPoint, type MonitorAt, type ViewSize } from './cameraRig'
import { MONITOR_BACK, MONITOR_Y } from './layout'
import { quadMatrix3d, type Pt } from './quadTransform'
import { BUBBLE_TOP } from './speech'

/**
 * A vista do foco no monitor: o palco (fov, aspect, altura) e a faixa do HUD que
 * a tela não cobre. O motor (a pose do voo) e a âncora (o tamanho de layout)
 * usam a mesma — a tela HTML nasce do tamanho da tela projetada naquela pose.
 */
export function focusView(fovDeg: number, width: number, height: number): ViewSize {
  return { fovDeg, aspect: width / height, heightPx: height, clearTopPx: BUBBLE_TOP }
}

/** Folga do cartão até a ponta e até as bordas do palco (px). */
const POINT_GAP = 10
const EDGE = 8

export class PointAnchor {
  private el: HTMLElement | null = null
  private readonly v = new Vector3()
  private lastX = NaN
  private lastY = NaN
  private hidden = false

  setElement(el: HTMLElement | null): void {
    this.el = el
    this.lastX = this.lastY = NaN
    this.hidden = false
  }

  get element(): HTMLElement | null {
    return this.el
  }

  /** Põe o cartão acima de `p` (mundo); sem lugar acima, abaixo. Atrás da câmera, some. */
  place(p: { x: number; y: number; z: number }, camera: Camera, width: number, height: number): void {
    const el = this.el
    if (!el) return
    const a = this.v.set(p.x, p.y, p.z).project(camera)
    const off = a.z > 1 || a.z < -1 || a.x < -1.2 || a.x > 1.2 || a.y < -1.2 || a.y > 1.2
    if (off !== this.hidden) {
      this.hidden = off
      el.style.visibility = off ? 'hidden' : ''
    }
    if (off) return
    const x = ((a.x + 1) / 2) * width
    const y = ((1 - a.y) / 2) * height
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = y - h - POINT_GAP
    if (top < BUBBLE_TOP) top = y + POINT_GAP
    const left = Math.round(Math.max(EDGE, Math.min(width - w - EDGE, x - w / 2)))
    const T = Math.round(Math.max(BUBBLE_TOP, Math.min(height - h - EDGE, top)))
    if (left === this.lastX && T === this.lastY) return
    this.lastX = left
    this.lastY = T
    el.style.transform = `translate3d(${left}px, ${T}px, 0)`
  }
}

/** O que a prévia precisa da cena: a mesa de cada agente e a cabeça dele. */
export interface PreviewScene {
  character(key: string): { screenDesk: { roomId: string; index: number } | null } | undefined
  room(id: string): { desks: ReadonlyArray<{ x: number; z: number; dir?: 1 | -1 }> } | undefined
  headWorldPosition(key: string, out: Vector3): boolean
}

/** Alto do monitor (onde a ponta da prévia encosta). */
const MONITOR_TOP = MONITOR_Y + MONITOR_HALF_H + 0.05

/** A prévia do hover: o cartão (data-key = o agente) acima do monitor dele ou, sem mesa, acima da cabeça. */
export class PreviewAnchor {
  private readonly anchor = new PointAnchor()
  private key: string | null = null
  private readonly at = new Vector3()

  setElement(el: HTMLElement | null): void {
    this.anchor.setElement(el)
    this.key = el?.dataset.key ?? null
  }

  place(scene: PreviewScene, camera: Camera, width: number, height: number): void {
    const key = this.key
    if (!key) return
    const c = scene.character(key)
    const desk = c?.screenDesk ? scene.room(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
    if (desk) this.at.set(desk.x, MONITOR_TOP, desk.z - (desk.dir ?? 1) * MONITOR_BACK)
    else if (scene.headWorldPosition(key, this.at)) this.at.y += 0.35
    else return
    this.anchor.place(this.at, camera, width, height)
  }
}

/** Cantos da tela na ordem do quadMatrix3d (TL, TR, BR, BL): o sinal de x e de y a partir do centro. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1]
]

export class ScreenAnchor {
  private el: HTMLElement | null = null
  private readonly v = new Vector3()
  /** Cantos da tela no palco (px) do último transform; NaN = refazer no próximo quadro. */
  private readonly quad: [Pt, Pt, Pt, Pt] = [
    { x: NaN, y: NaN },
    { x: NaN, y: NaN },
    { x: NaN, y: NaN },
    { x: NaN, y: NaN }
  ]
  /** Tamanho de layout (px) e de onde ele saiu: o monitor, o palco e o fov. */
  private readonly size = { w: 0, h: 0, x: NaN, y: NaN, z: NaN, dir: 1, width: NaN, height: NaN, fov: NaN }
  /** O que está no estilo: NaN = nada escrito; left/top null = limpos (fica o 0 do CSS). */
  private readonly last: { left: number | null; top: number | null; width: number; height: number } = { left: NaN, top: NaN, width: NaN, height: NaN }
  private transform: string | null = null
  private hidden = false
  /** Centro do monitor em foco (mundo); vale com `hasMonitor`. */
  readonly monitor: { x: number; y: number; z: number; dir: 1 | -1 } = { x: 0, y: 0, z: 0, dir: 1 }
  hasMonitor = false

  setElement(el: HTMLElement | null): void {
    this.el = el
    this.last.left = this.last.top = this.last.width = this.last.height = NaN
    this.transform = null
    this.hidden = false
    this.quad[0].x = NaN
  }

  /** Monitor do foco (null = sem mesa: cartão centrado). */
  aim(m: MonitorAt | null): void {
    this.hasMonitor = m !== null
    if (!m) return
    this.monitor.x = m.x
    this.monitor.y = m.y
    this.monitor.z = m.z
    this.monitor.dir = m.dir ?? 1
  }

  place(camera: PerspectiveCamera, width: number, height: number): void {
    if (!this.el) return
    if (!this.hasMonitor) return this.card(width, height)
    const size = this.layoutSize(camera.fov, width, height)
    const m = this.monitor
    const z = m.z + m.dir * MONITOR_SCREEN_FRONT
    const q = this.quad
    let moved = false
    for (let i = 0; i < 4; i++) {
      const c = CORNERS[i]
      // Tela olhando para −Z (mesa de fundo): vista de frente, a esquerda dela fica em +X.
      const a = this.v.set(m.x + c[0] * m.dir * MONITOR_HALF_W, m.y + c[1] * MONITOR_HALF_H, z).project(camera)
      if (a.z < -1 || a.z > 1) return this.hide()
      const x = ((a.x + 1) / 2) * width
      const y = ((1 - a.y) / 2) * height
      if (x === q[i].x && y === q[i].y) continue
      q[i].x = x
      q[i].y = y
      moved = true
    }
    if (!moved) return
    const t = quadMatrix3d(size.w, size.h, q)
    if (!t) return this.hide()
    this.setHidden(false)
    this.box(null, null, size.w, size.h)
    this.setTransform(t)
  }

  /** Sem monitor: o cartão centrado, sem transform. */
  private card(width: number, height: number): void {
    const w = Math.min(420, width * 0.7)
    const h = Math.min(260, height * 0.5)
    this.quad[0].x = NaN // de volta ao monitor, o transform é refeito
    this.setHidden(false)
    this.setTransform('')
    this.box((width - w) / 2, (height - h) / 2, w, h)
  }

  /**
   * Tamanho de layout (px): a tela projetada na pose final do foco — a média
   * das bordas opostas do trapézio. Só recalcula quando o monitor, o palco ou o
   * fov mudam.
   */
  private layoutSize(fov: number, width: number, height: number): { w: number; h: number } {
    const s = this.size
    const m = this.monitor
    if (s.fov === fov && s.width === width && s.height === height && s.x === m.x && s.y === m.y && s.z === m.z && s.dir === m.dir) return s
    const view = focusView(fov, width, height)
    const pose = monitorPose(m, view)
    const z = m.z + m.dir * MONITOR_SCREEN_FRONT
    const p = CORNERS.map(([sx, sy]) => {
      const n = projectPoint(pose, view, { x: m.x + sx * m.dir * MONITOR_HALF_W, y: m.y + sy * MONITOR_HALF_H, z })
      return { x: ((n.x + 1) / 2) * width, y: ((1 - n.y) / 2) * height }
    })
    const len = (i: number, j: number): number => Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y)
    s.w = Math.max(1, Math.round((len(0, 1) + len(3, 2)) / 2))
    s.h = Math.max(1, Math.round((len(0, 3) + len(1, 2)) / 2))
    s.fov = fov
    s.width = width
    s.height = height
    s.x = m.x
    s.y = m.y
    s.z = m.z
    s.dir = m.dir
    this.quad[0].x = NaN // tamanho novo: o transform é refeito
    return s
  }

  /** Canto atrás da câmera (ou fora do near/far) ou quadrilátero degenerado: some até encaixar de novo. */
  private hide(): void {
    this.quad[0].x = NaN // a volta refaz o transform
    this.setHidden(true)
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    this.el!.style.visibility = hidden ? 'hidden' : ''
  }

  private setTransform(t: string): void {
    if (t === this.transform) return
    this.transform = t
    this.el!.style.transform = t
  }

  /** left/top/width/height em px inteiros, só quando mudam; left/top null = limpos (fica o 0 do CSS). */
  private box(left: number | null, top: number | null, width: number, height: number): void {
    const el = this.el!
    const l = this.last
    const L = left === null ? null : Math.round(left)
    const T = top === null ? null : Math.round(top)
    const W = Math.round(width)
    const H = Math.round(height)
    if (L === l.left && T === l.top && W === l.width && H === l.height) return
    l.left = L
    l.top = T
    l.width = W
    l.height = H
    el.style.left = L === null ? '' : `${L}px`
    el.style.top = T === null ? '' : `${T}px`
    el.style.width = `${W}px`
    el.style.height = `${H}px`
  }
}
