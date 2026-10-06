/**
 * O avatar GLB de UM agente: clone do modelo (agentRest.ts) com esqueleto
 * próprio (SkeletonUtils.clone), material próprio (agentTint.ts: a roupa na
 * cor dele) e o retarget por quadro.
 *
 * Retarget: o boneco procedural (rig.ts) continua montado e posado, só
 * escondido; cada osso do modelo recebe a rotação da junta equivalente do
 * boneco no referencial do personagem (o repouso do boneco é tudo zero e o do
 * modelo foi alinhado a ele): mundo(osso) = junta · repouso(osso). O tronco
 * divide o giro entre Spine/Spine1/Spine2, o pescoço leva metade do da cabeça,
 * os dedos fecham pelo eixo rumo à palma e, sentado à mesa sem nada na mão, o
 * antebraço vira a palma para baixo (o teclado). A bacia vai à altura das
 * medidas do modelo (BodyMetrics). Nada aloca por quadro.
 */
import { Quaternion, Vector3, type Bone, type Color, type Group, type MeshStandardMaterial, type Object3D, type SkinnedMesh, type Texture } from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { CURL, SLOT, SLOTS, type AvatarTemplate } from './agentRest'
import { agentMaterial } from './agentTint'
import { CH, type BodyMetrics, type Pose } from './poses'
import type { Rig } from './rig'

