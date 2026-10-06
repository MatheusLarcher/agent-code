/**
 * Preparo do avatar GLB, uma vez por modelo (agentModels.ts): a cena do GLTF
 * vai para um contêiner girado 180° (o modelo olha para +Z; o escritório, para
 * −Z) e o esqueleto é ALINHADO ao repouso das poses (poses.ts com tudo zero):
 * tronco, pescoço e cabeça na vertical, braços, antebraços, mãos e pernas
 * retos para baixo, pé para a frente. O alinhamento mira cada osso pela
 * direção osso → filho no referencial do personagem (`aim`), sem depender dos
 * eixos locais do rig. Daí saem as medidas (agentMetrics.ts), a rotação de
 * repouso de cada osso, o eixo em que cada dedo fecha (rumo à palma), o
 * centro da cabeça e o encaixe dos objetos na mão direita.
 */
import { Box3, Group, Object3D, Quaternion, Vector3, type Bone, type Matrix4, type SkinnedMesh } from 'three'
import { mapBones, type AvatarJoint, type BoneMap, type Side } from './agentBones'
import { metricsFromSkeleton, type Vec3 } from './agentMetrics'
import type { BodyMetrics } from './poses'

/** De onde vem a rotação de cada osso (agentAvatar.ts monta estas a cada quadro). */
export const SLOT = {
  none: 0, spineA: 1, spineB: 2, spine: 3, neck: 4, head: 5,
  clavL: 6, armL: 7, foreL: 8, handL: 9, clavR: 10, armR: 11, foreR: 12, handR: 13,
  legL: 14, kneeL: 15, footL: 16, legR: 17, kneeR: 18, footR: 19
} as const
export const SLOTS = 20

/** O valor que fecha um dedo: os quatro dedos de cada mão e os polegares. */
export const CURL = { none: 0, fingersL: 1, fingersR: 2, thumbL: 3, thumbR: 4 } as const

export interface BoneDrive {
  /** -1: segue o pai (mantém a rotação de repouso relativa a ele). */
  slot: number
  curl: number
  /** Fração do fechamento acumulada até esta falange (rad por unidade do canal). */
  curlK: number
  axis: Vector3
}

export interface AvatarTemplate {
  /** Contêiner (giro de 180°) com a cena do GLTF, já no repouso alinhado. */
  root: Group
  map: BoneMap
  metrics: BodyMetrics
  /** Ossos em ordem pai → filho (nomes) e o índice do pai na mesma lista (-1: o pai não é osso). */
  order: string[]
  parent: Int16Array
  /** Rotação de repouso de cada osso no referencial do personagem. */
  rest: Quaternion[]
  drive: BoneDrive[]
  /** Rotação (personagem) do pai do 1º osso e a matriz que leva o personagem ao espaço local do pai da bacia. */
  rootParent: Quaternion
  hipsParentInv: Matrix4
  hipsRest: Vector3
}

const UP = new Vector3(0, 1, 0)
const DOWN = new Vector3(0, -1, 0)
const v = new Vector3()
const w = new Vector3()
const q = new Quaternion()
const qp = new Quaternion()
const delta = new Quaternion()

function worldPos(o: Object3D): Vector3 {
  return o.getWorldPosition(new Vector3())
}

/** Gira `bone` para (bone → child) apontar para `dir` (referencial do contêiner, que não tem pai). */
function aim(root: Object3D, bone: Object3D, child: Object3D, dir: Vector3): void {
  root.updateMatrixWorld(true)
  bone.getWorldPosition(v)
  child.getWorldPosition(w)
  const cur = w.sub(v)
  if (cur.lengthSq() < 1e-10) return
  delta.setFromUnitVectors(cur.normalize(), dir)
  bone.getWorldQuaternion(q)
  bone.parent!.getWorldQuaternion(qp)
  bone.quaternion.copy(qp.invert().multiply(delta).multiply(q))
}

const vec = (p: Vector3): Vec3 => [p.x, p.y, p.z]

