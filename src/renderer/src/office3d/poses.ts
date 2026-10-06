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

/**
 * Medidas do corpo (m, adulto de ~1,80 m em pé): tornozelo, coxa e canela,
 * as juntas do quadril abaixo do pivô da bacia, ombros (junta e largura),
 * centro da cabeça (acima da bacia) e a cabeça (meias medidas), braço e
 * antebraço. O pivô da bacia fica a pelvisY do chão em pé. O sapato, a partir
 * do tornozelo: quanto desce até a sola e quanto vai até a ponta (bodyGeo.ts).
 */
export const BODY = (() => {
  const ankleY = 0.085
  const thigh = 0.45
  const shin = 0.46
  const hipDrop = 0.03
  return {
    ankleY,
    thigh,
    shin,
    hipDrop,
    hipX: 0.092,
    pelvisY: ankleY + thigh + shin + hipDrop,
    shoulderY: 0.45,
    shoulderX: 0.19,
    headY: 0.69,
    headW: 0.086,
    headH: 0.116,
    headD: 0.102,
    upperArm: 0.29,
    forearm: 0.26,
    soleDown: 0.085,
    toeAhead: 0.19,
    /** No sofá, quanto o joelho tem de ficar à frente do quadril para passar a borda do estofado (0: o boneco não precisa). */
    seatClear: 0
  }
})()
/**
 * Medidas de um corpo: o boneco procedural usa BODY; um modelo GLB passa as
 * dele, lidas do esqueleto (agentMetrics.ts). Os ângulos das poses são os
 * mesmos; o que depende do tamanho (altura da bacia, alcance, passada) usa estas.
 */
