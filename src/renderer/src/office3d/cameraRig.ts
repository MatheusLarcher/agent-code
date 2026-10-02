/**
 * Câmera orbital em números puros: alvo + guinada/arfagem/distância. O motor
 * copia a pose para a PerspectiveCamera do three. Inclui o tween (~400 ms,
 * easeInOut) usado para voar até um monitor e voltar.
 *
 * yaw = 0: a câmera fica em +Z do alvo, olhando para -Z.
 */

export interface CameraPose {
  tx: number
  ty: number
  tz: number
  yaw: number
  pitch: number
  distance: number
}

export const TWEEN_MS = 400
export const MIN_PITCH = 0.05
export const MAX_PITCH = 1.45
export const MIN_DISTANCE = 0.6
export const MAX_DISTANCE = 60
const ORBIT_RAD_PER_PX = 0.005

export function easeInOut(k: number): number {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
}

/** Diferença angular pelo caminho mais curto, em (-π, π]. */
export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** Pose entre `a` e `b`; com `out`, escreve nele (o voo da câmera não aloca por quadro). */
export function lerpPose(a: CameraPose, b: CameraPose, k: number, out: CameraPose = { ...a }): CameraPose {
  const yaw = a.yaw + shortestAngle(a.yaw, b.yaw) * k
  out.tx = a.tx + (b.tx - a.tx) * k
  out.ty = a.ty + (b.ty - a.ty) * k
  out.tz = a.tz + (b.tz - a.tz) * k
  out.pitch = a.pitch + (b.pitch - a.pitch) * k
  out.distance = a.distance + (b.distance - a.distance) * k
  out.yaw = yaw
  return out
}

/** Posição da câmera para a pose; com `out`, escreve nele (sem alocar). */
export function cameraPosition(p: CameraPose, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
  const c = Math.cos(p.pitch)
  out.x = p.tx + p.distance * c * Math.sin(p.yaw)
  out.y = p.ty + p.distance * Math.sin(p.pitch)
  out.z = p.tz + p.distance * c * Math.cos(p.yaw)
  return out
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface Tween {
  from: CameraPose
  to: CameraPose
  start: number
}

export class CameraRig {
  pose: CameraPose
  private tween: Tween | null = null

  constructor(pose: CameraPose) {
    this.pose = { ...pose }
  }

  get tweening(): boolean {
    return this.tween !== null
  }

  orbit(dxPx: number, dyPx: number): void {
    this.tween = null
    this.pose.yaw -= dxPx * ORBIT_RAD_PER_PX
    this.pose.pitch = clamp(this.pose.pitch + dyPx * ORBIT_RAD_PER_PX, MIN_PITCH, MAX_PITCH)
  }

  /** Arrasta o alvo no plano da tela, proporcional à distância. */
  pan(dxPx: number, dyPx: number): void {
    this.tween = null
    const s = this.pose.distance * 0.0015
    const rx = Math.cos(this.pose.yaw)
    const rz = -Math.sin(this.pose.yaw)
    // "Para cima" na tela ≈ para frente no chão (vista de cima).
    const fx = -Math.sin(this.pose.yaw)
    const fz = -Math.cos(this.pose.yaw)
    this.pose.tx += -dxPx * s * rx + dyPx * s * fx
    this.pose.tz += -dxPx * s * rz + dyPx * s * fz
  }

  /** Roda: deltaY > 0 afasta. Se o enquadramento inicial já passou do limite, só aproxima. */
  zoom(deltaY: number): void {
    this.tween = null
    const hi = Math.max(MAX_DISTANCE, this.pose.distance)
    this.pose.distance = clamp(this.pose.distance * Math.exp(deltaY * 0.001), MIN_DISTANCE, hi)
  }

  move(dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return
    this.tween = null
    this.pose.tx += dx
    this.pose.tz += dz
  }

  flyTo(to: CameraPose, now: number): void {
    this.tween = { from: { ...this.pose }, to: { ...to }, start: now }
  }

  /** Troca o destino sem reiniciar o voo; parado, vai direto para a pose. */
  retarget(to: CameraPose): void {
    if (this.tween) this.tween.to = { ...to }
    else this.pose = { ...to }
  }

  /** Avança o tween; devolve true enquanto ainda anima. Escreve na pose atual: nada aloca por quadro. */
  step(now: number): boolean {
    const t = this.tween
    if (!t) return false
    const k = clamp((now - t.start) / TWEEN_MS, 0, 1)
    if (k >= 1) {
      Object.assign(this.pose, t.to)
      this.tween = null
      return false
    }
    lerpPose(t.from, t.to, easeInOut(k), this.pose)
    return true
  }
}

/** FOV vertical (graus) e aspect (largura/altura) do palco. */
export interface ViewSize {
  fovDeg: number
  aspect: number
}

/** Meia largura/altura da tela do monitor (mesmas medidas da cena). */
export const MONITOR_HALF_W = 0.44
export const MONITOR_HALF_H = 0.25
/** A face da tela fica um pouco à frente do centro do monitor. */
export const MONITOR_SCREEN_FRONT = 0.03
export const MONITOR_FILL = 0.85
const MONITOR_PITCH = 0.06
/** Limite do enquadramento do prédio (o plano distante da câmera é 250). */
export const MAX_FRAME_DISTANCE = 200

const tanHalf = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360)
const safeAspect = (a: number): number => (Number.isFinite(a) && a > 0 ? a : 1)

