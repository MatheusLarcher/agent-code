/**
 * Corpo articulado do personagem 3D (three): quadril → tronco → pescoço/cabeça
 * e ombros → cotovelos → mãos (palma, dedos, polegar); quadril → coxas →
 * joelhos → pés. `applyPose` copia os canais de poses.ts para as juntas sem
 * alocar nada. Rosto com olhos (piscam), sobrancelhas e boca — os olhos e a
 * boca são UMA InstancedMesh (o mesmo material) e as sobrancelhas outra: duas
 * chamadas por boneco em vez de cinco.
 *
 * Proporções de adulto (~1,80 m, BODY em poses.ts) com as peças torneadas de
 * bodyGeo.ts (tronco, quadril, membros que afinam, cabeça com nariz e
 * orelhas, sapato, seis cortes de cabelo). O antebraço é da manga comprida
 * (camisa) ou curta (pele). Malhas de detalhe (olhos, sobrancelhas, boca,
 * dedos, polegares) levam userData.lod = 'detail' (somem no LOD médio); mãos,
 * pescoço e sapatos levam 'small' (somem no LOD longe).
 */
import { Group, InstancedMesh, Mesh, Object3D, type BufferGeometry, type Material } from 'three'
import type { HairStyle } from './bodyGeo'
import type { Kit } from './kit'
import { BODY, CH, SHIN, THIGH, type Pose } from './poses'

export const PELVIS_Y = BODY.pelvisY
export const SHOULDER_Y = BODY.shoulderY
export const HEAD_Y = BODY.headY
export const HEAD_RADIUS = BODY.headH
const EYE_H = 0.02
const BROW_Y = 0.034
/** Instâncias do rosto: olhos e boca (cor dos olhos) e as duas sobrancelhas (cor do cabelo). */
const EYE_L = 0
const EYE_R = 1
const MOUTH = 2
const EYE_X = 0.031
const FACE_Z = -0.093
const MOUTH_Z = -0.086
const BROW_Z = -0.097
const faceDummy = new Object3D()

