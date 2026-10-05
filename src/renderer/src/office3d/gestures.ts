/**
 * Gestos do personagem 3D — PUROS (sem three): o que tronco, braços, cabeça e
 * rosto fazem em cada AÇÃO (digitar, ler a tela, tamborilar, mão no queixo,
 * café, livro, janela, regador, post-it, conversa, celular, fila, cochilo) e em
 * cada REAÇÃO curta (pulinho do "!", susto, estalar os dedos, comemorar,
 * espreguiçar, facepalm, soco no ar, mãos na cabeça, bocejo, relógio, pasta,
 * tchauzinho, joinha, ombros). Escrevem só os canais de cima (UPPER) num `out`
 * reaproveitado; a locomoção e o sentar ficam em poses.ts e as ações da festa
 * do apagão (danças, trenzinho, lanterna, pizza), em dance.ts.
 */
import { partyPose } from './dance'
import { DESK_D, DESK_HEIGHT, KEYBOARD_FRONT, SEAT_FRONT } from './officePlan'
import { BODY, CH, envelope, mix, pulse, REACTION_S, SEAT_HEIGHT, smooth, type Action, type ActionParams, type Pose, type Reaction } from './poses'

/** Tampo da estação (m) e o pivô da bacia de quem senta na cadeira dela (sem escala). */
const DESK_TOP = DESK_HEIGHT + 0.025
const SEATED_HIP = SEAT_HEIGHT.chair + 0.075
/** À frente do quadril (m): o punho no teclado, as mãos apoiadas logo depois da borda do tampo. */
const KEYS_AHEAD = SEAT_FRONT - KEYBOARD_FRONT - 0.05
const EDGE_AHEAD = SEAT_FRONT - DESK_D / 2 + 0.13

const ik = { fwd: 0, elbow: 0 }

/**
 * Cinemática inversa do braço sentado na cadeira da estação: o ângulo pelo
 * ombro (canal armFwd, já descontada a inclinação `lean` do tronco) e a dobra
 * do cotovelo que levam o punho à altura `y` (m do chão) e `ahead` m à frente
 * do quadril. `scale` = a escala do boneco (o subagente é menor; o assento e a
 * mesa são os mesmos). Fora de alcance, o braço estica na direção do alvo.
 */
function reach(y: number, ahead: number, lean: number, scale = 1): typeof ik {
  const pelvis = SEATED_HIP + BODY.hipDrop * scale
  const fz = ahead / scale - BODY.shoulderY * Math.sin(lean)
  const fy = BODY.shoulderY * Math.cos(lean) - (y - pelvis) / scale
  const L1 = BODY.upperArm
  const L2 = BODY.forearm
  const d = Math.min(Math.hypot(fz, fy), L1 + L2 - 1e-3)
  const cosE = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)
  const e = Math.acos(cosE < -1 ? -1 : cosE > 1 ? 1 : cosE)
  ik.fwd = Math.atan2(fz, fy) - Math.atan2(L2 * Math.sin(e), L1 + L2 * Math.cos(e)) + lean
  ik.elbow = e
  return ik
}

function arms(out: Pose, fL: number, oL: number, eL: number, fR: number, oR: number, eR: number): void {
  out[CH.armFwdL] = fL
  out[CH.armOutL] = oL
  out[CH.elbowL] = eL
  out[CH.armFwdR] = fR
  out[CH.armOutR] = oR
  out[CH.elbowR] = eR
}

/**
 * Mãos no teclado: o cotovelo perto do corpo e acima do tampo, o antebraço
 * quase na horizontal e o punho sobre as teclas (`reach`, pela inclinação do
 * tronco). Os dedos batem e o cotovelo acompanha.
 */
function typing(out: Pose, t: number, rate: number, amp: number, lean: number, scale = 1): void {
  const r = reach(DESK_TOP + 0.055, KEYS_AHEAD, lean, scale)
  arms(out, r.fwd, -0.12, r.elbow, r.fwd, -0.12, r.elbow)
  out[CH.elbowL] += amp * Math.abs(Math.sin(rate * t))
  out[CH.elbowR] += amp * Math.abs(Math.sin(rate * t + 1.7))
  out[CH.fingersL] = 0.15 + 0.3 * Math.abs(Math.sin(rate * 2 * t))
  out[CH.fingersR] = 0.15 + 0.3 * Math.abs(Math.sin(rate * 2 * t + 1.1))
  out[CH.lean] = lean
  out[CH.headPitch] = 0.1
}

