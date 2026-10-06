/**
 * O tocador dos movimentos do Mixamo de UM personagem (motionLibrary.ts,
 * motionPick.ts). A cada quadro, depois da pose procedural:
 *
 *   1. update(): escolhe o clipe (pickMotion), avança o tempo (em laço pelo
 *      relógio, uma vez a partir do começo, ou pela fase da passada) e faz a
 *      transição — o clipe novo entra subindo o peso, o velho sai descendo;
 *   2. channels(out): antes do applyPose — a altura e o avanço da bacia (corpo
 *      inteiro) e os dedos, nos canais da pose (o avatar lê os mesmos);
 *   3. joints(rig): depois do applyPose — as juntas do boneco recebem a
 *      rotação do clipe, misturada com a procedural pelo peso, no referencial
 *      do personagem (cada junta local = pai aplicado⁻¹ · mundo misturado).
 *
 * Camada ADITIVA (digitar): o clipe não leva o corpo à pose dele; cada junta de
 * cima recebe, no referencial local, o quanto o clipe sai da POSE MÉDIA dele
 * (média⁻¹ · clipe), por cima da pose procedural — que põe as mãos no teclado.
 * As duas camadas convivem na transição (a direta sai, a aditiva entra).
 *
 * O avatar GLB copia o boneco (agentAvatar.ts), então anima junto. As juntas que
 * o applyPose só gira em X (cotovelo, joelho, perna, pé) e as que ele não toca
 * (bacia, mão) voltam ao zero antes do próximo applyPose (reset). Nada aloca por quadro.
 */
import { Quaternion } from 'three'
import type { Brain } from './brain'
import { MS, newSample, type MotionClip, type MotionLibrary, type MotionSample } from './motionLibrary'
import { pickMotion, type MotionMask, type MotionPick } from './motionPick'
import { CH, type BodyMetrics, type Pose } from './poses'
import type { Rig } from './rig'

/** Quanto leva a entrada e a saída de um clipe (s). */
export const MOTION_FADE_S = 0.3
/** Uma reação sai nos últimos segundos dela. */
const REACT_OUT_S = 0.25
/** Os dedos na camada aditiva: o quanto o clipe sai da média, um pouco ampliado (o fechar do indicador é pequeno). */
const ADD_CURL = 1.5

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const qa = new Quaternion()
const qb = new Quaternion()
const IDENT = new Quaternion()
/** Mundo procedural e mundo final (aplicado) de cada junta, na ordem J. */
const J = { pelvis: 0, spine: 1, head: 2, armL: 3, foreL: 4, handL: 5, armR: 6, foreR: 7, handR: 8, legL: 9, kneeL: 10, footL: 11, legR: 12, kneeR: 13, footR: 14 } as const
const JN = 15
const proc = Array.from({ length: JN }, () => new Quaternion())
const done = Array.from({ length: JN }, () => new Quaternion())
/** As juntas de cima na camada aditiva: [junta do boneco, segmento do clipe, segmento do pai no clipe]. */
const ADD_UPPER: ReadonlyArray<readonly [keyof Rig, number, number]> = [
  ['spine', MS.spine, MS.hips],
  ['head', MS.head, MS.spine],
  ['shoulderL', MS.armL, MS.spine],
  ['elbowL', MS.foreL, MS.armL],
  ['handL', MS.handL, MS.foreL],
  ['shoulderR', MS.armR, MS.spine],
  ['elbowR', MS.foreR, MS.armR],
  ['handR', MS.handR, MS.foreR]
]

interface Layer {
  pick: MotionPick
  clip: MotionClip
  time: number
  weight: number
  /** true: entrando (sobe o peso); false: saindo. */
  on: boolean
}

export class MotionPlayer {
  private readonly layers: Layer[] = []
  private readonly sample: MotionSample = newSample()
  private readonly blend: MotionSample = newSample()
  /** A amostra da camada aditiva de cima e a pose média do clipe dela. */
  private readonly add: MotionSample = newSample()
  private addMean: MotionSample | null = null
  /** As juntas foram mexidas no último quadro (o reset volta o que o applyPose não refaz). */
  private dirty = false
  /** Peso total (0..1) e máscara das camadas DIRETAS — o resto do personagem lê. */
  weight = 0
  mask: MotionMask = 'full'
  /** Peso da camada aditiva (digitar). */
  additive = 0
  key: string | null = null

  constructor(private readonly lib: () => MotionLibrary | null) {}

