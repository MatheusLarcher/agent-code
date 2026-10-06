/**
 * A tela HTML do foco (o turno do agente no formato do chat) encaixada na tela
 * do monitor desenhado, em repouso e no voo da câmera: os 4 cantos da tela (o
 * plano SCREEN_W × SCREEN_H da cena, em MONITOR_SCREEN_FRONT) são projetados
 * com a câmera viva. O tamanho de layout é o da tela projetada na pose FINAL do
 * foco (o `monitorPose` do motor, mesmo fov e aspect), calculado uma vez por
 * foco ou redimensionamento: o conteúdo não refaz o layout, só a posição muda.
 *
 *   modo plano  os cantos formam um retângulo alinhado aos eixos e do tamanho de
 *               layout (isAxisRect, ±0,5 px): a câmera parada de frente para a
 *               tela. Sem transform — left/top em px de dispositivo inteiros —,
 *               o texto é rasterizado 1:1, nítido como na aba Conversa;
 *   matrix3d    qualquer outra pose (o voo, a tela inclinada): uma homografia
 *               (quadTransform.ts) leva o retângulo do elemento aos cantos, com
 *               a perspectiva (left/top ficam no 0 do CSS). O Chromium reamostra
 *               a camada 3D, mas em movimento ninguém lê.
 *
 * Roda a cada quadro com o foco aberto (vetor e cantos de rascunho) e só
 * escreve no estilo o que mudou — com a câmera parada, nada aloca; canto atrás
 * da câmera ou fora do near/far esconde. Sem monitor (personagem sem mesa), um
 * cartão centrado, sem transform. A mesma âncora serve à TV (`aim(tv, TV_PLANE)`:
 * a pose do foco é `tvPose`) e ao console da Central. No voo da câmera (`flying`)
 * a tela não recebe clique nem arrasto (pointer-events: none).
 *
 * `PointAnchor` é o da prévia do hover: um cartão de tamanho próprio que fica
 * acima de um ponto do mundo (o alto do monitor do agente), centrado e sem sair
 * do palco — só o `transform` muda, e só quando o px muda.
 */
import { Vector3, type Camera, type PerspectiveCamera } from 'three'
import { MONITOR_HALF_H, MONITOR_PLANE, projectPoint, screenPoint, screenPose, type MonitorAt, type ScreenPlane, type ViewSize } from './cameraRig'
import { monitorPosition, MONITOR_Y } from './layout'
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
  room(id: string): { desks: ReadonlyArray<{ x: number; z: number; yaw?: number }> } | undefined
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
    if (desk) {
      const m = monitorPosition(desk)
      this.at.set(m.x, MONITOR_TOP, m.z)
    }
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

/** Folga (px) de cada canto até o retângulo do modo plano. */
const FLAT_TOL = 0.5

const gap = (p: Pt, x: number, y: number): number => Math.hypot(p.x - x, p.y - y)

/**
 * Os cantos projetados (TL, TR, BR, BL) são um retângulo alinhado aos eixos E do
 * tamanho de layout w × h: cada um a no máximo `tol` px do canto do retângulo
 * w × h centrado neles. Conferir o tamanho é o que barra o dolly reto (também é
 * um retângulo, mas de outra escala — a tela daria um pulo). NaN: false.
 */
export function isAxisRect(q: readonly [Pt, Pt, Pt, Pt], w: number, h: number, tol = FLAT_TOL): boolean {
  const left = (q[0].x + q[1].x + q[2].x + q[3].x) / 4 - w / 2
  const top = (q[0].y + q[1].y + q[2].y + q[3].y) / 4 - h / 2
  return gap(q[0], left, top) <= tol && gap(q[1], left + w, top) <= tol && gap(q[2], left + w, top + h) <= tol && gap(q[3], left, top + h) <= tol
}

/** A escala da tela (Windows a 125% = 1,25): o modo plano cai em px de dispositivo inteiros. */
function deviceRatio(): number {
  const r = (globalThis as { devicePixelRatio?: number }).devicePixelRatio
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 1
}

export class ScreenAnchor {
  private el: HTMLElement | null = null
  private readonly v = new Vector3()
  /** Cantos da tela no palco (px) do último encaixe; NaN = refazer no próximo quadro. */
  private readonly quad: [Pt, Pt, Pt, Pt] = [
    { x: NaN, y: NaN },
    { x: NaN, y: NaN },
    { x: NaN, y: NaN },
    { x: NaN, y: NaN }
  ]
  /** Tamanho de layout (px) e de onde ele saiu: o monitor, o palco e o fov. */
  private readonly size = { w: 0, h: 0, x: NaN, y: NaN, z: NaN, yaw: 0, width: NaN, height: NaN, fov: NaN }
  /** O que está no estilo: NaN = nada escrito; left/top null = limpos (fica o 0 do CSS). */
  private readonly last: { left: number | null; top: number | null; width: number; height: number } = { left: NaN, top: NaN, width: NaN, height: NaN }
  private transform: string | null = null
  private hidden = false
  private flying = false
  /** A escala da tela no último quadro (devicePixelRatio). */
  private dpr = NaN
  /** A tela em foco: o monitor (padrão) ou a TV. */
  private plane: ScreenPlane = MONITOR_PLANE
  /** Centro do monitor em foco (mundo); vale com `hasMonitor`. */
  readonly monitor: { x: number; y: number; z: number; yaw: number } = { x: 0, y: 0, z: 0, yaw: 0 }
  hasMonitor = false

