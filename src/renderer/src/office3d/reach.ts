/**
 * Alcance das mãos — PURO (sem three): a cinemática inversa do braço até o
 * teclado (sentado na cadeira da estação ou em pé no teclado do console da
 * Central) e a pose de digitar, que gestures.ts (ações) e reactions.ts
 * (reações) usam. O clipe 'typing' do Mixamo entra por cima desta pose
 * (motionPlayer.ts, camada aditiva): aqui fica a ALTURA certa das mãos.
 */
import { CENTRAL_SPOT, CONSOLE_KEYS, DESK_D, DESK_HEIGHT, KEYBOARD_FRONT, SEAT_FRONT } from './officePlan'
import { BODY, CH, SEAT_HEIGHT, type BodyMetrics, type Pose } from './poses'

/** Tampo da estação (m) e o pivô da bacia de quem senta na cadeira dela (sem escala). */
export const DESK_TOP = DESK_HEIGHT + 0.025
export const SEATED_HIP = SEAT_HEIGHT.chair + 0.075
/** À frente do quadril (m): o punho no teclado, as mãos apoiadas logo depois da borda do tampo. */
export const KEYS_AHEAD = SEAT_FRONT - KEYBOARD_FRONT - 0.05
export const EDGE_AHEAD = SEAT_FRONT - DESK_D / 2 + 0.13
/** Em pé no console: o punho logo depois da borda de perto do teclado (m à frente do quadril) e acima das teclas. */
export const CONSOLE_WRIST_AHEAD = CENTRAL_SPOT.z - CONSOLE_KEYS.z - CONSOLE_KEYS.d / 2 + 0.02
export const CONSOLE_WRIST_Y = CONSOLE_KEYS.y + 0.035

const ik = { fwd: 0, elbow: 0 }

/**
 * Cinemática inversa do braço: o ângulo pelo ombro (canal armFwd, já
 * descontada a inclinação `lean` do tronco) e a dobra do cotovelo que levam o
 * punho à altura `y` (m do chão) e `ahead` m à frente do quadril, com a bacia
 * a `pelvis` m do chão. `scale` = a escala do personagem (o assento e a mesa
 * são os mesmos; `b` = as medidas do corpo). Fora de alcance, o braço estica.
 */
function solve(y: number, ahead: number, lean: number, pelvis: number, scale: number, b: BodyMetrics): typeof ik {
  const fz = ahead / scale - b.shoulderY * Math.sin(lean)
  const fy = b.shoulderY * Math.cos(lean) - (y - pelvis) / scale
  const L1 = b.upperArm
  const L2 = b.forearm
  const d = Math.min(Math.hypot(fz, fy), L1 + L2 - 1e-3)
  const cosE = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)
  const e = Math.acos(cosE < -1 ? -1 : cosE > 1 ? 1 : cosE)
  ik.fwd = Math.atan2(fz, fy) - Math.atan2(L2 * Math.sin(e), L1 + L2 * Math.cos(e)) + lean
  ik.elbow = e
  return ik
}

/** Sentado na cadeira da estação (o pivô da bacia no assento). */
export function reach(y: number, ahead: number, lean: number, scale = 1, b: BodyMetrics = BODY): typeof ik {
  return solve(y, ahead, lean, SEATED_HIP + b.hipDrop * scale, scale, b)
}

/** Em pé (o pivô da bacia na altura das pernas esticadas). */
export function reachStanding(y: number, ahead: number, lean: number, scale = 1, b: BodyMetrics = BODY): typeof ik {
  return solve(y, ahead, lean, b.pelvisY * scale, scale, b)
}

export function arms(out: Pose, fL: number, oL: number, eL: number, fR: number, oR: number, eR: number): void {
  out[CH.armFwdL] = fL
  out[CH.armOutL] = oL
  out[CH.elbowL] = eL
  out[CH.armFwdR] = fR
  out[CH.armOutR] = oR
  out[CH.elbowR] = eR
}

/**
 * Mãos no teclado: o cotovelo perto do corpo, o antebraço quase na horizontal
 * e o punho sobre as teclas (pela inclinação do tronco). Sentado, o teclado da
 * mesa; em pé (`standing`), o teclado do console da Central. Os dedos batem e
 * o cotovelo acompanha.
 */
export function typing(out: Pose, t: number, rate: number, amp: number, lean: number, scale = 1, b: BodyMetrics = BODY, standing = false): void {
  const r = standing ? reachStanding(CONSOLE_WRIST_Y, CONSOLE_WRIST_AHEAD, lean, scale, b) : reach(DESK_TOP + 0.055, KEYS_AHEAD, lean, scale, b)
  arms(out, r.fwd, -0.12, r.elbow, r.fwd, -0.12, r.elbow)
  out[CH.elbowL] += amp * Math.abs(Math.sin(rate * t))
  out[CH.elbowR] += amp * Math.abs(Math.sin(rate * t + 1.7))
  out[CH.fingersL] = 0.15 + 0.3 * Math.abs(Math.sin(rate * 2 * t))
  out[CH.fingersR] = 0.15 + 0.3 * Math.abs(Math.sin(rate * 2 * t + 1.1))
  out[CH.lean] = lean
  out[CH.headPitch] = 0.1
}
