/**
 * Os avatares GLB de verdade (resources/office-agents/<papel>.glb, gerados pelo
 * pipeline de scripts/office-agents). Cada arquivo que existe é aberto SEM o
 * GLTFLoader (no vitest ele não carrega as imagens embutidas): o chunk JSON e o
 * BIN viram uma cena three com os mesmos nós, ossos e a malha com pele (só as
 * posições), e o prepareAvatar do app (agentRest.ts) prepara o esqueleto como
 * no escritório. Confere a malha com pele, os ossos pelo mapBones, a máscara
 * de tingimento (textura de metal/rugosidade + tintMeanLuma), o tamanho, a
 * altura de bind da ficha e medidas plausíveis de pernas e braços.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Bone, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Object3D, PropertyBinding, SkinnedMesh, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { mapBones } from './agentBones'
import { prepareAvatar } from './agentRest'

interface GltfNode {
  name?: string
  children?: number[]
  mesh?: number
  skin?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: GltfNode[]
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; material?: number }> }>
  skins?: Array<{ joints: number[]; inverseBindMatrices?: number }>
  accessors: Array<{ bufferView?: number; byteOffset?: number; count: number; componentType: number; type: string }>
  bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>
  materials?: Array<{ pbrMetallicRoughness?: { metallicRoughnessTexture?: { index: number } }; extras?: { tintMeanLuma?: number } }>
}

const DIR = join(process.cwd(), 'resources', 'office-agents')
/** Teto do arquivo de cada avatar (o instalador leva todos). */
const MAX_BYTES = 4 * 1024 * 1024

/** Papel → altura da ficha no bind (m) e se a roupa principal é tingível (a Central não tem máscara). */
const CAST: ReadonlyArray<{ role: string; height: number; tint: boolean }> = [
  { role: 'executor', height: 1.66, tint: true },
  { role: 'critico', height: 1.78, tint: true },
  { role: 'navegador-de-codigo', height: 1.63, tint: true },
  { role: 'memoria', height: 1.62, tint: true },
  { role: 'po', height: 1.66, tint: true },
  { role: 'vigia', height: 1.88, tint: true },
  { role: 'subagente', height: 1.72, tint: true },
  { role: 'principal', height: 1.83, tint: true },
  { role: 'central', height: 1.75, tint: false }
]

function readGlb(path: string): { json: Gltf; bin: DataView } {
  const buf = readFileSync(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('não é GLB')
  let json: Gltf | null = null
  let bin: DataView | null = null
  for (let off = 12; off + 8 <= buf.length; ) {
    const len = view.getUint32(off, true)
    const type = view.getUint32(off + 4, true)
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8')) as Gltf
    else if (type === 0x004e4942) bin = new DataView(buf.buffer, buf.byteOffset + off + 8, len)
    off += 8 + len
  }
  if (!json || !bin) throw new Error('GLB sem JSON ou BIN')
  return { json, bin }
}

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** Um accessor float (posições, matrizes inversas de bind), respeitando o byteStride. */
function floats(g: Gltf, bin: DataView, index: number): Float32Array {
  const a = g.accessors[index]
  if (a.componentType !== 5126 || a.bufferView === undefined) throw new Error(`accessor ${index} não é float`)
  const bv = g.bufferViews[a.bufferView]
  const n = WIDTH[a.type]
  const stride = bv.byteStride || n * 4
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const out = new Float32Array(a.count * n)
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = bin.getFloat32(base + i * stride + k * 4, true)
  return out
}

/** A cena como o GLTFLoader monta: junta = Bone, nó com malha e pele = SkinnedMesh, o resto = Object3D. */
function buildScene(g: Gltf, bin: DataView): { scene: Group; skinned: SkinnedMesh[]; jointNames: string[] } {
  const joints = new Set((g.skins ?? []).flatMap((s) => s.joints))
  const skinned: SkinnedMesh[] = []
  const objs = g.nodes.map((n, i) => {
    let o: Object3D
    if (n.mesh !== undefined && n.skin !== undefined) {
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(floats(g, bin, g.meshes[n.mesh].primitives[0].attributes.POSITION), 3))
      const mesh = new SkinnedMesh(geo)
      skinned.push(mesh)
      o = mesh
    } else o = joints.has(i) ? new Bone() : new Object3D()
    o.name = PropertyBinding.sanitizeNodeName(n.name ?? '')
    if (n.matrix) new Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale)
    else {
      if (n.translation) o.position.fromArray(n.translation)
      if (n.rotation) o.quaternion.fromArray(n.rotation)
      if (n.scale) o.scale.fromArray(n.scale)
    }
    return o
  })
  g.nodes.forEach((n, i) => n.children?.forEach((c) => objs[i].add(objs[c])))
  const scene = new Group()
  for (const i of g.scenes[g.scene ?? 0].nodes) scene.add(objs[i])
  scene.updateMatrixWorld(true)
  const jointNames = (g.skins?.[0]?.joints ?? []).map((j) => objs[j].name)
  return { scene, skinned, jointNames }
}