/** Escreve os canais de cima da ação `a` no instante `t` (s desde o início). */
export function actionPose(out: Pose, a: Action, t: number, p: ActionParams): void {
  const k = p.seed
  switch (a) {
    case 'none':
    case 'idle':
      out[CH.headYaw] = 0.22 * Math.sin(0.31 * t + k) + 0.08 * Math.sin(0.83 * t)
      out[CH.twist] += 0.03 * Math.sin(0.4 * t + k)
      out[CH.roll] = 0.02 * Math.sin(0.5 * t + k)
      return
    case 'sitIdle': {
      // Antebraços apoiados na borda do tampo, mãos juntas à frente.
      const r = reach(DESK_TOP + 0.04, EDGE_AHEAD, 0.04, p.scale)
      arms(out, r.fwd, -0.3, r.elbow, r.fwd, -0.3, r.elbow)
      out[CH.lean] = 0.04
      out[CH.headYaw] = 0.3 * Math.sin(0.27 * t + k)
      out[CH.fingersL] = out[CH.fingersR] = 0.4
      return
    }
    case 'type':
      typing(out, t, 7.5 * p.speed, 0.07, 0.1, p.scale)
      out[CH.headYaw] = 0.05 * Math.sin(0.9 * t + k)
      return
    case 'typeFast':
      typing(out, t, 13 * p.speed, 0.1, 0.16, p.scale)
      out[CH.headPitch] = 0.14
      out[CH.brows] = -0.35
      return
    case 'readScreen': {
      // A esquerda no teclado, a direita no mouse (aberta para o lado); olha a tela de perto.
      const r = reach(DESK_TOP + 0.055, KEYS_AHEAD, 0.08, p.scale)
      arms(out, r.fwd, -0.08, r.elbow, r.fwd, 0.22 + 0.03 * Math.sin(0.7 * t), r.elbow)
      out[CH.lean] = 0.08
      out[CH.headYaw] = 0.22 * Math.sin(1.1 * t + k)
      out[CH.headPitch] = -0.02 + 0.07 * ((t * 0.25) % 1)
      out[CH.fingersR] = 0.2 + 0.5 * pulse(t % 2.3, 1.9, 0.2)
      out[CH.brows] = -0.15
      return
    }
    case 'drum': {
      const r = reach(DESK_TOP + 0.05, EDGE_AHEAD + 0.05, 0.04, p.scale)
      arms(out, r.fwd, -0.08, r.elbow, r.fwd, -0.1, r.elbow)
      const drumming = t % 1.2 < 0.6
      out[CH.fingersR] = drumming ? 0.2 + 0.5 * Math.abs(Math.sin(12 * t)) : 0.2
      out[CH.elbowR] += drumming ? 0.04 * Math.abs(Math.sin(12 * t)) : 0
      out[CH.lean] = 0.04
      out[CH.roll] = 0.04
      out[CH.headRoll] = 0.12
      out[CH.headPitch] = 0.05
      out[CH.eyes] = 0.72
      return
    }
    case 'web':
      // Recostado, mão direita no queixo (o braço gira para o cotovelo dobrar para dentro).
      arms(out, 1.3, -0.05, 0.75, 1.75, 0, 2.15)
      out[CH.twistR] = 1.2
      out[CH.lean] = -0.2
      out[CH.headPitch] = -0.04
      out[CH.headRoll] = -0.08 + 0.05 * Math.sin(0.4 * t + k)
      out[CH.fingersR] = 0.6
      out[CH.fingersL] = 0.3 + 0.3 * pulse(t % 3.1, 2.4, 0.5)
      out[CH.brows] = 0.2
      return
    case 'assist':
    case 'listen':
      // Braços cruzados.
      arms(out, 0.75, 0, 1.65, 0.75, 0, 1.85)
      out[CH.twistL] = out[CH.twistR] = 1.45
      out[CH.headPitch] = (a === 'assist' ? 0.18 : 0.06) + 0.07 * Math.max(0, Math.sin(2.2 * t + k))
      out[CH.headRoll] = a === 'listen' ? 0.1 : 0
      out[CH.brows] = a === 'assist' ? -0.1 : 0.1
      return
    case 'wave': {
      const s = Math.sin(6.5 * t)
      arms(out, 0.2, 0.35 - 0.15 * s, 0.5, 2.75, 0.25 + 0.22 * s, 0.3 + 0.12 * Math.sin(6.5 * t + 0.5))
      out[CH.brows] = 0.85
      out[CH.mouth] = 0.35 + 0.15 * Math.abs(Math.sin(4 * t))
      out[CH.hop] = 0.025 * Math.abs(Math.sin(5 * t))
      out[CH.twist] = 0.05 * Math.sin(3.2 * t)
      out[CH.headPitch] = -0.1
      return
    }
    case 'brew':
      arms(out, 0.8, 0, 0.6, 1.25, -0.05, 0.35 - 0.3 * (pulse(t, 0.4, 0.25) + pulse(t, 1.2, 0.25)))
      out[CH.lean] = 0.08
      out[CH.headPitch] = 0.3
      return
    case 'sip': {
      const c = (t + k) % 3.6
      const up = smooth((c - 2.3) / 0.35) * (1 - smooth((c - 3.1) / 0.35))
      // Sentado à mesa: o cotovelo fica apoiado acima do tampo e só o antebraço leva a xícara à boca.
      if (p.seated) {
        const r = reach(DESK_TOP + 0.07, EDGE_AHEAD - 0.06, 0, p.scale)
        arms(out, r.fwd, -0.1, r.elbow, mix(r.fwd, 0.95, up), mix(0.05, -0.2, up), mix(r.elbow, 2.25, up))
      }
      else arms(out, -0.06, 0.1, 0.35, mix(0.75, 0.98, up), -0.1, mix(1.55, 2.25, up))
      out[CH.headPitch] = mix(0.12, -0.2, up)
      out[CH.eyes] = mix(1, 0.4, up)
      out[CH.headYaw] = (1 - up) * 0.2 * Math.sin(0.5 * t + k)
      out[CH.fingersL] = 0.8
      out[CH.prop] = up
      return
    }
    case 'grabBook': {
      const down = smooth((t - 0.55) / 0.35)
      arms(out, mix(0.05, 0.9, down), mix(0.07, -0.2, down), mix(0.14, 1.45, down), mix(2.3, 0.9, down), mix(0.1, -0.2, down), mix(0.25, 1.45, down))
      out[CH.headPitch] = mix(-0.25, 0.42, down)
      return
    }
    case 'readBook': {
      const flip = pulse((t + k) % 2.6, 2.1, 0.4)
      arms(out, 0.9, -0.2, 1.45, 0.9, -0.2 + 0.35 * flip, 1.45 - 0.2 * flip)
      out[CH.headPitch] = 0.42 + 0.03 * Math.sin(0.9 * t)
      out[CH.eyes] = 0.9
      out[CH.brows] = 0.1
      return
    }
    case 'lookOut':
      arms(out, -0.38, 0.08, 0.75, -0.38, 0.08, 0.75)
      out[CH.headPitch] = -0.1
      out[CH.headYaw] = 0.18 * Math.sin(0.25 * t + k)
      out[CH.brows] = 0.2
      out[CH.lean] = -0.02
      return
    case 'stretchUp':
    case 'water':
    case 'readBoard':
    case 'stick':
    case 'admire':
    case 'unpin':
    case 'scribble':
    case 'stamp':
    case 'crumple':
    case 'point':
    case 'talk':
    case 'phone':
    case 'wait':
    case 'napDesk':
    case 'napSofa':
      leisurePose(out, a, t, k)
      return
    case 'robot':
    case 'disco':
    case 'sway':
    case 'hop':
    case 'conga':
    case 'flashlight':
    case 'pizza':
    case 'jump':
      partyPose(out, a, t, p)
      return
  }
}