export type BodyMetrics = typeof BODY
/** Coxa e canela (m); a perna esticada vai do quadril ao tornozelo em LEG. */
export const THIGH = BODY.thigh
export const SHIN = BODY.shin
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
  // O chamado sem resposta (brain.ts): pula no lugar acenando para a câmera.
  | 'jump'

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
  /** Escala do boneco (o subagente é menor): o alcance até o teclado é calculado com ela. */
  scale?: number
  /** Medidas do corpo (o modelo GLB); sem elas, BODY. */
  body?: BodyMetrics
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
export function strideLength(run: number, b: BodyMetrics = BODY): number {
  const amp = mix(WALK.amp, RUN.amp, run)
  return (2 * (b.thigh + b.shin) * Math.sin(amp)) / mix(WALK.duty, RUN.duty, run)
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
function reachFoot(f: Foot, v: number, b: BodyMetrics): void {
  const d = Math.hypot(f.x, v)
  const { thigh, shin } = b
  if (d >= thigh + shin - 1e-6) {
    f.leg = Math.atan2(f.x, v)
    f.knee = 0
    return
  }
  const atKnee = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + shin * shin - d * d) / (2 * thigh * shin))))
  const atHip = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + d * d - shin * shin) / (2 * thigh * d))))
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
export function locomotion(out: Pose, u: number, w: number, run: number, b: BodyMetrics = BODY): void {
  standPose(out)
  if (w <= 0) return
  const leg = b.thigh + b.shin
  const amp = mix(WALK.amp, RUN.amp, run)
  const duty = mix(WALK.duty, RUN.duty, run)
  const reach = leg * Math.sin(amp)
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
  reachFoot(footL, leg * y - footL.lift, b)
  reachFoot(footR, leg * y - footR.lift, b)
  const legL = footL
  const legR = footR
  out[CH.pelvisY] = w * leg * (y - 1)
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

/**
 * Altura (m) de cada assento: a cadeira do mockup (chairModel.ts, topo do
 * assento a 0,59), o sofá/poltrona do lounge e o tampo da mesa (0,775).
 */
export const SEAT_HEIGHT: Record<SeatKind, number> = { chair: 0.59, sofa: 0.6, desk: 0.775 }

/** Quanto o quadril (a junta) fica acima do assento: a carne que apoia, menos o que o estofado afunda. */
const SIT_ON: Record<SeatKind, number> = { chair: 0.09, sofa: 0.04, desk: 0.07 }

const acosClamp = (v: number): number => Math.acos(v < -1 ? -1 : v > 1 ? 1 : v)

/**
 * Pernas e quadril sentados (o tronco é da ação), calculados pela altura do
 * assento e pela escala do boneco (`scale`: o subagente é menor, o assento é o
 * mesmo). Cadeira: canela na vertical e os calcanhares um pouco erguidos (a
 * ponta do pé no chão). Sofá: os pés esticados à frente. Beira da mesa: coxas
 * quase na horizontal e as canelas soltas, balançando com o relógio `t`. `b`:
 * as medidas do corpo (o modelo GLB; BODY no boneco).
 */
export function sitLower(out: Pose, seat: SeatKind, t = 0, scale = 1, vary = 0.5, b: BodyMetrics = BODY): void {
  const hip = (SEAT_HEIGHT[seat] + SIT_ON[seat]) / scale
  const { thigh: THIGH, shin: SHIN, soleDown: SOLE_DOWN, toeAhead: TOE_AHEAD } = b
  out[CH.pelvisY] = hip + b.hipDrop - b.pelvisY
  out[CH.pelvisZ] = 0
  if (seat === 'desk') {
    out[CH.legL] = out[CH.legR] = 1.45
    out[CH.kneeL] = 1.25 + 0.22 * Math.sin(3.1 * t)
    out[CH.kneeR] = 1.25 + 0.22 * Math.sin(3.1 * t + Math.PI)
    out[CH.footL] = out[CH.footR] = 0
    return
  }
  if (seat === 'sofa') {
    // Afundado no sofá: a canela inclinada para a frente e o pé apoiado inteiro.
    const shinTilt = 0.38
    const thigh = acosClamp((hip - (b.ankleY + SHIN * Math.cos(shinTilt))) / THIGH)
    if (THIGH * Math.sin(thigh) < b.seatClear) {
      // Coxa curta (o modelo cartoon): o joelho cairia dentro do estofado. A coxa deita sobre o assento, o quadril
      // vem para a frente até o joelho passar a borda e a canela fica solta (o pé pode não alcançar o chão).
      const flat = acosClamp((hip - (SEAT_HEIGHT.sofa + 0.04) / scale) / THIGH)
      out[CH.pelvisZ] = -Math.max(0, b.seatClear - THIGH * Math.sin(flat))
      out[CH.legL] = out[CH.legR] = flat
      out[CH.kneeL] = out[CH.kneeR] = flat - 0.12
      out[CH.footL] = out[CH.footR] = -0.3
      return
    }
    out[CH.legL] = out[CH.legR] = thigh
    out[CH.kneeL] = out[CH.kneeR] = thigh - shinTilt
    out[CH.footL] = out[CH.footR] = 0.05
    return
  }
  // Cadeira (alta, a do mockup): a coxa quase na horizontal sobre o assento (o joelho cabe sob o tampo)
  // e o calcanhar erguido, a ponta do pé no chão. Cada um senta do seu jeito (`vary`, 0..1 pela seed):
  // um pé mais à frente e o outro recolhido sob o joelho, e de tempos em tempos troca o apoio.
  const knee = hip - 0.06 / scale
  const thigh = acosClamp((hip - knee) / THIGH)
  const shift = 0.05 * Math.sin(0.23 * t + vary * 6.28)
  const reach = Math.hypot(SOLE_DOWN, TOE_AHEAD)
  const tilts = [0.06 + 0.26 * vary + shift, 0.04 + 0.2 * (1 - vary) - shift]
  ;([[CH.legL, CH.kneeL, CH.footL], [CH.legR, CH.kneeR, CH.footR]] as const).forEach(([leg, kn, foot], i) => {
    const tilt = Math.max(0, tilts[i])
    out[leg] = thigh
    out[kn] = thigh - tilt
    const ankle = knee - SHIN * Math.cos(tilt)
    const toe = Math.asin(Math.min(1, Math.max(0, ankle / reach))) - Math.atan2(SOLE_DOWN, TOE_AHEAD)
    out[foot] = -Math.min(1.1, Math.max(0, toe))
  })
}