/**
 * Pose que enquadra um monitor (tela olhando para +Z) de frente, na distância
 * em que a tela ocupa `fill` da largura OU da altura do palco — o que limitar
 * primeiro.
 */
export function monitorPose(m: { x: number; y: number; z: number }, view: ViewSize, fill = MONITOR_FILL): CameraPose {
  const t = tanHalf(view.fovDeg)
  const byWidth = MONITOR_HALF_W / (fill * t * safeAspect(view.aspect))
  const byHeight = MONITOR_HALF_H / (fill * t)
  return { tx: m.x, ty: m.y, tz: m.z + MONITOR_SCREEN_FRONT, yaw: 0, pitch: MONITOR_PITCH, distance: Math.max(byWidth, byHeight) }
}

export interface FrameBox {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** Altura até onde o conteúdo vai (o chão é y = 0). */
  height: number
}

/** Coordenadas normalizadas (-1..1) de um ponto visto pela pose; depth <= 0 = atrás da câmera. */
export function projectPoint(pose: CameraPose, view: ViewSize, p: { x: number; y: number; z: number }): { x: number; y: number; depth: number } {
  const c = cameraPosition(pose)
  let fx = pose.tx - c.x
  let fy = pose.ty - c.y
  let fz = pose.tz - c.z
  const fl = Math.hypot(fx, fy, fz) || 1
  fx /= fl
  fy /= fl
  fz /= fl
  // right = forward × up(0,1,0); up' = right × forward
  const rl = Math.hypot(fz, fx) || 1
  const rx = -fz / rl
  const rz = fx / rl
  const ux = -rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy
  const vx = p.x - c.x
  const vy = p.y - c.y
  const vz = p.z - c.z
  const depth = vx * fx + vy * fy + vz * fz
  const t = tanHalf(view.fovDeg)
  return {
    x: (vx * rx + vz * rz) / (depth * t * safeAspect(view.aspect)),
    y: (vx * ux + vy * uy + vz * uz) / (depth * t),
    depth
  }
}

/**
 * Pose que enquadra a caixa inteira (todas as salas) com a arfagem dada: mira
 * no centro da caixa e busca a menor distância em que os 8 cantos cabem em
 * `fill` do palco, na largura e na altura.
 */
export function framePose(box: FrameBox, view: ViewSize, pitch = 0.85, fill = 0.9): CameraPose {
  const base = { tx: (box.minX + box.maxX) / 2, ty: 0, tz: (box.minZ + box.maxZ) / 2, yaw: 0, pitch }
  const corners: Array<{ x: number; y: number; z: number }> = []
  for (const x of [box.minX, box.maxX]) for (const y of [0, box.height]) for (const z of [box.minZ, box.maxZ]) corners.push({ x, y, z })
  const fits = (distance: number): boolean =>
    corners.every((p) => {
      const q = projectPoint({ ...base, distance }, view, p)
      return q.depth > 0.05 && Math.abs(q.x) <= fill && Math.abs(q.y) <= fill
    })
  let lo = MIN_DISTANCE
  let hi = MAX_FRAME_DISTANCE
  if (fits(lo)) return { ...base, distance: lo }
  if (!fits(hi)) return { ...base, distance: hi }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  return { ...base, distance: hi }
}
