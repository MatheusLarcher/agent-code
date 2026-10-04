/**
 * Biblioteca de poses do personagem 3D — PURA (sem three). Uma pose é um
 * Float32Array de CANAIS (ângulos e deslocamentos das juntas: quadril, tronco,
 * cabeça, ombros, cotovelos, pernas, joelhos, pés, dedos e rosto); o rig.ts
 * aplica nas juntas. Tudo escreve num `out` reaproveitado: zero alocação por
 * quadro.
 *
 * Três camadas, compostas no animador (characters.ts):
 *   locomoção  parado/caminhada/corrida (fase guiada pela DISTÂNCIA: o pé de
 *              apoio desliza para trás exatamente na velocidade do corpo) e o
 *              sentar (cadeira ou sofá do lounge), com o peso `sit` da transição — aqui;
 *   ação       o que o tronco/braços/cabeça fazem (digitar, ler, celular…),
 *              com crossfade de BLEND_S ao trocar — gestures.ts;
 *   reação     gesto curto por cima de tudo (pulinho do "!", facepalm, soco
 *              no ar…), com entrada e saída suaves — gestures.ts.
 *
 * Convenções (personagem olha para -Z local): lean + inclina para a frente;
 * twist/headYaw + giram para a esquerda; headPitch + olha para baixo; armFwd +
 * ergue o braço para a frente; armOut + abre para o lado; twistL/R + giram o
 * braço no próprio eixo para o cotovelo dobrar rumo ao meio do corpo; elbow +
 * dobra o antebraço; leg + leva a coxa para a frente; knee + dobra o
 * joelho; foot + levanta a ponta do pé; fingers 0..1 fecha a mão; eyes 1 =
 * aberto; brows + sobrancelhas erguidas, − franzidas; hop soma à altura.
 */

export const CH = {
  pelvisY: 0,
  pelvisZ: 1,
  lean: 2,
  twist: 3,
  roll: 4,
  headPitch: 5,
  headYaw: 6,
  headRoll: 7,
  armFwdL: 8,
  armOutL: 9,
  elbowL: 10,
  armFwdR: 11,
  armOutR: 12,
  elbowR: 13,
  legL: 14,
  kneeL: 15,
  legR: 16,
  kneeR: 17,
  footL: 18,
  footR: 19,
  fingersL: 20,
  fingersR: 21,
  thumbR: 22,
  shrug: 23,
  mouth: 24,
  brows: 25,
  eyes: 26,
  hop: 27,
  /** Ângulo do objeto na mão (inclinar o regador, virar a xícara…). */
  prop: 28,
  /** Rotação do braço no próprio eixo: + o cotovelo dobra para o meio do corpo (mão no rosto, braços cruzados). */
  twistL: 29,
  twistR: 30
} as const
export const CHANNELS = 31
export type Pose = Float32Array

/** Canais da parte de cima (ação e reação); o resto é da locomoção. */
export const UPPER: readonly number[] = [
  CH.lean, CH.twist, CH.roll, CH.headPitch, CH.headYaw, CH.headRoll, CH.armFwdL, CH.armOutL, CH.elbowL, CH.armFwdR, CH.armOutR, CH.elbowR,
  CH.fingersL, CH.fingersR, CH.thumbR, CH.shrug, CH.mouth, CH.brows, CH.eyes, CH.hop, CH.prop, CH.twistL, CH.twistR
]

/** Coxa e canela (m); a perna esticada vai do quadril ao tornozelo em LEG. */
export const THIGH = 0.27
export const SHIN = 0.25
export const LEG = THIGH + SHIN
/** Crossfade entre ações. */
export const BLEND_S = 0.2

export type Action =
  | 'none' | 'idle' | 'sitIdle' | 'type' | 'typeFast' | 'readScreen' | 'drum' | 'web' | 'assist' | 'wave' | 'brew' | 'sip'
  | 'grabBook' | 'readBook' | 'lookOut' | 'stretchUp' | 'water' | 'readBoard' | 'stick' | 'admire' | 'talk' | 'listen'
  | 'phone' | 'wait' | 'napDesk' | 'napSofa'
  // No quadro (brainBoard.ts): soltar o alfinete, rabiscar, carimbar ✓, amassar e jogar, apontar.
  | 'unpin' | 'scribble' | 'stamp' | 'crumple' | 'point'
  // Festa do apagão (dance.ts): quatro passos no BPM, trenzinho, lanterna e pizza.
  | 'robot' | 'disco' | 'sway' | 'hop' | 'conga' | 'flashlight' | 'pizza'

export type Reaction =
  | 'alert' | 'scared' | 'knuckles' | 'celebrate' | 'stretch' | 'facepalm' | 'fistpump' | 'handsHead' | 'yawn' | 'watch'
  | 'handoff' | 'greet' | 'thumbsUp' | 'shrug'

/** Duração (s) de cada reação. */
export const REACTION_S: Record<Reaction, number> = {
  alert: 0.7, scared: 1, knuckles: 1, celebrate: 1.5, stretch: 1.8, facepalm: 2, fistpump: 1.1, handsHead: 1.8, yawn: 2,
  watch: 1.6, handoff: 1.8, greet: 1.4, thumbsUp: 1.2, shrug: 1.3
}

