/**
 * Corpo articulado do personagem 3D (three): quadril → tronco → pescoço/cabeça
 * e ombros → cotovelos → mãos (palma, dedos, polegar); quadril → coxas →
 * joelhos → pés. `applyPose` copia os canais de poses.ts para as juntas sem
 * alocar nada. Rosto com olhos (piscam), sobrancelhas e boca.
 *
 * Medidas: quadril a PELVIS_Y do chão em pé (coxa THIGH + canela SHIN + sola);
 * ombros a SHOULDER_Y e o centro da cabeça a HEAD_Y acima do quadril. Malhas de
 * detalhe (olhos, sobrancelhas, boca, dedos, polegares) levam userData.lod =
 * 'detail' (somem no LOD médio); mãos, pescoço e sapatos levam 'small' (somem
 * no LOD longe).
 */
import { Group, Mesh, type Material } from 'three'
import type { Kit } from './kit'
import { CH, SHIN, THIGH, type Pose } from './poses'

export const PELVIS_Y = 0.56
export const SHOULDER_Y = 0.43
export const HEAD_Y = 0.66
export const HEAD_RADIUS = 0.15
const EYE_H = 0.035
const BROW_Y = 0.048

export interface Rig {
  pelvis: Group
  spine: Group
  torso: Mesh
  head: Group
  headMesh: Mesh
  eyeL: Mesh
  eyeR: Mesh
  browL: Mesh
  browR: Mesh
  mouth: Mesh
  shoulderL: Group
  shoulderR: Group
  elbowL: Group
  elbowR: Group
  handL: Group
  handR: Group
  fingersL: Group
  fingersR: Group
  thumbR: Group
  legL: Group
  legR: Group
  kneeL: Group
  kneeR: Group
  footL: Group
  footR: Group
  /** Malhas de detalhe (userData.lod = 'detail'). */
  details: Mesh[]
  /** Partes pequenas (userData.lod = 'small'): mãos, pescoço, sapatos. */
  smalls: Mesh[]
}

export interface RigMaterials {
  skin: Material
  shirt: Material
  hair: Material
  pants: Material
}

function part(parent: Group, kit: Kit, mat: Material, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
  const m = new Mesh(kit.geo.box, mat)
  m.scale.set(w, h, d)
  m.position.set(x, y, z)
  parent.add(m)
  return m
}

