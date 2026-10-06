/**
 * Reações curtas do personagem 3D — PURAS (sem three): pulinho do "!", susto,
 * estalar os dedos, comemorar, espreguiçar, facepalm, soco no ar, mãos na
 * cabeça, bocejo, relógio, pasta, tchauzinho, joinha e ombros. Escrevem só os
 * canais de cima (UPPER) por cima da ação; sentado na cadeira, o braço não
 * entra na mesa nem no encosto (seatedClamp).
 */
import { DESK_D, DESK_HEIGHT, SEAT_FRONT } from './officePlan'
import { BODY, CH, envelope, mix, pulse, REACTION_S, SEAT_HEIGHT, type ActionParams, type BodyMetrics, type Pose, type Reaction } from './poses'
import { arms, DESK_TOP, SEATED_HIP } from './reach'

/** Escreve os canais de cima da reação `r` no instante `t`. `seated` amortece pulos. */
export function reactionPose(out: Pose, r: Reaction, t: number, p: ActionParams, seated: boolean): void {
  reactionArms(out, r, t, p, seated)
  if (p.seated) seatedClamp(out, p.scale, p.body)
}

/** Vetor girado como o three gira um Object3D com Euler XYZ (primeiro Z, depois Y, depois X). */
const v3 = { x: 0, y: 0, z: 0 }
function eulerXYZ(x: number, y: number, z: number, rx: number, ry: number, rz: number): void {
  let a = x * Math.cos(rz) - y * Math.sin(rz)
  let b = x * Math.sin(rz) + y * Math.cos(rz)
  let c = z
  const a2 = a * Math.cos(ry) + c * Math.sin(ry)
  c = -a * Math.sin(ry) + c * Math.cos(ry)
  a = a2
  const b2 = b * Math.cos(rx) - c * Math.sin(rx)
  c = b * Math.sin(rx) + c * Math.cos(rx)
  b = b2
  v3.x = a
  v3.y = b
  v3.z = c
}

/**
 * Onde o braço deixa a ponta da mão (cinemática direta do rig, com o giro do
 * braço e a inclinação do tronco): y do chão e quanto à frente do quadril (m).
 */
const tip = { y: 0, ahead: 0 }
function handTip(out: Pose, left: boolean, scale: number, hand = 0.14, b: BodyMetrics = BODY): typeof tip {
  const fwd = out[left ? CH.armFwdL : CH.armFwdR]
  const tw = left ? -out[CH.twistL] : out[CH.twistR]
  const ab = left ? -out[CH.armOutL] : out[CH.armOutR]
  const e = out[left ? CH.elbowL : CH.elbowR]
  // Antebraço (com a mão) no referencial do braço, girado pelo cotovelo; somado ao braço.
  const L2 = b.forearm + hand
  const fy = -L2 * Math.cos(e)
  const fz = -L2 * Math.sin(e)
  eulerXYZ(0, -b.upperArm + fy, fz, fwd, tw, ab)
  // No tronco (o ombro em shoulderY), inclinado por lean (rotação x = −lean).
  const lean = out[CH.lean]
  const y = b.shoulderY + v3.y
  const z = v3.z
  const wy = y * Math.cos(-lean) - z * Math.sin(-lean)
  const wz = y * Math.sin(-lean) + z * Math.cos(-lean)
  tip.y = SEATED_HIP + (b.hipDrop + wy) * scale
  tip.ahead = -wz * scale
  return tip
}

/**
 * Sentado na cadeira da estação: o tronco não deita no encosto e o braço não
 * vai para trás dele. Só o braço que entraria na mobília muda: a mão que
 * desceria dentro do tampo sobe o antebraço (o gesto fica na frente do peito);
 * a que desceria no assento vai para o colo; braço baixo fica por dentro dos
 * braços da cadeira. As mãos no teclado (a pose da ação) não mudam.
 */