export interface ActionParams {
  /** Ritmo do trabalho (contexto baixo digita mais devagar). */
  speed: number
  /** Desfasagem por personagem, para ninguém mexer em sincronia. */
  seed: number
  /** Lado do colega na entrega da pasta: +1 direita, -1 esquerda. */
  side: number
  /** Batida da música da festa (relógio da cena × BPM): todos dançam juntos. */
  beat?: number
  /** Sentado na cadeira da estação: os gestos ficam sobre o tampo (nada atravessa a mesa). */
  seated?: boolean
}

export const clamp01 = (k: number): number => (k < 0 ? 0 : k > 1 ? 1 : k)
export const smooth = (k: number): number => {
  const x = clamp01(k)
  return x * x * (3 - 2 * x)
}
export const mix = (a: number, b: number, k: number): number => a + (b - a) * k
/** Sobe em `rise` s, fica, desce nos últimos `fall` s. */
export const envelope = (t: number, dur: number, rise = 0.25, fall = 0.3): number => smooth(t / rise) * (1 - smooth((t - (dur - fall)) / fall))
/** Meia senoide entre `at` e `at + w` (um toque, um empurrão). */
export const pulse = (t: number, at: number, w: number): number => (t < at || t > at + w ? 0 : Math.sin((Math.PI * (t - at)) / w))

export function newPose(): Pose {
  const p = new Float32Array(CHANNELS)
  standPose(p)
  return p
}

export function copyPose(out: Pose, a: Pose): void {
  out.set(a)
}

/** out = a + (b - a)·w, nos canais `only` (ou todos). */
export function lerpPose(out: Pose, a: Pose, b: Pose, w: number, only?: readonly number[]): void {
  if (only) for (const i of only) out[i] = a[i] + (b[i] - a[i]) * w
  else for (let i = 0; i < CHANNELS; i++) out[i] = a[i] + (b[i] - a[i]) * w
}

// ── locomoção ──────────────────────────────────────────────────────────────

/** Amplitude da passada (rad), fração de apoio, quanto o pé sobe no balanço, inclinação e braços. */
const WALK = { amp: 0.48, duty: 0.6, lift: 0.06, lean: 0.06, arm: 0.42, elbow: 0.3 }
const RUN = { amp: 0.72, duty: 0.38, lift: 0.13, lean: 0.28, arm: 0.95, elbow: 1.35 }

/** Distância (m) que o corpo anda num ciclo completo (dois passos). */
export function strideLength(run: number): number {
  const amp = mix(WALK.amp, RUN.amp, run)
  return (2 * LEG * Math.sin(amp)) / mix(WALK.duty, RUN.duty, run)
}

interface Foot {
  /** Tornozelo à frente do quadril (m) e quanto sobe do chão. */
  x: number
  lift: number
  stance: boolean
  leg: number
  knee: number
  foot: number
}

const footL: Foot = { x: 0, lift: 0, stance: true, leg: 0, knee: 0, foot: 0 }
const footR: Foot = { x: 0, lift: 0, stance: true, leg: 0, knee: 0, foot: 0 }

/**
 * Onde o pé está na fração `u` do ciclo. Apoio: anda para trás em linha reta,
 * na velocidade do corpo — no chão ele fica parado (não desliza). Balanço: volta
 * para a frente subindo `lift` no meio.
 */
function footAt(u: number, reach: number, duty: number, lift: number, f: Foot): void {
  if (u < duty) {
    f.stance = true
    f.x = reach * (1 - (2 * u) / duty)
    f.lift = 0
    f.foot = 0
    return
  }
  const p = (u - duty) / (1 - duty)
  f.stance = false
  f.x = reach * (2 * smooth(p) - 1)
  f.lift = lift * Math.sin(Math.PI * p)
  f.foot = 0.25 * (2 * p - 1) * Math.sin(Math.PI * p)
}

/** IK de dois ossos: coxa e joelho para o tornozelo ficar `x` à frente e `v` abaixo do quadril (joelho para a frente). */
function reachFoot(f: Foot, v: number): void {
  const d = Math.hypot(f.x, v)
  if (d >= LEG - 1e-6) {
    f.leg = Math.atan2(f.x, v)
    f.knee = 0
    return
  }
  const atKnee = Math.acos(Math.max(-1, Math.min(1, (THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN))))
  const atHip = Math.acos(Math.max(-1, Math.min(1, (THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d))))
  f.leg = Math.atan2(f.x, v) + atHip
  f.knee = Math.PI - atKnee
}

/**
 * Caminhada/corrida na fração `u` (0..1) do ciclo, com peso `w` (0 parado, 1
 * andando) e `run` (0 caminhada, 1 corrida). Escreve pernas, quadril, braços e
 * inclinação; os braços valem quando a ação é 'none'. O quadril sobe no meio
 * de cada apoio simples e desce no apoio duplo (caminhada) ou comprime no
 * apoio e quica no voo (corrida) — sempre contínuo; os joelhos se ajustam por
 * IK para os pés apoiados ficarem exatamente no chão.
 */