  setElement(el: HTMLElement | null): void {
    this.el = el
    this.last.left = this.last.top = this.last.width = this.last.height = NaN
    this.transform = null
    this.hidden = false
    this.flying = false
    this.quad[0].x = NaN
  }

  /** Monitor do foco (null = sem mesa: cartão centrado); `plane` = a tela (TV_PLANE na TV). */
  aim(m: MonitorAt | null, plane: ScreenPlane = MONITOR_PLANE): void {
    this.hasMonitor = m !== null
    if (plane !== this.plane) {
      this.plane = plane
      this.size.fov = NaN // outra tela: o tamanho de layout é refeito
    }
    if (!m) return
    this.monitor.x = m.x
    this.monitor.y = m.y
    this.monitor.z = m.z
    this.monitor.yaw = m.yaw ?? 0
  }

  place(camera: PerspectiveCamera, width: number, height: number, flying = false): void {
    if (!this.el) return
    if (flying !== this.flying) {
      this.flying = flying
      this.el.style.pointerEvents = flying ? 'none' : ''
    }
    const dpr = deviceRatio()
    if (dpr !== this.dpr) {
      this.dpr = dpr
      this.quad[0].x = NaN // a janela foi para uma tela de outra escala: o encaixe é refeito
    }
    if (!this.hasMonitor) return this.card(width, height)
    const size = this.layoutSize(camera.fov, width, height)
    const m = this.monitor
    const pl = this.plane
    const q = this.quad
    let moved = false
    for (let i = 0; i < 4; i++) {
      const c = CORNERS[i]
      // O canto girado com a tela (a mesa inclinada do U): de frente, a esquerda dela é a esquerda de quem olha.
      const w = screenPoint(m, pl, c[0], c[1])
      const a = this.v.set(w.x, w.y, w.z).project(camera)
      if (a.z < -1 || a.z > 1) return this.hide()
      const x = ((a.x + 1) / 2) * width
      const y = ((1 - a.y) / 2) * height
      if (x === q[i].x && y === q[i].y) continue
      q[i].x = x
      q[i].y = y
      moved = true
    }
    if (!moved) return
    if (isAxisRect(q, size.w, size.h)) return this.flat(q, size)
    const t = quadMatrix3d(size.w, size.h, q)
    if (!t) return this.hide()
    this.setHidden(false)
    this.box(null, null, size.w, size.h)
    this.setTransform(t)
  }

  /** Modo plano: sem transform, a tela do tamanho de layout centrada nos cantos (o box a põe em px de dispositivo). */
  private flat(q: readonly [Pt, Pt, Pt, Pt], size: { w: number; h: number }): void {
    this.setHidden(false)
    this.setTransform('')
    this.box((q[0].x + q[1].x + q[2].x + q[3].x) / 4 - size.w / 2, (q[0].y + q[1].y + q[2].y + q[3].y) / 4 - size.h / 2, size.w, size.h)
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
    if (s.fov === fov && s.width === width && s.height === height && s.x === m.x && s.y === m.y && s.z === m.z && s.yaw === m.yaw) return s
    const view = focusView(fov, width, height)
    const pl = this.plane
    const pose = screenPose(m, pl, view)
    const p = CORNERS.map(([sx, sy]) => {
      const n = projectPoint(pose, view, screenPoint(m, pl, sx, sy))
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
    s.yaw = m.yaw
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

  /**
   * left/top em px de dispositivo inteiros (múltiplos de 1/dpr) e width/height em
   * px inteiros; só escreve o que muda. left/top null = limpos (fica o 0 do CSS).
   */
  private box(left: number | null, top: number | null, width: number, height: number): void {
    const s = this.el!.style
    const l = this.last
    const d = this.dpr
    const L = left === null ? null : Math.round(left * d) / d
    const T = top === null ? null : Math.round(top * d) / d
    const W = Math.round(width)
    const H = Math.round(height)
    if (L !== l.left) {
      l.left = L
      s.left = L === null ? '' : `${L}px`
    }
    if (T !== l.top) {
      l.top = T
      s.top = T === null ? '' : `${T}px`
    }
    if (W !== l.width) {
      l.width = W
      s.width = `${W}px`
    }
    if (H !== l.height) {
      l.height = H
      s.height = `${H}px`
    }
  }
}