function seatedClamp(out: Pose, scale = 1, b: BodyMetrics = BODY): void {
  // Debruçado na mesa (o cochilo), a reação o endireita: o susto de quem acorda.
  out[CH.lean] = Math.min(0.3, Math.max(out[CH.lean], -0.05))
  const edge = SEAT_FRONT - DESK_D / 2 - 0.08
  // Na espessura do tampo (embaixo dele ficam as coxas e o colo: lá a mão pode ir).
  const slab = (h: typeof tip): boolean => h.ahead > edge && h.y > DESK_HEIGHT - 0.07 && h.y < DESK_TOP + 0.06
  // O cotovelo, o meio do antebraço, o punho, o meio e a ponta da mão.
  const inDeskArm = (left: boolean): boolean => slab(handTip(out, left, scale, -b.forearm, b)) || slab(handTip(out, left, scale, -b.forearm / 2, b)) || slab(handTip(out, left, scale, 0, b)) || slab(handTip(out, left, scale, 0.07, b)) || slab(handTip(out, left, scale, 0.15, b))
  for (const [fwd, outC, elbow, twist, left] of [[CH.armFwdL, CH.armOutL, CH.elbowL, CH.twistL, true], [CH.armFwdR, CH.armOutR, CH.elbowR, CH.twistR, false]] as const) {
    // O braço não vai para trás do tronco (o encosto); a medida é contra a inclinação dele.
    const lean = Math.max(0, out[CH.lean])
    out[fwd] = Math.max(out[fwd], lean + 0.15)
    if (out[fwd] < 1.1) out[outC] = Math.min(out[outC], 0.12)
    if (inDeskArm(left)) {
      // Sobe o antebraço até a mão sair do tampo (o giro do braço desfaz junto, se precisar).
      out[elbow] = Math.max(out[elbow], 2.05 - out[fwd])
      for (let i = 0; i < 8 && inDeskArm(left); i++) {
        out[twist] *= 0.5
        out[elbow] = Math.min(2.6, out[elbow] + 0.15)
      }
    } else if (handTip(out, left, scale, 0.14, b).y < SEAT_HEIGHT.chair + 0.12) {
      // No colo: a mão sobre a coxa, antes da borda do tampo.
      out[fwd] = Math.min(out[fwd], lean + 0.2)
      out[twist] = 0
      out[elbow] = Math.max(out[elbow], 1.02 + lean - out[fwd])
      for (let i = 0; i < 8 && inDeskArm(left); i++) out[elbow] -= 0.08
    }
  }
}

function reactionArms(out: Pose, r: Reaction, t: number, p: ActionParams, seated: boolean): void {
  const dur = REACTION_S[r]
  const e = envelope(t, dur)
  // Sentado com as pernas sob o tampo não há pulo: o susto fica no tronco e nos braços.
  const hopK = seated ? 0 : 1
  switch (r) {
    case 'alert':
      arms(out, 0.35, 0.45, 0.7, 0.35, 0.45, 0.7)
      out[CH.hop] = t < 0.42 ? 0.11 * hopK * Math.sin((Math.PI * t) / 0.42) : 0
      out[CH.brows] = 1
      out[CH.mouth] = 0.45
      out[CH.eyes] = 1.25
      out[CH.headPitch] = -0.12
      return
    case 'scared':
      arms(out, 2 + 0.4 * Math.sin(28 * t), 1 + 0.3 * Math.sin(33 * t + 1), 0.6 + 0.4 * Math.sin(25 * t), 2 + 0.4 * Math.sin(29 * t + 2), 1 + 0.3 * Math.sin(31 * t), 0.6 + 0.4 * Math.sin(27 * t + 1))
      out[CH.hop] = t < 0.5 ? 0.22 * hopK * Math.sin((Math.PI * t) / 0.5) : 0
      out[CH.headYaw] = t > 0.45 ? 0.25 * Math.sin(19 * t) : 0
      out[CH.brows] = 1
      out[CH.mouth] = 0.85
      out[CH.eyes] = 1.3
      return
    case 'knuckles': {
      // Mãos juntas à frente do peito; dois empurrões = os estalos.
      const push = pulse(t, 0.35, 0.15) + pulse(t, 0.65, 0.15)
      arms(out, 1.35, 0, 0.9 - 0.45 * push, 1.35, 0, 0.9 - 0.45 * push)
      out[CH.twistL] = out[CH.twistR] = 0.9
      out[CH.fingersL] = out[CH.fingersR] = 0.7
      out[CH.headRoll] = 0.1
      out[CH.brows] = -0.3
      out[CH.mouth] = 0.1
      out[CH.lean] = 0.05 + 0.05 * push
      return
    }
    case 'celebrate':
    case 'stretch':
    case 'facepalm':
    case 'fistpump':
    case 'handsHead':
      bigReaction(out, r, t, e, hopK)
      return
    case 'yawn':
      // Mão direita na boca, braço esquerdo se espreguiçando.
      arms(out, mix(0.05, 2.5, e), 0.07, mix(0.14, 0.35, e), 1.85 * e, 0, mix(0.14, 2.1, e))
      out[CH.twistR] = 1.25 * e
      out[CH.headPitch] = -0.32 * e
      out[CH.mouth] = e
      out[CH.eyes] = 1 - 0.85 * e
      out[CH.lean] = -0.1 * e
      return
    case 'watch':
      // Antebraço esquerdo atravessado no peito, olhando o pulso (e chacoalhando o relógio).
      arms(out, 1.1 * e, t > 0.9 ? 0.08 * Math.sin(22 * t) : 0, 1.55 * e, -0.2, 0.5, 1.6)
      out[CH.twistL] = 1.45 * e
      out[CH.headYaw] = -0.2 * e
      out[CH.headPitch] = 0.5 * e
      out[CH.brows] = -0.4
      out[CH.mouth] = 0.08
      return
    case 'handoff': {
      const side = p.side >= 0 ? 1 : -1
      out[CH.twist] = -0.55 * side * e
      out[CH.headYaw] = -0.55 * side * e
      out[CH.armFwdR] = 1.35 * e
      out[CH.armOutR] = (side > 0 ? 0.55 : -0.25) * e
      out[CH.elbowR] = 0.25
      out[CH.brows] = 0.3
      out[CH.mouth] = 0.2
      return
    }
    case 'greet':
      out[CH.armFwdR] = 2.35 * e
      out[CH.armOutR] = (0.55 + 0.3 * Math.sin(13 * t)) * e
      out[CH.elbowR] = (0.5 + 0.35 * Math.sin(13 * t + 0.6)) * e
      out[CH.brows] = 0.6
      out[CH.mouth] = 0.3
      return
    case 'thumbsUp':
      out[CH.armFwdR] = 1.25 * e
      out[CH.armOutR] = 0.1
      out[CH.elbowR] = 1.35 * e
      out[CH.fingersR] = 1
      out[CH.thumbR] = 1
      out[CH.headPitch] = -0.05 + 0.08 * Math.sin(6 * t)
      out[CH.brows] = 0.4
      out[CH.mouth] = 0.25
      return
    case 'shrug':
      arms(out, 0.55 * e, 0.4 * e, 1.45 * e, 0.55 * e, 0.4 * e, 1.45 * e)
      out[CH.shrug] = e
      out[CH.headRoll] = 0.25 * e
      out[CH.brows] = 0.75 * e
      out[CH.mouth] = 0.15
      return
  }
}