/** Prepara o GLB; devolve o motivo (texto) se o esqueleto não serve. */
export function prepareAvatar(scene: Object3D): AvatarTemplate | string {
  const root = new Group()
  root.name = 'agent-avatar'
  root.rotation.y = Math.PI
  root.add(scene)
  root.updateMatrixWorld(true)
  const bones = new Map<string, Bone>()
  const meshes: SkinnedMesh[] = []
  scene.traverse((o) => {
    if ((o as Bone).isBone) bones.set(o.name, o as Bone)
    if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh)
  })
  if (!meshes.length) return 'o modelo não tem malha com esqueleto'
  const map = mapBones([...bones.keys()])
  if (map.missing.length) return `faltam ossos: ${map.missing.join(', ')}`
  const b = (j: AvatarJoint): Bone | null => (map.bones[j] ? bones.get(map.bones[j]!)! : null)
  const must = (j: AvatarJoint): Bone => b(j)!

  // A sola: o ponto mais baixo da malha na pose de bind, antes de mexer (na pose de bind a malha com pele é a
  // própria geometria: a caixa dela vale, sem calcular a pele de 20 mil vértices na CPU).
  const bind = bindBox(meshes)
  const floor = bind.min.y
  const soleDown = Math.max(0.02, worldPos(must('footL')).y - floor)
  const toeBind = { L: b('toeL') ? worldPos(b('toeL')!).sub(worldPos(must('footL'))) : null, R: b('toeR') ? worldPos(b('toeR')!).sub(worldPos(must('footR'))) : null }

  // Repouso alinhado: de cima para baixo na hierarquia (o pai antes do filho).
  const chain: Array<[AvatarJoint, AvatarJoint, Vector3]> = [
    ['hips', 'spine0', UP], ['spine0', 'spine1', UP], ['spine1', 'spine2', UP], ['spine0', 'spine2', UP], ['spine2', 'neck', UP],
    ['neck', 'head', UP], ['head', 'headTop', UP]
  ]
  for (const s of ['L', 'R'] as const) {
    chain.push([`upLeg${s}`, `leg${s}`, DOWN], [`leg${s}`, `foot${s}`, DOWN], [`arm${s}`, `forearm${s}`, DOWN], [`forearm${s}`, `hand${s}`, DOWN], [`hand${s}`, `middle1${s}`, DOWN])
  }
  for (const [from, to, dir] of chain) {
    const a = b(from)
    const c = b(to)
    // spine0 → spine2 só quando não há spine1 (o Meshy e o Mixamo têm; outro rig pode não ter).
    if (!a || !c || (from === 'spine0' && to === 'spine2' && b('spine1'))) continue
    if (from === 'spine1' && !b('spine1')) continue
    aim(root, a, c, dir)
  }
  for (const s of ['L', 'R'] as const) {
    const toe = b(`toe${s}`)
    const d = toeBind[s]
    if (toe && d) aim(root, must(`foot${s}`), toe, new Vector3(0, d.y, -Math.hypot(d.x, d.z)).normalize())
  }
  root.updateMatrixWorld(true)

  const P = (j: AvatarJoint): Vec3 => vec(worldPos(must(j)))
  const top = b('headTop') ?? null
  const toeEnd = b('toeEndL')
  const toe = toeEnd ?? b('toeL')
  const metrics = metricsFromSkeleton(
    {
      hips: P('hips'), upLegL: P('upLegL'), upLegR: P('upLegR'), legL: P('legL'), footL: P('footL'), armL: P('armL'), armR: P('armR'),
      forearmL: P('forearmL'), handL: P('handL'), head: P('head'),
      // Sem o HeadTop_End (o FBXLoader descarta os ossos de ponta): o alto da malha no bind.
      headTop: top ? vec(worldPos(top)) : [P('head')[0], bind.max.y, P('head')[2]],
      toe: toe ? vec(worldPos(toe)) : null, toeIsBase: !toeEnd
    },
    soleDown
  )

  // Centro da cabeça (balões, confete, HUD) e o encaixe dos objetos na mão (eixos do personagem no repouso).
  const head = must('head')
  const center = worldPos(head).setY(worldPos(head).y + metrics.headH)
  const headCenter = new Object3D()
  headCenter.name = 'avatar:headCenter'
  head.add(headCenter)
  headCenter.position.copy(head.worldToLocal(center))
  const hand = must('handR')
  const socket = new Object3D()
  socket.name = 'avatar:socketR'
  hand.add(socket)
  socket.quaternion.copy(hand.getWorldQuaternion(new Quaternion()).invert())
  root.updateMatrixWorld(true)

  const order: string[] = []
  const parent: number[] = []
  const rest: Quaternion[] = []
  const index = new Map<Object3D, number>()
  scene.traverse((o) => {
    if (!(o as Bone).isBone) return
    index.set(o, order.length)
    parent.push(index.get(o.parent!) ?? -1)
    order.push(o.name)
    rest.push(o.getWorldQuaternion(new Quaternion()))
  })
  const hips = must('hips')
  const hipsParentInv = hips.parent!.matrixWorld.clone().invert()
  const rootParent = (bones.get(order[0])!.parent ?? root).getWorldQuaternion(new Quaternion())
  const drive = order.map((name) => driveOf(name, map, bones))
  // A esfera do frustum: a da geometria (bind), com folga para sentar e erguer os braços (uma vez; o clone copia).
  for (const m of meshes) {
    const g = m.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    if (!g.boundingSphere) g.computeBoundingSphere()
    m.boundingBox = g.boundingBox!.clone()
    m.boundingSphere = g.boundingSphere!.clone()
    m.boundingSphere.radius *= 1.6
  }
  return { root, map, metrics, order, parent: Int16Array.from(parent), rest, drive, rootParent, hipsParentInv, hipsRest: worldPos(hips) }
}