export function locomotion(out: Pose, u: number, w: number, run: number): void {
  standPose(out)
  if (w <= 0) return
  const amp = mix(WALK.amp, RUN.amp, run)
  const duty = mix(WALK.duty, RUN.duty, run)
  const reach = LEG * Math.sin(amp)
  const lift = mix(WALK.lift, RUN.lift, run)
  const uL = u - Math.floor(u)
  const uR = (uL + 0.5) % 1
  footAt(uL, reach, duty, lift, footL)
  footAt(uR, reach, duty, lift, footR)
  // Altura do quadril acima do tornozelo, em pernas (1 = perna esticada na vertical).
  const c = Math.cos(amp)
  let y = c
  if (footL.stance !== footR.stance) {
    const s0 = Math.max(0, duty - 0.5)
    const p = clamp01(((footL.stance ? uL : uR) - s0) / Math.max(1e-6, Math.min(duty, 0.5) - s0))
    const s = Math.sin(Math.PI * p)
    y = mix(c + (1 - c) * s * s, c - 0.06 * s, run)
  } else if (!footL.stance) {
    // Voo da corrida: os dois pés no ar desde que o último saiu do chão.
    y = c + 0.1 * run * Math.sin(Math.PI * clamp01((Math.min(uL, uR) - duty) / Math.max(0.01, 0.5 - duty)))
  }
  reachFoot(footL, LEG * y - footL.lift)
  reachFoot(footR, LEG * y - footR.lift)
  const legL = footL
  const legR = footR
  out[CH.pelvisY] = w * LEG * (y - 1)
  out[CH.legL] = w * legL.leg
  out[CH.kneeL] = w * legL.knee
  out[CH.footL] = w * legL.foot
  out[CH.legR] = w * legR.leg
  out[CH.kneeR] = w * legR.knee
  out[CH.footR] = w * legR.foot
  // Braços em contrafase com as pernas; ombros giram contra o quadril.
  const arm = mix(WALK.arm, RUN.arm, run)
  const swing = Math.cos(2 * Math.PI * uL)
  out[CH.armFwdL] = mix(out[CH.armFwdL], -arm * swing + 0.1 * run, w)
  out[CH.armFwdR] = mix(out[CH.armFwdR], arm * swing + 0.1 * run, w)
  const elbow = mix(WALK.elbow, RUN.elbow, run)
  out[CH.elbowL] = mix(out[CH.elbowL], elbow + 0.15 * (1 + swing), w)
  out[CH.elbowR] = mix(out[CH.elbowR], elbow + 0.15 * (1 - swing), w)
  out[CH.lean] = mix(out[CH.lean], mix(WALK.lean, RUN.lean, run), w)
  out[CH.twist] = w * 0.08 * swing
  out[CH.headPitch] = mix(out[CH.headPitch], 0.08, w)
  out[CH.mouth] = w * run * 0.25
}

/** Em pé, relaxado. */
export function standPose(out: Pose): void {
  out.fill(0)
  out[CH.lean] = 0.02
  out[CH.headPitch] = 0.04
  out[CH.armFwdL] = out[CH.armFwdR] = 0.05
  out[CH.armOutL] = out[CH.armOutR] = 0.07
  out[CH.elbowL] = out[CH.elbowR] = 0.14
  out[CH.fingersL] = out[CH.fingersR] = 0.3
  out[CH.eyes] = 1
}

export type SeatKind = 'chair' | 'sofa' | 'desk'

/** Pernas e quadril sentados (o tronco é da ação). Na beira da mesa as pernas balançam com o relógio `t`. */
export function sitLower(out: Pose, seat: SeatKind, t = 0): void {
  if (seat === 'desk') {
    // Tampo a 0,78 m: quadril alto, coxas na horizontal e canelas soltas, balançando.
    out[CH.pelvisY] = 0.3
    out[CH.pelvisZ] = 0
    out[CH.legL] = out[CH.legR] = 1.45
    out[CH.kneeL] = 1.25 + 0.22 * Math.sin(3.1 * t)
    out[CH.kneeR] = 1.25 + 0.22 * Math.sin(3.1 * t + Math.PI)
  } else if (seat === 'sofa') {
    // Sofá/poltrona do lounge (assento a ~0,34 m): afunda um pouco, coxas quase na horizontal, pés no chão.
    out[CH.pelvisY] = -0.17
    out[CH.pelvisZ] = 0.1
    out[CH.legL] = out[CH.legR] = 1.25
    out[CH.kneeL] = out[CH.kneeR] = 1.1
  } else {
    // Cadeira da estação (decorIslands.ts, topo do assento a 0,33 m): quadril
    // sobre o assento curto, coxa descendo pela borda dele até o joelho (sob o
    // tampo) e canela na vertical — os pés tocam o chão dentro da base de rodinhas.
    out[CH.pelvisY] = -0.14
    out[CH.pelvisZ] = 0
    out[CH.legL] = out[CH.legR] = 1.07
    out[CH.kneeL] = out[CH.kneeR] = 1.07
  }
  out[CH.footL] = out[CH.footR] = 0
}
