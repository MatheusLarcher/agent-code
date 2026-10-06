/**
 * Entrada do escritório 3D, sem DOM real nem three: o motor repassa os eventos
 * e lê daqui o que mover. Teclado ignorado quando o foco está num campo de
 * texto (mesmo critério do Forgia, ui.js:717).
 */

export const MAX_DT = 0.1
export const WALK_SPEED = 6
export const RUN_FACTOR = 3

export interface KeyEventLike {
  key: string
  target: EventTarget | null
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

interface EditableLike {
  tagName?: string
  isContentEditable?: boolean
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target) return false
  const el = target as EditableLike
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

const MOVE_KEYS = new Set(['w', 'a', 's', 'd'])

/** Teclas de movimento seguradas (+ Shift). */
export class MoveKeys {
  private readonly held = new Set<string>()
  shift = false

  /** true quando a tecla é de movimento e foi consumida. */
  down(e: KeyEventLike): boolean {
    if (e.key === 'Shift') {
      this.shift = true
      return false
    }
    if (isTypingTarget(e.target) || e.ctrlKey || e.altKey || e.metaKey) return false
    const k = e.key.toLowerCase()
    if (!MOVE_KEYS.has(k)) return false
    this.held.add(k)
    return true
  }

  up(e: Pick<KeyEventLike, 'key'>): void {
    if (e.key === 'Shift') this.shift = false
    this.held.delete(e.key.toLowerCase())
  }

  /** Blur da janela: nada fica preso. */
  clear(): void {
    this.held.clear()
    this.shift = false
  }

  get moving(): boolean {
    return this.held.size > 0
  }

  has(k: string): boolean {
    return this.held.has(k)
  }
}

export function clampDt(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(seconds, MAX_DT)
}

/**
 * Deslocamento no plano XZ para a câmera com guinada `yaw` (0 = olhando para
 * -Z). W anda para onde a câmera olha; D para a direita. `out` (opcional) é
 * reaproveitado — o motor passa o dele para não alocar a cada quadro.
 */
export function moveDelta(keys: MoveKeys, yaw: number, dt: number, out: { dx: number; dz: number } = { dx: 0, dz: 0 }): { dx: number; dz: number } {
  out.dx = 0
  out.dz = 0
  const f = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0)
  const r = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)
  if (f === 0 && r === 0) return out
  const len = Math.hypot(f, r)
  const step = (WALK_SPEED * (keys.shift ? RUN_FACTOR : 1) * clampDt(dt)) / len
  // Frente = -(sin yaw, cos yaw); direita = (cos yaw, -sin yaw).
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  out.dx = (f * fx + r * rx) * step
  out.dz = (f * fz + r * rz) * step
  return out
}

/** Botões do mouse → gesto. Esquerdo e do meio arrastam para mover a câmera;
 *  direito arrasta para girar; clique curto seleciona. */
export type DragMode = 'orbit' | 'pan' | null

export function dragModeFor(button: number): DragMode {
  if (button === 2) return 'orbit'
  if (button === 0 || button === 1) return 'pan'
  return null
}

/** Clique "curto": pouco movimento entre down e up. */
export const CLICK_SLOP_PX = 4

/** O dedo treme mais que o mouse: o toque curto tolera mais movimento. */
export const TAP_SLOP_PX = 12

export function isClick(dx: number, dy: number, touch = false): boolean {
  return Math.hypot(dx, dy) <= (touch ? TAP_SLOP_PX : CLICK_SLOP_PX)
}