function leisurePose(out: Pose, a: Action, t: number, k: number): void {
  switch (a) {
    case 'stretchUp': {
      const e = envelope(t, 2.4, 0.5, 0.6)
      arms(out, mix(-0.38, 2.95, e), 0.18, mix(0.75, 0.1, e), mix(-0.38, 2.95, e), 0.18, mix(0.75, 0.1, e))
      out[CH.lean] = -0.18 * e
      out[CH.headPitch] = -0.32 * e
      out[CH.mouth] = 0.65 * e
      out[CH.eyes] = 1 - 0.8 * e
      out[CH.roll] = 0.08 * Math.sin(2 * t) * e
      return
    }
    case 'water':
      arms(out, -0.25, 0.55, 1.65, 1, 0.12, 0.3)
      out[CH.headPitch] = 0.42
      out[CH.lean] = 0.1
      out[CH.prop] = 0.55 + 0.2 * Math.sin(2 * t)
      return
    case 'readBoard':
      // Mão esquerda no queixo, pensativo.
      arms(out, 1.75, 0, 2.15, 0.05, 0.07, 0.14)
      out[CH.twistL] = 1.2
      out[CH.headPitch] = -0.08
      out[CH.headYaw] = 0.25 * Math.sin(0.6 * t + k)
      out[CH.brows] = -0.1
      out[CH.fingersL] = 0.6
      return
    case 'stick': {
      const reach = envelope(t, 1.1, 0.35, 0.3)
      arms(out, 0.05, 0.07, 0.14, mix(0.05, 1.55, reach), 0.05, mix(0.14, 0.15, reach))
      out[CH.lean] = 0.06 * reach + 0.06 * pulse(t, 0.5, 0.25)
      out[CH.headPitch] = -0.05
      return
    }
    case 'unpin': {
      // Braço direito ao papel, pinça e puxa o alfinete.
      const reach = envelope(t, 1, 0.3, 0.25)
      arms(out, 0.05, 0.07, 0.14, mix(0.05, 1.6, reach), 0.05, mix(0.14, 0.3, reach))
      out[CH.fingersR] = smooth((t - 0.35) / 0.15)
      out[CH.lean] = 0.05 * reach - 0.04 * pulse(t, 0.55, 0.25)
      out[CH.headPitch] = -0.05
      return
    }
    case 'scribble': {
      // Papel na esquerda, a direita rabisca em zigue-zague.
      arms(out, 0.95, -0.1, 1.5, 1.05 + 0.06 * Math.sin(14 * t), -0.12 + 0.08 * Math.sin(9 * t + k), 1.45)
      out[CH.headPitch] = 0.4
      out[CH.brows] = -0.15
      out[CH.fingersR] = 0.8
      return
    }
    case 'stamp': {
      // Ergue e bate o carimbo no papel.
      const up = envelope(t, 0.9, 0.3, 0.2)
      const hit = pulse(t, 0.45, 0.18)
      arms(out, 0.05, 0.07, 0.14, mix(1.2, 1.75, up) - 0.35 * hit, 0.05, mix(0.6, 0.9, up))
      out[CH.fingersR] = 1
      out[CH.lean] = 0.08 * hit
      out[CH.brows] = 0.3
      return
    }
    case 'crumple': {
      // Amassa com as duas mãos e arremessa no cesto.
      const ball = smooth(t / 0.6)
      const toss = pulse(t, 0.75, 0.35)
      arms(out, mix(0.9, 0.7, ball), 0.25 * (1 - ball), 1.5, mix(0.9, 0.7, ball) + 1.2 * toss, 0.25 * (1 - ball), 1.5 - 1.1 * toss)
      out[CH.fingersL] = out[CH.fingersR] = 0.6 + 0.4 * Math.abs(Math.sin(12 * t)) * (1 - ball)
      out[CH.headPitch] = 0.35 - 0.3 * toss
      out[CH.prop] = ball
      return
    }
    case 'point':
      // Aponta para o papel e fala.
      arms(out, 0.05, 0.07, 0.14, 1.45, 0.1, 0.05)
      out[CH.fingersR] = 0.9
      out[CH.mouth] = 0.12 + 0.3 * Math.abs(Math.sin(9 * t))
      out[CH.headYaw] = 0.3
      out[CH.brows] = 0.25
      return
    case 'admire':
      arms(out, -0.22, 0.58, 1.7, -0.22, 0.58, 1.7)
      out[CH.headPitch] = -0.05 + 0.05 * Math.sin(3 * t)
      out[CH.brows] = 0.3
      out[CH.roll] = 0.04
      return
    case 'talk':
      arms(
        out,
        0.45 + 0.2 * Math.sin(2.1 * t + 1),
        0.1,
        1 + 0.3 * Math.sin(2.9 * t + 2),
        0.7 + 0.3 * Math.sin(2.7 * t + k),
        0.18 + 0.15 * Math.sin(1.9 * t),
        1.3 + 0.35 * Math.sin(3.3 * t)
      )
      out[CH.mouth] = 0.12 + 0.3 * Math.abs(Math.sin(9 * t))
      out[CH.headPitch] = 0.05 * Math.sin(2.5 * t)
      out[CH.headRoll] = 0.06 * Math.sin(1.3 * t)
      out[CH.brows] = 0.25 + 0.25 * Math.sin(1.7 * t)
      return
    case 'phone': {
      const laugh = pulse((t + k) % 7, 5.8, 0.8)
      arms(out, 0.15, 0.07, 0.35, 0.95, -0.15, 1.45)
      out[CH.thumbR] = 0.5 + 0.5 * Math.sin(4 * t)
      out[CH.headPitch] = 0.55
      out[CH.eyes] = 0.9
      out[CH.shrug] = 0.3 * laugh * Math.abs(Math.sin(20 * t))
      out[CH.mouth] = 0.4 * laugh
      return
    }
    case 'wait':
      arms(out, -0.08, 0.12, 0.4, -0.08, 0.12, 0.4)
      out[CH.fingersL] = out[CH.fingersR] = 0.8
      out[CH.headYaw] = 0.2 * Math.sin(0.4 * t + k)
      out[CH.lean] = -0.02
      return
    case 'napDesk': {
      // Cochilo na estação: debruçado sobre a mesa, a cabeça deitada nos braços cruzados sobre o tampo.
      // Cotovelos abertos apoiados no tampo e as mãos juntas sob a cabeça (ângulos buscados no rig).
      const lean = 1.03 + 0.015 * Math.sin(1.25 * t)
      arms(out, 0.95, 1.35, 1.9, 0.95, 1.35, 1.9)
      out[CH.twistL] = out[CH.twistR] = 1.25
      out[CH.lean] = lean
      out[CH.headPitch] = 0.2
      out[CH.headRoll] = 0.45
      out[CH.eyes] = 0
      out[CH.mouth] = 0.1
      return
    }
    case 'napSofa':
      // Esparramado: afundado, reclinado e com os braços largados no sofá.
      arms(out, -0.15, 0.42, 0.35, -0.15, 0.42, 0.35)
      out[CH.fingersL] = out[CH.fingersR] = 0.55
      out[CH.lean] = -0.75 + 0.02 * Math.sin(1.2 * t)
      out[CH.headPitch] = 0.08
      out[CH.headRoll] = 0.35
      out[CH.eyes] = 0
      out[CH.mouth] = 0.12 + 0.12 * Math.sin(1.2 * t)
      return
  }
}

