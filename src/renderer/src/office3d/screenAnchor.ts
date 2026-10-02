/**
 * A tela HTML do foco (o turno do agente no formato do chat) alinhada aos
 * cantos do monitor projetados no palco. Roda a cada quadro com o foco aberto:
 * não aloca (vetor de rascunho, monitor guardado no foco) e só escreve no
 * estilo quando o retângulo, em px inteiros, muda. Sem monitor (personagem sem
 * mesa), um cartão centrado.
 *
 * `PointAnchor` é o da prévia do hover: um cartão de tamanho próprio que fica
 * acima de um ponto do mundo (o alto do monitor do agente), centrado e sem sair
 * do palco — só o `transform` muda, e só quando o px muda.
 */
import { Vector3, type Camera } from 'three'
import { MONITOR_HALF_H, MONITOR_HALF_W, MONITOR_SCREEN_FRONT } from './cameraRig'
import { MONITOR_BACK, MONITOR_Y } from './layout'
import { BUBBLE_TOP } from './speech'

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
  room(id: string): { desks: ReadonlyArray<{ x: number; z: number }> } | undefined
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
    if (desk) this.at.set(desk.x, MONITOR_TOP, desk.z - MONITOR_BACK)
    else if (scene.headWorldPosition(key, this.at)) this.at.y += 0.35
    else return
    this.anchor.place(this.at, camera, width, height)
  }
}

export class ScreenAnchor {
  private el: HTMLElement | null = null
  private readonly v = new Vector3()
  private readonly last = { left: NaN, top: NaN, width: NaN, height: NaN }
  /** Centro do monitor em foco (mundo); vale com `hasMonitor`. */
  readonly monitor = { x: 0, y: 0, z: 0 }
  hasMonitor = false

  setElement(el: HTMLElement | null): void {
    this.el = el
    this.last.left = this.last.top = this.last.width = this.last.height = NaN
  }

  /** Monitor do foco (null = sem mesa: cartão centrado). */
  aim(m: { x: number; y: number; z: number } | null): void {
    this.hasMonitor = m !== null
    if (!m) return
    this.monitor.x = m.x
    this.monitor.y = m.y
    this.monitor.z = m.z
  }

  place(camera: Camera, width: number, height: number): void {
    if (!this.el) return
    if (!this.hasMonitor) {
      const w = Math.min(420, width * 0.7)
      const h = Math.min(260, height * 0.5)
      return this.write((width - w) / 2, (height - h) / 2, w, h)
    }
    const m = this.monitor
    const z = m.z + MONITOR_SCREEN_FRONT
    const a = this.v.set(m.x - MONITOR_HALF_W, m.y + MONITOR_HALF_H, z).project(camera)
    const ax = ((a.x + 1) / 2) * width
    const ay = ((1 - a.y) / 2) * height
    const b = this.v.set(m.x + MONITOR_HALF_W, m.y - MONITOR_HALF_H, z).project(camera)
    const bx = ((b.x + 1) / 2) * width
    const by = ((1 - b.y) / 2) * height
    this.write(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
  }

  private write(left: number, top: number, width: number, height: number): void {
    const el = this.el!
    const l = this.last
    const L = Math.round(left)
    const T = Math.round(top)
    const W = Math.round(width)
    const H = Math.round(height)
    if (L === l.left && T === l.top && W === l.width && H === l.height) return
    l.left = L
    l.top = T
    l.width = W
    l.height = H
    el.style.left = `${L}px`
    el.style.top = `${T}px`
    el.style.width = `${W}px`
    el.style.height = `${H}px`
  }
}