const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
const DOWN = new Vector3(0, -1, 0)
const IDENT = new Quaternion()
const qa = new Quaternion()
const qb = new Quaternion()
const qc = new Quaternion()
const pos = new Vector3()
const dir = new Vector3()

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class AvatarBody {
  readonly root: Group
  readonly metrics: BodyMetrics
  /** Centro da cabeça (balões, confete, fumaça). */
  readonly headCenter: Object3D
  /** Encaixe dos objetos na mão direita: os eixos da mão do boneco (dedos −Y, frente −Z). */
  readonly socketR: Object3D
  readonly material: MeshStandardMaterial
  private readonly meshes: SkinnedMesh[] = []
  private readonly bones: Bone[]
  private readonly cur: Quaternion[]
  private readonly slot = Array.from({ length: SLOTS }, () => new Quaternion())
  private readonly curl = new Float32Array(5)
  private readonly hips: number
  /** Quanto as palmas estão viradas para baixo (0..1), suavizado. */
  private pron = 0

  constructor(private readonly t: AvatarTemplate, color: Color, env: Texture | null, charKey: string) {
    this.root = cloneSkinned(t.root) as Group
    this.metrics = t.metrics
    this.material = agentMaterial(firstMaterial(t.root), color, env)
    const byName = new Map<string, Object3D>()
    this.root.traverse((o) => {
      byName.set(o.name, o)
      if ((o as SkinnedMesh).isSkinnedMesh) {
        const m = o as SkinnedMesh
        m.material = this.material
        m.userData.charKey = charKey
        // O clique usa o boneco escondido (mesma pose, primitivas baratas): o raio na malha com pele custaria caro.
        m.raycast = () => {}
        this.meshes.push(m)
      }
    })
    this.bones = t.order.map((n) => byName.get(n) as Bone)
    this.cur = t.order.map(() => new Quaternion())
    this.hips = t.order.indexOf(t.map.bones.hips!)
    this.headCenter = byName.get('avatar:headCenter')!
    this.socketR = byName.get('avatar:socketR')!
  }

  /** Sombra só PERTO (como o boneco). */
  setLod(level: number): void {
    for (const m of this.meshes) m.castShadow = level === 0
  }

  /** Brilho do monitor no corpo (o emissive do boneco era só na pele). */
  setGlow(color: number, intensity: number): void {
    this.material.emissive.setHex(color)
    this.material.emissiveIntensity = intensity * 0.6
  }

  /**
   * Copia a pose do boneco `r` (já com applyPose) para o esqueleto. `pronate`
   * 0..1: sentado à mesa sem objeto na mão (as palmas descem para o teclado);
   * `hold`: quanto os dedos da direita fecham no objeto (0 sem objeto).
   */
  apply(r: Rig, p: Pose, pronate: number, hold: number, dt: number): void {
    const s = this.slot
    s[SLOT.none].identity()
    s[SLOT.spine].copy(r.spine.quaternion)
    // O boneco gira o tronco inteiro na bacia: a coluna de baixo já leva quase tudo
    // (com 1/3 e 2/3 o recostado no sofá ficava ereto e só o peito deitava).
    s[SLOT.spineA].slerpQuaternions(IDENT, r.spine.quaternion, 0.65)
    s[SLOT.spineB].slerpQuaternions(IDENT, r.spine.quaternion, 0.88)
    s[SLOT.head].multiplyQuaternions(r.spine.quaternion, r.head.quaternion)
    s[SLOT.neck].multiplyQuaternions(r.spine.quaternion, qa.slerpQuaternions(IDENT, r.head.quaternion, 0.5))
    const k = dt > 0 ? Math.min(1, dt * 6) : 1
    this.pron += (pronate - this.pron) * k
    this.arm(s, r.spine.quaternion, r.shoulderL.quaternion, r.elbowL.quaternion, p[CH.shrug], -1)
    this.arm(s, r.spine.quaternion, r.shoulderR.quaternion, r.elbowR.quaternion, p[CH.shrug], 1)
    s[SLOT.legL].copy(r.legL.quaternion)
    s[SLOT.kneeL].multiplyQuaternions(r.legL.quaternion, r.kneeL.quaternion)
    s[SLOT.footL].multiplyQuaternions(s[SLOT.kneeL], r.footL.quaternion)
    s[SLOT.legR].copy(r.legR.quaternion)
    s[SLOT.kneeR].multiplyQuaternions(r.legR.quaternion, r.kneeR.quaternion)
    s[SLOT.footR].multiplyQuaternions(s[SLOT.kneeR], r.footR.quaternion)
    const c = this.curl
    c[CURL.fingersL] = p[CH.fingersL]
    c[CURL.fingersR] = Math.max(p[CH.fingersR], hold)
    c[CURL.thumbL] = 0.6 * p[CH.fingersL]
    c[CURL.thumbR] = p[CH.thumbR] + 0.4 * c[CURL.fingersR]
    this.pose(p)
  }

  /** Clavícula (ombros erguidos), braço, antebraço e mão de um lado (`side` −1 esquerdo, +1 direito). */
  private arm(s: Quaternion[], spine: Quaternion, shoulder: Quaternion, elbow: Quaternion, shrug: number, side: -1 | 1): void {
    const L = side < 0
    s[L ? SLOT.clavL : SLOT.clavR].multiplyQuaternions(spine, qa.setFromAxisAngle(Z, side * 0.3 * shrug))
    const arm = s[L ? SLOT.armL : SLOT.armR].multiplyQuaternions(spine, shoulder)
    const fore = qb.multiplyQuaternions(arm, elbow)
    // Antebraço para a frente (o teclado): a palma, que no repouso olha para dentro, desce.
    dir.copy(DOWN).applyQuaternion(fore)
    const turn = this.pron * smoothstep(0.25, 0.7, -dir.z) * (L ? -Math.PI / 2 : Math.PI / 2)
    s[L ? SLOT.foreL : SLOT.foreR].multiplyQuaternions(fore, qc.setFromAxisAngle(Y, turn * 0.5))
    s[L ? SLOT.handL : SLOT.handR].multiplyQuaternions(fore, qc.setFromAxisAngle(Y, turn))
  }

  /** Ossos de pai para filho: mundo(osso) = slot · repouso (ou o pai · repouso local, quem não tem slot). */
  private pose(p: Pose): void {
    const t = this.t
    const cur = this.cur
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i]
      const pi = t.parent[i]
      const parentQ = pi < 0 ? t.rootParent : cur[pi]
      const d = t.drive[i]
      if (d.slot < 0) {
        cur[i].multiplyQuaternions(parentQ, bone.quaternion)
        continue
      }
      const want = cur[i].multiplyQuaternions(this.slot[d.slot], d.curl ? qa.setFromAxisAngle(d.axis, d.curlK * this.curl[d.curl]) : IDENT)
      want.multiply(t.rest[i])
      bone.quaternion.copy(qb.copy(parentQ).invert()).multiply(want)
    }
    // A bacia: altura e avanço da pose nas medidas do modelo (o x de repouso fica).
    pos.set(t.hipsRest.x, this.metrics.pelvisY + p[CH.pelvisY] + p[CH.hop], t.hipsRest.z + p[CH.pelvisZ]).applyMatrix4(t.hipsParentInv)
    this.bones[this.hips].position.copy(pos)
  }

  dispose(): void {
    this.root.removeFromParent()
    for (const m of this.meshes) m.skeleton.dispose()
    this.material.dispose()
  }
}

function firstMaterial(root: Object3D): MeshStandardMaterial {
  let found: MeshStandardMaterial | null = null
  root.traverse((o) => {
    if (!found && (o as SkinnedMesh).isSkinnedMesh) found = (o as SkinnedMesh).material as MeshStandardMaterial
  })
  return found!
}