  /** Escolhe e avança o clipe. `phase`: a fase da passada (0..1). */
  update(dt: number, b: Brain, t: number, phase: number): void {
    const lib = this.lib()
    if (!lib) {
      this.weight = 0
      this.additive = 0
      return
    }
    const pick = pickMotion({ action: b.action, reaction: b.reaction, sit: b.sit, seat: b.seat, speed: b.speed, prop: b.prop, seed: b.seed, t }, (k) => lib.clip(k) !== null)
    const top = this.layers[this.layers.length - 1]
    const same = top && top.on && pick && top.pick.key === pick.key && top.pick.mask === pick.mask && !!top.pick.additive === !!pick.additive
    if (same) top.pick = pick
    else {
      for (const l of this.layers) l.on = false
      if (pick) {
        const clip = lib.clip(pick.key)!
        // A reação começa do começo; o laço entra numa fase da seed (dois agentes não ficam em espelho).
        const start = pick.loop && !pick.phase ? ((b.seed * 7.31) % 1) * clip.duration : 0
        this.layers.push({ pick, clip, time: start, weight: 0, on: true })
      }
    }
    const step = dt / MOTION_FADE_S
    let direct = 0
    let additive = 0
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]
      if (l.pick.phase) l.time = phase * l.clip.duration
      else l.time += dt * (l.pick.rate ?? 1)
      let want = l.on ? 1 : 0
      // A reação sai antes de acabar (o cérebro a encerra pela duração dela).
      if (!l.pick.loop && l.time > l.clip.duration - REACT_OUT_S) want = 0
      l.weight = want > l.weight ? Math.min(want, l.weight + step) : Math.max(want, l.weight - step)
      if (!l.on && l.weight <= 0) this.layers.splice(i, 1)
      else if (l.pick.additive) additive = Math.max(additive, l.weight)
      else direct = Math.max(direct, l.weight)
    }
    // Mais de duas camadas: as mais velhas saem já.
    while (this.layers.length > 2) this.layers.shift()
    this.weight = Math.min(1, direct)
    this.additive = Math.min(1, additive)
    let lastDirect: Layer | undefined
    for (const l of this.layers) if (!l.pick.additive) lastDirect = l
    this.mask = lastDirect?.pick.mask ?? 'full'
    const last = this.layers[this.layers.length - 1]
    this.key = last?.on ? last.pick.key : null
    if (this.weight > 0) this.mix(lib)
    if (this.additive > 0) this.mixAdditive(lib)
  }

  /** A amostra misturada das camadas diretas (a de baixo, depois a de cima pelo peso dela). */
  private mix(lib: MotionLibrary): void {
    const out = this.blend
    let first = true
    for (const l of this.layers) {
      if (l.weight <= 0 || l.pick.additive) continue
      lib.sample(l.clip, l.time, l.pick.loop, this.sample)
      const s = this.sample
      if (first) {
        for (let i = 0; i < out.q.length; i++) out.q[i].copy(s.q[i])
        out.hipsY = s.hipsY
        out.hipsZ = s.hipsZ
        out.curlL = s.curlL
        out.curlR = s.curlR
        first = false
        continue
      }
      const w = l.weight
      for (let i = 0; i < out.q.length; i++) out.q[i].slerp(s.q[i], w)
      out.hipsY += (s.hipsY - out.hipsY) * w
      out.hipsZ += (s.hipsZ - out.hipsZ) * w
      out.curlL += (s.curlL - out.curlL) * w
      out.curlR += (s.curlR - out.curlR) * w
    }
  }

  /** A amostra da camada aditiva mais nova (e a pose média do clipe dela). */
  private mixAdditive(lib: MotionLibrary): void {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]
      if (!l.pick.additive || l.weight <= 0) continue
      lib.sample(l.clip, l.time, l.pick.loop, this.add)
      this.addMean = lib.mean(l.clip)
      return
    }
  }

  /** Antes do applyPose: escolhe e avança o clipe, põe a bacia e os dedos nos canais e desfaz o giro do quadro anterior. */
  before(dt: number, b: Brain, t: number, phase: number, out: Pose, m: BodyMetrics, holding: boolean, r: Rig): void {
    this.update(dt, b, t, phase)
    this.channels(out, m, holding)
    this.reset(r)
  }

  /** Antes do applyPose: bacia (corpo inteiro) e dedos nos canais da pose. `holding`: a direita fica no objeto. */
  channels(out: Pose, m: BodyMetrics, holding: boolean): void {
    const w = this.weight
    if (w > 0) {
      const s = this.blend
      if (this.mask === 'full') {
        const leg = m.ankleY + m.thigh + m.shin
        out[CH.pelvisY] += (s.hipsY * leg - out[CH.pelvisY]) * w
        out[CH.pelvisZ] += (s.hipsZ * leg - out[CH.pelvisZ]) * w
        out[CH.hop] *= 1 - w
      }
      if (this.mask !== 'lower') {
        out[CH.fingersL] += (s.curlL - out[CH.fingersL]) * w
        if (!holding) out[CH.fingersR] += (s.curlR - out[CH.fingersR]) * w
      }
    }
    const a = this.additive
    const mean = this.addMean
    if (a <= 0 || !mean) return
    out[CH.fingersL] = clamp(out[CH.fingersL] + (this.add.curlL - mean.curlL) * ADD_CURL * a)
    if (!holding) out[CH.fingersR] = clamp(out[CH.fingersR] + (this.add.curlR - mean.curlR) * ADD_CURL * a)
  }

  /** Antes do applyPose: o que o clipe girou e o applyPose não refaz volta ao zero. */
  reset(r: Rig): void {
    if (!this.dirty) return
    this.dirty = false
    r.pelvis.quaternion.identity()
    for (const g of [r.elbowL, r.elbowR, r.legL, r.legR, r.kneeL, r.kneeR, r.footL, r.footR]) g.rotation.set(0, 0, 0)
    r.handL.quaternion.identity()
    r.handR.quaternion.identity()
  }

  /** Depois do applyPose: as juntas do boneco recebem o clipe (direto e/ou aditivo), pelo peso e pela máscara. */
  joints(r: Rig): void {
    if (this.weight > 0) this.directJoints(r)
    if (this.additive > 0 && this.addMean) this.additiveJoints(r)
  }

  /** Camada aditiva: cada junta de cima (local) = procedural · (média local⁻¹ · clipe local), pelo peso. */
  private additiveJoints(r: Rig): void {
    this.dirty = true
    const s = this.add.q
    const m = this.addMean!.q
    const w = this.additive
    for (const [joint, slot, parent] of ADD_UPPER) {
      // Local do clipe e da média: pai⁻¹ · segmento (no referencial do personagem).
      qa.copy(s[parent]).invert().multiply(s[slot])
      qb.copy(m[parent]).invert().multiply(m[slot]).invert().multiply(qa)
      if (w < 1) qb.slerpQuaternions(IDENT, qb, w)
      ;(r[joint] as { quaternion: Quaternion }).quaternion.multiply(qb)
    }
  }

  private directJoints(r: Rig): void {
    const w = this.weight
    this.dirty = true
    const s = this.blend.q
    const mask = this.mask
    const upper = mask !== 'lower' ? w : 0
    const lower = mask !== 'upper' ? w : 0
    // Mundo procedural de cada junta (personagem).
    proc[J.pelvis].copy(r.pelvis.quaternion)
    proc[J.spine].multiplyQuaternions(proc[J.pelvis], r.spine.quaternion)
    proc[J.head].multiplyQuaternions(proc[J.spine], r.head.quaternion)
    proc[J.armL].multiplyQuaternions(proc[J.spine], r.shoulderL.quaternion)
    proc[J.foreL].multiplyQuaternions(proc[J.armL], r.elbowL.quaternion)
    proc[J.handL].multiplyQuaternions(proc[J.foreL], r.handL.quaternion)
    proc[J.armR].multiplyQuaternions(proc[J.spine], r.shoulderR.quaternion)
    proc[J.foreR].multiplyQuaternions(proc[J.armR], r.elbowR.quaternion)
    proc[J.handR].multiplyQuaternions(proc[J.foreR], r.handR.quaternion)
    proc[J.legL].multiplyQuaternions(proc[J.pelvis], r.legL.quaternion)
    proc[J.kneeL].multiplyQuaternions(proc[J.legL], r.kneeL.quaternion)
    proc[J.footL].multiplyQuaternions(proc[J.kneeL], r.footL.quaternion)
    proc[J.legR].multiplyQuaternions(proc[J.pelvis], r.legR.quaternion)
    proc[J.kneeR].multiplyQuaternions(proc[J.legR], r.kneeR.quaternion)
    proc[J.footR].multiplyQuaternions(proc[J.kneeR], r.footR.quaternion)
    // Mundo final: o procedural indo para o clipe (a bacia só no corpo inteiro).
    const to = (j: number, slot: number, k: number): void => void done[j].slerpQuaternions(proc[j], s[slot], k)
    to(J.pelvis, MS.hips, mask === 'full' ? w : 0)
    to(J.spine, MS.spine, upper)
    to(J.head, MS.head, upper)
    to(J.armL, MS.armL, upper)
    to(J.foreL, MS.foreL, upper)
    to(J.handL, MS.handL, upper)
    to(J.armR, MS.armR, upper)
    to(J.foreR, MS.foreR, upper)
    to(J.handR, MS.handR, upper)
    to(J.legL, MS.legL, lower)
    to(J.kneeL, MS.kneeL, lower)
    to(J.footL, MS.footL, lower)
    to(J.legR, MS.legR, lower)
    to(J.kneeR, MS.kneeR, lower)
    to(J.footR, MS.footR, lower)
    // De volta ao local de cada junta, a partir do pai como ficou.
    const local = (g: { quaternion: Quaternion }, parent: number, j: number): void => void g.quaternion.copy(qa.copy(done[parent]).invert()).multiply(done[j])
    r.pelvis.quaternion.copy(done[J.pelvis])
    local(r.spine, J.pelvis, J.spine)
    local(r.head, J.spine, J.head)
    local(r.shoulderL, J.spine, J.armL)
    local(r.elbowL, J.armL, J.foreL)
    local(r.handL, J.foreL, J.handL)
    local(r.shoulderR, J.spine, J.armR)
    local(r.elbowR, J.armR, J.foreR)
    local(r.handR, J.foreR, J.handR)
    local(r.legL, J.pelvis, J.legL)
    local(r.kneeL, J.legL, J.kneeL)
    local(r.footL, J.kneeL, J.footL)
    local(r.legR, J.pelvis, J.legR)
    local(r.kneeR, J.legR, J.kneeR)
    local(r.footR, J.kneeR, J.footR)
  }
}