/** Altura da malha no bind como o glTF desenha a pele: junta × matriz inversa de bind (o nó da malha não conta). */
function bindHeight(g: Gltf, bin: DataView, scene: Group): number {
  const node = g.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined)
  const skin = g.skins![g.nodes[node].skin!]
  const joint = scene.getObjectByName(PropertyBinding.sanitizeNodeName(g.nodes[skin.joints[0]].name ?? ''))!
  const ibm = skin.inverseBindMatrices === undefined ? new Matrix4() : new Matrix4().fromArray(floats(g, bin, skin.inverseBindMatrices).subarray(0, 16))
  const m = joint.matrixWorld.clone().multiply(ibm)
  const pos = floats(g, bin, g.meshes[g.nodes[node].mesh!].primitives[0].attributes.POSITION)
  const box = new Box3()
  const p = new Vector3()
  for (let i = 0; i < pos.length; i += 3) box.expandByPoint(p.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m))
  return box.max.y - box.min.y
}

for (const { role, height, tint } of CAST) {
  const path = join(DIR, `${role}.glb`)
  describe.runIf(existsSync(path))(`avatar ${role}.glb`, () => {
    it('cabe no instalador e tem UMA malha com pele, com os ossos que o app move', () => {
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES)
      const { json, bin } = readGlb(path)
      const { skinned, jointNames } = buildScene(json, bin)
      expect(skinned).toHaveLength(1)
      const map = mapBones(jointNames)
      expect(map.missing).toEqual([])
      // Rig do Mixamo vem com dedos (a mão fecha); o do Meshy não tem.
      if (map.flavor === 'mixamo') expect(map.fingers).toBe(true)
    })

    it.runIf(tint)('traz a máscara da roupa: textura de metal/rugosidade e a luma média da roupa', () => {
      const { json } = readGlb(path)
      const node = json.nodes.find((n) => n.mesh !== undefined && n.skin !== undefined)!
      const mat = json.materials![json.meshes[node.mesh!].primitives[0].material ?? 0]
      expect(mat.pbrMetallicRoughness?.metallicRoughnessTexture).toBeDefined()
      const luma = mat.extras?.tintMeanLuma
      expect(typeof luma).toBe('number')
      expect(luma!).toBeGreaterThan(0)
      expect(luma!).toBeLessThan(1)
    })

    it('fica na altura da ficha e o prepareAvatar aceita, com pernas e braços de gente', () => {
      const { json, bin } = readGlb(path)
      const { scene } = buildScene(json, bin)
      expect(bindHeight(json, bin, scene)).toBeCloseTo(height, 1)
      const t = prepareAvatar(scene)
      if (typeof t === 'string') throw new Error(`prepareAvatar recusou ${role}: ${t}`)
      const m = t.metrics
      // Depois da escala pelas pernas (agentRest.legScale), em metros do boneco.
      expect(m.thigh).toBeGreaterThan(0.3)
      expect(m.thigh).toBeLessThan(0.6)
      expect(m.shin).toBeGreaterThan(0.3)
      expect(m.shin).toBeLessThan(0.6)
      expect(m.upperArm).toBeGreaterThan(0.15)
      expect(m.upperArm).toBeLessThan(0.4)
      expect(m.forearm).toBeGreaterThan(0.15)
      expect(m.forearm).toBeLessThan(0.4)
      // Braço (ombro → pulso) entre metade e 90% da perna (quadril → tornozelo).
      const arm = (m.upperArm + m.forearm) / (m.thigh + m.shin)
      expect(arm).toBeGreaterThan(0.5)
      expect(arm).toBeLessThan(0.9)
      expect(m.shoulderX).toBeGreaterThan(0.08)
      expect(m.shoulderX).toBeLessThan(0.3)
      expect(m.pelvisY).toBeGreaterThan(0.85)
      expect(m.pelvisY).toBeLessThan(1.2)
      expect(m.headH).toBeGreaterThan(0.05)
      expect(m.headH).toBeLessThan(0.2)
    })
  })
}