function joint(parent: Group, x: number, y: number, z: number): Group {
  const g = new Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

/** Monta o corpo dentro de `root` (o grupo do personagem, no chão). */
export function buildRig(kit: Kit, root: Group, m: RigMaterials): Rig {
  const details: Mesh[] = []
  const smalls: Mesh[] = []
  const detail = (mesh: Mesh): Mesh => {
    mesh.userData.lod = 'detail'
    details.push(mesh)
    return mesh
  }
  const small = (mesh: Mesh): Mesh => {
    mesh.userData.lod = 'small'
    smalls.push(mesh)
    return mesh
  }
  const pelvis = joint(root, 0, PELVIS_Y, 0)
  part(pelvis, kit, m.pants, 0.3, 0.13, 0.18, 0, -0.02, 0)

  const leg = (side: number): { hip: Group; knee: Group; foot: Group } => {
    const hip = joint(pelvis, side * 0.085, -0.02, 0)
    part(hip, kit, m.pants, 0.13, THIGH, 0.14, 0, -THIGH / 2, 0)
    const knee = joint(hip, 0, -THIGH, 0)
    part(knee, kit, m.pants, 0.12, SHIN, 0.125, 0, -SHIN / 2, 0)
    const foot = joint(knee, 0, -SHIN, 0)
    small(part(foot, kit, kit.mat.shoe, 0.12, 0.07, 0.21, 0, 0.015, -0.045))
    return { hip, knee, foot }
  }
  const l = leg(-1)
  const r = leg(1)

  const spine = joint(pelvis, 0, 0, 0)
  const torso = new Mesh(kit.geo.torso, m.shirt)
  torso.position.y = 0.23
  torso.castShadow = true
  spine.add(torso)
  const neck = small(new Mesh(kit.geo.cyl, m.skin))
  neck.scale.set(0.08, 0.08, 0.08)
  neck.position.y = 0.48
  spine.add(neck)

  const head = joint(spine, 0, HEAD_Y, 0)
  const headMesh = new Mesh(kit.geo.head, m.skin)
  headMesh.castShadow = true
  head.add(headMesh)
  const hair = new Mesh(kit.geo.hair, m.hair)
  hair.position.y = 0.015
  hair.rotation.x = 0.4
  head.add(hair)
  const face = (mat: Material, w: number, h: number, x: number, y: number, z = -0.142): Mesh => {
    const f = detail(new Mesh(kit.geo.box, mat))
    f.scale.set(w, h, 0.012)
    f.position.set(x, y, z)
    head.add(f)
    return f
  }
  const eyeL = face(kit.mat.eye, 0.03, EYE_H, -0.055, 0.01)
  const eyeR = face(kit.mat.eye, 0.03, EYE_H, 0.055, 0.01)
  // Sobrancelhas um pouco à frente: erguidas não somem sob o cabelo.
  const browL = face(m.hair, 0.05, 0.011, -0.055, BROW_Y, -0.153)
  const browR = face(m.hair, 0.05, 0.011, 0.055, BROW_Y, -0.153)
  const mouth = face(kit.mat.eye, 0.05, 0.012, 0, -0.06)

  const arm = (side: number): { shoulder: Group; elbow: Group; hand: Group; fingers: Group; thumb: Group } => {
    const shoulder = joint(spine, side * 0.215, SHOULDER_Y, -0.02)
    part(shoulder, kit, m.shirt, 0.09, 0.3, 0.09, 0, -0.15, 0)
    const elbow = joint(shoulder, 0, -0.29, 0)
    part(elbow, kit, m.shirt, 0.08, 0.27, 0.08, 0, -0.135, 0)
    const hand = joint(elbow, 0, -0.28, 0)
    small(part(hand, kit, m.skin, 0.075, 0.07, 0.09, 0, -0.03, 0))
    const fingers = joint(hand, 0, -0.065, -0.012)
    detail(part(fingers, kit, m.skin, 0.07, 0.06, 0.042, 0, -0.03, 0))
    const thumb = joint(hand, -side * 0.042, -0.03, -0.03)
    detail(part(thumb, kit, m.skin, 0.026, 0.055, 0.026, 0, -0.025, 0))
    return { shoulder, elbow, hand, fingers, thumb }
  }
  const al = arm(-1)
  const ar = arm(1)

  return {
    pelvis, spine, torso, head, headMesh, eyeL, eyeR, browL, browR, mouth,
    shoulderL: al.shoulder, shoulderR: ar.shoulder, elbowL: al.elbow, elbowR: ar.elbow, handL: al.hand, handR: ar.hand,
    fingersL: al.fingers, fingersR: ar.fingers, thumbR: ar.thumb,
    legL: l.hip, legR: r.hip, kneeL: l.knee, kneeR: r.knee, footL: l.foot, footR: r.foot,
    details,
    smalls
  }
}

/**
 * Pose → juntas. `blink` 1 = olho aberto, 0 = fechado (multiplica o canal
 * eyes); `breath` −1..1 infla o peito de leve.
 */
export function applyPose(r: Rig, p: Pose, blink: number, breath: number): void {
  r.pelvis.position.set(0, PELVIS_Y + p[CH.pelvisY] + p[CH.hop], p[CH.pelvisZ])
  r.spine.rotation.set(-p[CH.lean], p[CH.twist], -p[CH.roll])
  const chest = 1 + 0.018 * breath
  r.torso.scale.set(chest, 1, chest)
  r.head.rotation.set(-p[CH.headPitch], p[CH.headYaw], -p[CH.headRoll])
  const sy = SHOULDER_Y + 0.05 * p[CH.shrug] + 0.004 * breath
  r.shoulderL.position.y = sy
  r.shoulderR.position.y = sy
  // Euler XYZ: ergue (X), gira no eixo do braço (Y) e abre (Z), nessa ordem.
  r.shoulderL.rotation.set(p[CH.armFwdL], -p[CH.twistL], -p[CH.armOutL])
  r.shoulderR.rotation.set(p[CH.armFwdR], p[CH.twistR], p[CH.armOutR])
  r.elbowL.rotation.x = p[CH.elbowL]
  r.elbowR.rotation.x = p[CH.elbowR]
  r.legL.rotation.x = p[CH.legL]
  r.legR.rotation.x = p[CH.legR]
  r.kneeL.rotation.x = -p[CH.kneeL]
  r.kneeR.rotation.x = -p[CH.kneeR]
  // Sola paralela ao chão (desfaz coxa − joelho) + o extra do passo.
  r.footL.rotation.x = -(p[CH.legL] - p[CH.kneeL]) + p[CH.footL]
  r.footR.rotation.x = -(p[CH.legR] - p[CH.kneeR]) + p[CH.footR]
  r.fingersL.rotation.x = 1.4 * p[CH.fingersL]
  r.fingersR.rotation.x = 1.4 * p[CH.fingersR]
  r.thumbR.rotation.x = 1.5 * p[CH.thumbR]
  r.mouth.scale.y = 0.012 + 0.05 * p[CH.mouth]
  const brow = p[CH.brows]
  const by = BROW_Y + 0.018 * Math.max(0, brow) - 0.006 * Math.max(0, -brow)
  r.browL.position.y = by
  r.browR.position.y = by
  const tilt = (brow < 0 ? 0.35 : 0.15) * brow
  r.browL.rotation.z = tilt
  r.browR.rotation.z = -tilt
  const open = Math.max(0.08, Math.min(1.3, p[CH.eyes] * blink))
  r.eyeL.scale.y = EYE_H * open
  r.eyeR.scale.y = EYE_H * open
}

/** Centro da cabeça no referencial do personagem (sem twist), a partir da pose. */
export function headLocal(p: Pose, out: { x: number; y: number; z: number }): void {
  const lean = p[CH.lean]
  out.x = HEAD_Y * Math.sin(p[CH.roll])
  out.y = PELVIS_Y + p[CH.pelvisY] + p[CH.hop] + HEAD_Y * Math.cos(lean) * Math.cos(p[CH.roll])
  out.z = p[CH.pelvisZ] - HEAD_Y * Math.sin(lean)
}