/** Caixa das malhas na pose de bind (a geometria levada ao mundo pela matriz delas). */
function bindBox(meshes: SkinnedMesh[]): Box3 {
  const box = new Box3()
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld))
  }
  return box
}

/** O que move o osso `name`: o slot da junta do boneco e, nos dedos, o eixo e quanto fecha. */
function driveOf(name: string, map: BoneMap, bones: Map<string, Bone>): BoneDrive {
  const joint = (Object.keys(map.bones) as AvatarJoint[]).find((j) => map.bones[j] === name)
  const none: BoneDrive = { slot: -1, curl: CURL.none, curlK: 0, axis: new Vector3() }
  if (!joint) return none
  const fixed: Partial<Record<AvatarJoint, number>> = {
    hips: SLOT.none, spine0: map.bones.spine1 ? SLOT.spineA : SLOT.spineB, spine1: SLOT.spineB, spine2: SLOT.spine, neck: SLOT.neck, head: SLOT.head,
    shoulderL: SLOT.clavL, armL: SLOT.armL, forearmL: SLOT.foreL, handL: SLOT.handL,
    shoulderR: SLOT.clavR, armR: SLOT.armR, forearmR: SLOT.foreR, handR: SLOT.handR,
    upLegL: SLOT.legL, legL: SLOT.kneeL, footL: SLOT.footL, upLegR: SLOT.legR, legR: SLOT.kneeR, footR: SLOT.footR
  }
  if (fixed[joint] !== undefined) return { ...none, slot: fixed[joint]! }
  const m = /^(thumb|index|middle|ring|pinky)([123])([LR])$/.exec(joint)
  if (!m) return none
  const side = m[3] as Side
  const k = Number(m[2])
  const thumb = m[1] === 'thumb'
  const axis = curlAxis(map, bones, side, m[1], k)
  if (!axis) return none
  // Quanto a falange gira, somado desde a base (rad por unidade do canal): o dedo fecha em espiral.
  const cum = thumb ? [0.45, 1.0, 1.7][k - 1] : [1.1, 2.6, 3.6][k - 1]
  const curl = thumb ? (side === 'L' ? CURL.thumbL : CURL.thumbR) : side === 'L' ? CURL.fingersL : CURL.fingersR
  return { slot: side === 'L' ? SLOT.handL : SLOT.handR, curl, curlK: cum, axis }
}

/**
 * Eixo em que o dedo fecha (referencial do personagem, no repouso): o dedo gira
 * rumo à palma. A palma sai da própria mão: dedos (pulso → médio) × lado do
 * polegar (mínimo → indicador), com o sinal da mão — não depende dos eixos do rig.
 */
function curlAxis(map: BoneMap, bones: Map<string, Bone>, s: Side, finger: string, k: number): Vector3 | null {
  const at = (j: string): Vector3 | null => {
    const n = map.bones[j as AvatarJoint]
    return n ? worldPos(bones.get(n)!) : null
  }
  const hand = at(`hand${s}`)
  const mid = at(`middle1${s}`) ?? at(`index1${s}`)
  const index = at(`index1${s}`)
  const outer = at(`pinky1${s}`) ?? at(`ring1${s}`)
  const base = at(`${finger}${k}${s}`)
  const next = at(`${finger}${k + 1}${s}`) ?? (k > 1 ? at(`${finger}${k}${s}`) : null)
  if (!hand || !mid || !index || !outer || !base) return null
  const fingers = mid.clone().sub(hand).normalize()
  const side = index.clone().sub(outer).normalize()
  const palm = fingers.clone().cross(side).normalize().multiplyScalar(s === 'L' ? 1 : -1)
  // Direção da falange (a última usa a do meio): a ponta da anterior até ela.
  const prev = at(`${finger}${k - 1}${s}`)
  const dir = next && next.distanceToSquared(base) > 1e-10 ? next.clone().sub(base) : prev ? base.clone().sub(prev) : fingers.clone()
  const axis = dir.normalize().cross(palm)
  return axis.lengthSq() < 1e-8 ? null : axis.normalize()
}
