// Fixture dos testes dos avatares (não é usado pelo app): abre os GLB de resources/office-agents SEM o GLTFLoader
// (no vitest ele não carrega as imagens embutidas). O chunk JSON e o BIN viram uma cena three com os mesmos nós,
// ossos e a malha com pele (só as posições), como o GLTFLoader monta — o prepareAvatar do app aceita igual.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bone, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Object3D, PropertyBinding, SkinnedMesh, Vector3 } from 'three'

export interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: Array<{ name?: string; children?: number[]; mesh?: number; skin?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; material?: number }> }>
  skins?: Array<{ joints: number[]; inverseBindMatrices?: number }>
  accessors: Array<{ bufferView?: number; byteOffset?: number; count: number; componentType: number; type: string }>
  bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>
  materials?: Array<{ pbrMetallicRoughness?: { metallicRoughnessTexture?: { index: number } }; extras?: { tintMeanLuma?: number } }>
}

/** Onde ficam os avatares do elenco (<papel>.glb). */
export const AGENTS_DIR = join(process.cwd(), 'resources', 'office-agents')

export function readGlb(path: string): { json: Gltf; bin: DataView } {
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
export function buildScene(g: Gltf, bin: DataView): { scene: Group; skinned: SkinnedMesh[]; jointNames: string[] } {
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
export function bindHeight(g: Gltf, bin: DataView, scene: Group): number {
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