function bigReaction(out: Pose, r: Reaction, t: number, e: number, hopK: number): void {
  switch (r) {
    case 'celebrate': {
      const w = Math.sin(14 * t)
      arms(out, 2.6 * e, (0.6 + 0.12 * w) * e, 0.25 + 0.15 * w, 2.6 * e, (0.6 - 0.12 * w) * e, 0.25 - 0.15 * w)
      out[CH.hop] = 0.07 * hopK * Math.abs(Math.sin(9 * t)) * e
      out[CH.mouth] = 0.65
      out[CH.brows] = 0.8
      out[CH.eyes] = 0.7
      out[CH.headPitch] = -0.15
      return
    }
    case 'stretch':
      arms(out, 2.95 * e, 0.15, 0.05, 2.95 * e, 0.15, 0.05)
      out[CH.lean] = -0.22 * e
      out[CH.headPitch] = -0.3 * e
      out[CH.mouth] = 0.7 * e
      out[CH.eyes] = 1 - 0.85 * e
      out[CH.roll] = 0.1 * Math.sin(2.5 * t) * e
      return
    case 'facepalm':
      // Mão direita cobrindo o rosto.
      arms(out, 0.02, 0.07, 0.1, 2 * e, 0, 2.05 * e)
      out[CH.twistR] = 1.3 * e
      out[CH.fingersR] = 0.1
      out[CH.headPitch] = 0.38 * e
      out[CH.headYaw] = t > 0.5 && t < 1.5 ? 0.12 * Math.sin(8 * t) : 0
      out[CH.brows] = -0.7
      out[CH.mouth] = 0.1
      out[CH.lean] = 0.08 * e
      return
    case 'fistpump':
      out[CH.armFwdR] = 2.45 * e
      out[CH.armOutR] = 0.25 * e
      out[CH.elbowR] = 0.35 + 0.85 * Math.abs(Math.sin(8.5 * t)) * e
      out[CH.fingersR] = 1
      out[CH.hop] = 0.05 * hopK * Math.abs(Math.sin(8.5 * t)) * e
      out[CH.mouth] = 0.55
      out[CH.brows] = 0.7
      out[CH.headPitch] = -0.1
      return
    case 'handsHead':
      // Mãos agarrando a cabeça (cotovelos abertos, antebraços girados para dentro).
      arms(out, 2.45 * e, 0.5 * e, 1.9 * e, 2.45 * e, 0.5 * e, 1.9 * e)
      out[CH.twistL] = out[CH.twistR] = 0.85 * e
      out[CH.fingersL] = out[CH.fingersR] = 0.2
      out[CH.headYaw] = 0.16 * Math.sin(7 * t) * e
      out[CH.headPitch] = -0.12
      out[CH.mouth] = 0.55
      out[CH.brows] = 0.9
      out[CH.eyes] = 1.15
      return
    default:
      return
  }
}