export interface Rig {
  pelvis: Group
  spine: Group
  torso: Mesh
  head: Group
  headMesh: Mesh
  /** Olhos e boca (instâncias EYE_L, EYE_R, MOUTH) e as duas sobrancelhas. */
  face: InstancedMesh
  brows: InstancedMesh
  /** O último rosto aplicado (abertura dos olhos, boca, altura e giro das sobrancelhas): só sobe o que mudou. */
  faceState: Float32Array
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

/** O que muda de boneco para boneco além das cores. */
export interface RigStyle {
  hair: HairStyle
  /** Manga comprida (o antebraço é da camisa) ou curta (da pele). */
  longSleeves: boolean
  /** Ombros e tronco (0,94 estreito … 1,06 largo). */
  build: number
}

function piece(parent: Group, geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(geo, mat)
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
export function buildRig(kit: Kit, root: Group, m: RigMaterials, style: RigStyle = { hair: 'hairShort', longSleeves: false, build: 1 }): Rig {
  const g = kit.geo
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
  piece(pelvis, g.hips, m.pants).scale.set(style.build, 1, 1)

  const leg = (side: number): { hip: Group; knee: Group; foot: Group } => {
    const hip = joint(pelvis, side * BODY.hipX, -BODY.hipDrop, 0)
    piece(hip, g.thigh, m.pants)
    const knee = joint(hip, 0, -THIGH, 0)
    piece(knee, g.shin, m.pants)
    const foot = joint(knee, 0, -SHIN, 0)
    small(piece(foot, g.shoe, kit.mat.shoe))
    return { hip, knee, foot }
  }
  const l = leg(-1)
  const r = leg(1)

  const spine = joint(pelvis, 0, 0, 0)
  const torso = piece(spine, g.torso, m.shirt)
  torso.scale.set(style.build, 1, 1)
  torso.castShadow = true
  small(piece(spine, g.neck, m.skin, 0, SHOULDER_Y + 0.11, 0.005))

  const head = joint(spine, 0, HEAD_Y, 0)
  const headMesh = piece(head, g.head, m.skin)
  headMesh.castShadow = true
  piece(head, g[style.hair], m.hair)
  const face = detail(new InstancedMesh(g.box, kit.mat.eye, 3)) as InstancedMesh
  // Sobrancelhas um pouco à frente: erguidas não somem sob o cabelo.
  const brows = detail(new InstancedMesh(g.box, m.hair, 2)) as InstancedMesh
  head.add(face, brows)
  const faceState = new Float32Array([-1, -1, -1, -1])
  placeFace(face, brows, faceState, 1, 0.008, BROW_Y, 0)
  // A esfera de culling cobre o rosto inteiro (as instâncias mexem pouco).
  for (const im of [face, brows]) {
    im.computeBoundingSphere()
    im.boundingSphere!.radius += 0.03
  }

  const sleeve = style.longSleeves ? m.shirt : m.skin
  const arm = (side: number): { shoulder: Group; elbow: Group; hand: Group; fingers: Group; thumb: Group } => {
    const shoulder = joint(spine, side * BODY.shoulderX * style.build, SHOULDER_Y, 0)
    piece(shoulder, g.upperArm, m.shirt)
    const elbow = joint(shoulder, 0, -BODY.upperArm, 0)
    piece(elbow, g.forearm, sleeve)
    const hand = joint(elbow, 0, -BODY.forearm, 0)
    small(piece(hand, g.hand, m.skin))
    const fingers = joint(hand, 0, -0.078, -0.002)
    detail(piece(fingers, g.fingers, m.skin))
    const thumb = joint(hand, -side * 0.036, -0.022, -0.014)
    detail(piece(thumb, g.thumb, m.skin))
    return { shoulder, elbow, hand, fingers, thumb }
  }
  const al = arm(-1)
  const ar = arm(1)

  return {
    pelvis, spine, torso, head, headMesh, face, brows, faceState,
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
  r.torso.scale.z = chest
  r.head.rotation.set(-p[CH.headPitch], p[CH.headYaw], -p[CH.headRoll])
  const sy = SHOULDER_Y + 0.04 * p[CH.shrug] + 0.004 * breath
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
  const brow = p[CH.brows]
  const by = BROW_Y + 0.012 * Math.max(0, brow) - 0.004 * Math.max(0, -brow)
  const tilt = (brow < 0 ? 0.35 : 0.15) * brow
  const open = Math.max(0.08, Math.min(1.3, p[CH.eyes] * blink))
  placeFace(r.face, r.brows, r.faceState, open, 0.008 + 0.034 * p[CH.mouth], by, tilt)
}

function setPart(im: InstancedMesh, i: number, w: number, h: number, x: number, y: number, z: number, rz: number): void {
  faceDummy.position.set(x, y, z)
  faceDummy.rotation.set(0, 0, rz)
  faceDummy.scale.set(w, h, 0.01)
  faceDummy.updateMatrix()
  im.setMatrixAt(i, faceDummy.matrix)
}

/** Olhos (abertura `open`), boca (altura `mouthH`) e sobrancelhas (altura `by`, giro `tilt`): só o que mudou sobe. */
function placeFace(face: InstancedMesh, brows: InstancedMesh, st: Float32Array, open: number, mouthH: number, by: number, tilt: number): void {
  if (st[0] !== open || st[1] !== mouthH) {
    st[0] = open
    st[1] = mouthH
    setPart(face, EYE_L, 0.02, EYE_H * open, -EYE_X, 0.012, FACE_Z, 0)
    setPart(face, EYE_R, 0.02, EYE_H * open, EYE_X, 0.012, FACE_Z, 0)
    setPart(face, MOUTH, 0.034, mouthH, 0, -0.05, MOUTH_Z, 0)
    face.instanceMatrix.needsUpdate = true
  }
  if (st[2] !== by || st[3] !== tilt) {
    st[2] = by
    st[3] = tilt
    setPart(brows, 0, 0.032, 0.008, -EYE_X, by, BROW_Z, tilt)
    setPart(brows, 1, 0.032, 0.008, EYE_X, by, BROW_Z, -tilt)
    brows.instanceMatrix.needsUpdate = true
  }
}

/** Centro da cabeça no referencial do personagem (sem twist), a partir da pose. */
export function headLocal(p: Pose, out: { x: number; y: number; z: number }): void {
  const lean = p[CH.lean]
  out.x = HEAD_Y * Math.sin(p[CH.roll])
  out.y = PELVIS_Y + p[CH.pelvisY] + p[CH.hop] + HEAD_Y * Math.cos(lean) * Math.cos(p[CH.roll])
  out.z = p[CH.pelvisZ] - HEAD_Y * Math.sin(lean)
}
