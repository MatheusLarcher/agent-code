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
  /** Altura do palco (px): com `clearTopPx`, o enquadramento do monitor deixa a faixa de cima livre. */
  heightPx?: number
  /** Faixa do topo do palco (px) que a tela do monitor não cobre (o HUD). */
  clearTopPx?: number
}

/** Meia largura/altura da tela do monitor (metade de SCREEN_W/SCREEN_H do kit.ts, a mesma tela da cena). */
export const MONITOR_HALF_W = 0.44
export const MONITOR_HALF_H = 0.25
/** O plano da tela fica um pouco à frente do centro do monitor (decor.ts põe a tela aqui, na frente da moldura). */
export const MONITOR_SCREEN_FRONT = 0.026
/** A tela do monitor ocupa isto do palco (0,85 até out/2026: a tela ficou ~10% maior). */
export const MONITOR_FILL = 0.94
/** Folga mínima (px) entre a tela do monitor e a borda de baixo do palco, quando ela desce para livrar a faixa de cima. */
export const MONITOR_BOTTOM_GAP = 8
/** De frente para a tela (era 0,06): parada, ela vira um retângulo e o encaixe fica nítido (screenAnchor, modo plano). */
const MONITOR_PITCH = 0
/** Limite do enquadramento do prédio (o plano distante da câmera é 250). */
export const MAX_FRAME_DISTANCE = 200

const tanHalf = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360)
const safeAspect = (a: number): number => (Number.isFinite(a) && a > 0 ? a : 1)

/** Um monitor: centro da tela e o giro dela (rotation.y; 0 = olha para +Z, positivo gira para +X — a mesa inclinada do U). */
export type MonitorAt = { x: number; y: number; z: number; yaw?: number }

/** Uma tela que a câmera enquadra de frente: meia largura/altura, quanto o plano fica à frente do centro e a arfagem. */
export interface ScreenPlane {
  halfW: number
  halfH: number
  front: number
  pitch: number
  /** Inclinação da tela (rotation.x; a de cima vai para trás com negativo). O console da Central: −0,27. */
  tilt?: number
}

/** O ponto da tela na altura `sy` (−1 embaixo, +1 em cima), com a inclinação: y e o recuo em z. */
export function planeEdge(plane: ScreenPlane, sy: number): { dy: number; dz: number } {
  const t = plane.tilt ?? 0
  return { dy: sy * plane.halfH * Math.cos(t), dz: sy * plane.halfH * Math.sin(t) }
}

/**
 * O ponto (sx, sy) da tela no mundo (sx, sy em −1..1; −1 = esquerda/embaixo de quem olha de frente):
 * no referencial dela (x pela largura, z para a frente do plano) e girado pelo yaw do monitor.
 */
export function screenPoint(m: MonitorAt, plane: ScreenPlane, sx: number, sy: number): { x: number; y: number; z: number } {
  const e = planeEdge(plane, sy)
  const yaw = m.yaw ?? 0
  const lx = sx * plane.halfW
  const lz = plane.front + e.dz
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: m.x + lx * c + lz * s, y: m.y + e.dy, z: m.z - lx * s + lz * c }
}

export const MONITOR_PLANE: ScreenPlane = { halfW: MONITOR_HALF_W, halfH: MONITOR_HALF_H, front: MONITOR_SCREEN_FRONT, pitch: MONITOR_PITCH }
/** A tela da TV da sala de reunião (2,25 × 1,13 m; cobre a imagem 16:9 inteira): de frente e SEM arfagem — em repouso o encaixe é translação pura. */
export const TV_PLANE: ScreenPlane = { halfW: 1.115, halfH: 0.56, front: 0.006, pitch: 0 }

