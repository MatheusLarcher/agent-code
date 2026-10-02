/**
 * A tela HTML do foco (o cartão da ferramenta) alinhada aos cantos do monitor
 * projetados no palco. Roda a cada quadro com o foco aberto: não aloca (vetor
 * de rascunho, monitor guardado no foco) e só escreve no estilo quando o
 * retângulo, em px inteiros, muda. Sem monitor (personagem sem mesa), um
 * cartão centrado.
 */
import { Vector3, type Camera } from 'three'
import { MONITOR_HALF_H, MONITOR_HALF_W, MONITOR_SCREEN_FRONT } from './cameraRig'

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