// ── reações ────────────────────────────────────────────────────────────────

/** Escreve os canais de cima da reação `r` no instante `t`. `seated` amortece pulos. */
export function reactionPose(out: Pose, r: Reaction, t: number, p: ActionParams, seated: boolean): void {
  reactionArms(out, r, t, p, seated)
  if (p.seated) seatedClamp(out, p.scale)
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
function handTip(out: Pose, left: boolean, scale: number, hand = 0.14): typeof tip {
  const fwd = out[left ? CH.armFwdL : CH.armFwdR]
  const tw = left ? -out[CH.twistL] : out[CH.twistR]
  const ab = left ? -out[CH.armOutL] : out[CH.armOutR]
  const e = out[left ? CH.elbowL : CH.elbowR]
  // Antebraço (com a mão) no referencial do braço, girado pelo cotovelo; somado ao braço.
  const L2 = BODY.forearm + hand
  const fy = -L2 * Math.cos(e)
  const fz = -L2 * Math.sin(e)
  eulerXYZ(0, -BODY.upperArm + fy, fz, fwd, tw, ab)
  // No tronco (o ombro em shoulderY), inclinado por lean (rotação x = −lean).
  const lean = out[CH.lean]
  const y = BODY.shoulderY + v3.y
  const z = v3.z
  const wy = y * Math.cos(-lean) - z * Math.sin(-lean)
  const wz = y * Math.sin(-lean) + z * Math.cos(-lean)
  tip.y = SEATED_HIP + (BODY.hipDrop + wy) * scale
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
function seatedClamp(out: Pose, scale = 1): void {
  // Debruçado na mesa (o cochilo), a reação o endireita: o susto de quem acorda.
  out[CH.lean] = Math.min(0.3, Math.max(out[CH.lean], -0.05))
  const edge = SEAT_FRONT - DESK_D / 2 - 0.08
  // Na espessura do tampo (embaixo dele ficam as coxas e o colo: lá a mão pode ir).
  const slab = (h: typeof tip): boolean => h.ahead > edge && h.y > DESK_HEIGHT - 0.07 && h.y < DESK_TOP + 0.06
  // O cotovelo, o meio do antebraço, o punho, o meio e a ponta da mão.
  const inDeskArm = (left: boolean): boolean => slab(handTip(out, left, scale, -BODY.forearm)) || slab(handTip(out, left, scale, -BODY.forearm / 2)) || slab(handTip(out, left, scale, 0)) || slab(handTip(out, left, scale, 0.07)) || slab(handTip(out, left, scale, 0.15))
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
    } else if (handTip(out, left, scale).y < SEAT_HEIGHT.chair + 0.12) {
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