/**
 * Pose que enquadra um monitor (tela girada pelo yaw dele) de frente, na distância
 * em que a tela ocupa `fill` da largura OU da altura do palco — o que limitar
 * primeiro.
 *
 * Com `view.heightPx` e `view.clearTopPx` (o HUD): a altura da tela não passa
 * do que cabe entre a faixa de cima e MONITOR_BOTTOM_GAP do fim do palco, e a
 * câmera sobe o necessário para a tela descer e não entrar na faixa. Só a pose
 * muda — a tela HTML segue os cantos projetados (screenAnchor), então o encaixe
 * não depende disto.
 */
export function monitorPose(m: MonitorAt, view: ViewSize, fill = MONITOR_FILL): CameraPose {
  return screenPose(m, MONITOR_PLANE, view, fill)
}

/** O foco na TV (dec-clique-tv): a mesma conta do monitor, com a tela da TV e sem arfagem. */
export function tvPose(tv: MonitorAt, view: ViewSize, fill = MONITOR_FILL): CameraPose {
  return screenPose(tv, TV_PLANE, view, fill)
}

/** Pose que enquadra a tela `plane` centrada em `m` (ver monitorPose). */
export function screenPose(m: MonitorAt, plane: ScreenPlane, view: ViewSize, fill = MONITOR_FILL): CameraPose {
  const yaw = m.yaw ?? 0
  const t = tanHalf(view.fovDeg)
  const H = view.heightPx ?? 0
  const clear = H > 0 ? Math.max(0, view.clearTopPx ?? 0) : 0
  // A altura que cabe abaixo da faixa (fração do palco); palco baixo demais não encolhe abaixo da metade.
  const room = clear > 0 ? Math.max(0.5, (H - clear - MONITOR_BOTTOM_GAP) / H) : 1
  const byWidth = plane.halfW / (fill * t * safeAspect(view.aspect))
  const byHeight = plane.halfH / (Math.min(fill, room) * t)
  // De frente para a tela: o alvo é o centro do plano dela e o giro da câmera é o do monitor.
  const center = screenPoint(m, { ...plane, tilt: 0 }, 0, 0)
  const pose: CameraPose = { tx: center.x, ty: m.y, tz: center.z, yaw, pitch: plane.pitch, distance: Math.max(byWidth, byHeight) }
  if (clear === 0) return pose
  // Bordas de cima e de baixo da tela (px) nesta pose; desce o que faltar para livrar a faixa, sem passar do fim.
  const px = (sy: number): number => ((1 - projectPoint(pose, view, screenPoint(m, plane, 0, sy)).y) / 2) * H
  const top = px(1)
  const bottom = px(-1)
  const shift = Math.max(0, Math.min(clear - top, H - MONITOR_BOTTOM_GAP - bottom))
  // Subir a câmera (e o alvo) Δ desce a tela Δ / (distância · tan) em NDC (a arfagem é pequena).
  pose.ty += ((2 * shift) / H) * pose.distance * t
  return pose
}

/** Vista de um agente: a câmera de cima e de frente para a mesa (yaw 0, como o voo até o monitor). */
export const AGENT_PITCH = 0.8
export const AGENT_DISTANCE = 5.5
const AGENT_TARGET_Y = 0.8

/** Pose que mostra o ponto (x, z) do chão — o agente ou a mesa dele — com a vizinhança em volta. */
export function agentPose(p: { x: number; z: number }): CameraPose {
  return { tx: p.x, ty: AGENT_TARGET_Y, tz: p.z, yaw: 0, pitch: AGENT_PITCH, distance: AGENT_DISTANCE }
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
 * no centro da caixa e busca a menor distância em que os 8 cantos — e os pontos
 * `extra` (o alto da usina, que é mais alta que as salas) — cabem em `fill` do
 * palco, na largura e na altura.
 */
export function framePose(box: FrameBox, view: ViewSize, pitch = 0.85, fill = 0.9, extra: ReadonlyArray<{ x: number; y: number; z: number }> = []): CameraPose {
  const base = { tx: (box.minX + box.maxX) / 2, ty: 0, tz: (box.minZ + box.maxZ) / 2, yaw: 0, pitch }
  const corners: Array<{ x: number; y: number; z: number }> = [...extra]
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
