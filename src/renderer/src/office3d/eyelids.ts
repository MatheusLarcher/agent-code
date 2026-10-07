/**
 * Pálpebras do avatar GLB (o olho fechado de quem dorme). Os modelos do elenco
 * não têm blendshape nem osso de pálpebra — o olho é pintado na textura —,
 * então a pálpebra é uma malha à parte, montada UMA vez por modelo (agentRest
 * prepareAvatar):
 *
 * - eyeFind.ts acha os olhos pela cor da textura nas amostras da frente da cabeça;
 * - a pálpebra são os triângulos do próprio rosto em volta de cada olho, copiados
 *   1,5 mm para fora: acompanham a curva do rosto e, com a mesma pele (skinIndex/
 *   skinWeight) e o mesmo esqueleto, a cabeça — sem custo por quadro além do desenho;
 * - na cor da pele do modelo, com uma textura comum (elipse de borda suave e o
 *   risco dos cílios "◡") em projeção plana sobre cada olho.
 *
 * Fica escondida; agentAvatar.ts mostra só com o canal `eyes` da pose fechado
 * (eyeFind.lidsClosed: o cochilo). Sem canvas (testes) ou sem achar os olhos: sem pálpebra.
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  MeshStandardMaterial,
  SkinnedMesh,
  SRGBColorSpace,
  Uint16BufferAttribute,
  Vector3,
  type Bone,
  type Texture
} from 'three'
import { ENV_INTENSITY } from './agentTint'
import { findEyes, STRIDE, type Eye } from './eyeFind'

export const LIDS_NAME = 'avatar:lids'
/** A pálpebra cobre a elipse do olho com esta folga (a borda suave começa antes). */
const COVER_X = 1.4
const COVER_Y = 1.7
/** Quanto a pálpebra fica à frente do rosto (m). */
const LIFT = 0.0015
/** Pontos por lado de cada triângulo na amostragem da cor. */
const SUB = 6
/** Lado máximo da cópia da textura lida (px): basta para o olho e não pesa. */
const READ_MAX = 1024

const p = new Vector3()
const q = new Vector3()
const nrm = new Vector3()

let lidTex: CanvasTexture | null = null
let lidTexFailed = false

/** A textura comum das pálpebras: elipse branca de borda suave e o risco escuro dos cílios. Null sem canvas. */
function lidTexture(): CanvasTexture | null {
  if (lidTex || lidTexFailed) return lidTex
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = c?.getContext('2d')
  if (!c || !ctx) {
    lidTexFailed = true
    return null
  }
  c.width = 128
  c.height = 64
  ctx.filter = 'blur(3px)'
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.ellipse(64, 32, 54, 25, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.filter = 'blur(0.6px)'
  ctx.strokeStyle = '#3a2a22'
  ctx.lineWidth = 4.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(22, 33)
  ctx.quadraticCurveTo(64, 50, 106, 33)
  ctx.stroke()
  lidTex = new CanvasTexture(c)
  lidTex.colorSpace = SRGBColorSpace
  return lidTex
}

/** Os pixels da textura de cor (cópia reduzida), para ler a cor em cada UV. Null sem canvas ou sem imagem. */
function readPixels(map: Texture | null): { data: Uint8ClampedArray; w: number; h: number; flipY: boolean } | null {
  const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined
  if (!img || !img.width || typeof document === 'undefined') return null
  const k = Math.min(1, READ_MAX / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(img, 0, 0, w, h)
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, flipY: map!.flipY }
  } catch {
    return null
  }
}

/**
 * Monta as pálpebras de `mesh` (a malha com pele do modelo, já na pose de repouso alinhada e com as matrizes do mundo
 * em dia) com os ossos da cabeça `head` (a cabeça e os filhos). Null se não der (ver o cabeçalho).
 */
export function buildEyelids(mesh: SkinnedMesh, head: ReadonlySet<Bone>): SkinnedMesh | null {
  const g = mesh.geometry
  const pos = g.attributes.position
  const normal = g.attributes.normal
  const uv = g.attributes.uv
  const si = g.attributes.skinIndex
  const sw = g.attributes.skinWeight
  const mat = mesh.material as MeshStandardMaterial
  if (!pos || !normal || !uv || !si || !sw || Array.isArray(mat)) return null
  // A imagem da textura antes de qualquer canvas (sem ela, nos testes, nada a fazer).
  const px = readPixels(mat.map)
  const tex = px ? lidTexture() : null
  if (!px || !tex) return null
  const bones = mesh.skeleton.bones
  const isHead = new Uint8Array(pos.count)
  for (let v = 0; v < pos.count; v++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (head.has(bones[si.getComponent(v, k)])) w += sw.getComponent(v, k)
    isHead[v] = w > 0.5 ? 1 : 0
  }
  const world = mesh.matrixWorld
  const index = g.index
  const tris = (index ? index.count : pos.count) / 3
  const vert = (t: number, c: number): number => (index ? index.getX(t * 3 + c) : t * 3 + c)
  // Posição e normal de cada vértice da cabeça no referencial do personagem, pela pele (a mesma conta da GPU):
  // no Mixamo a escala da armadura (×0,01) está nas matrizes de bind, não na matriz da malha. A normal sai de um
  // ponto um pouco à frente, e daí também a escala local → personagem de cada vértice (para a folga da pálpebra).
  const wp = new Float32Array(pos.count * 3)
  const wn = new Float32Array(pos.count * 3)
  const ks = new Float32Array(pos.count)
  const e = 1e-3 / Math.max(1e-6, world.getMaxScaleOnAxis())
  for (let v = 0; v < pos.count; v++) {
    if (!isHead[v]) continue
    nrm.fromBufferAttribute(normal, v).normalize()
    p.fromBufferAttribute(pos, v).addScaledVector(nrm, e)
    mesh.applyBoneTransform(v, p).applyMatrix4(world)
    mesh.applyBoneTransform(v, q.fromBufferAttribute(pos, v)).applyMatrix4(world)
    p.sub(q)
    ks[v] = p.length() / e
    p.normalize()
    wp.set([q.x, q.y, q.z], v * 3)
    wn.set([p.x, p.y, p.z], v * 3)
  }
  const samples: number[] = []
  const color = (u: number, v: number, out: number[]): void => {
    const x = Math.min(px.w - 1, Math.floor((u - Math.floor(u)) * px.w))
    const fv = v - Math.floor(v)
    const y = Math.min(px.h - 1, Math.floor((px.flipY ? 1 - fv : fv) * px.h))
    const o = (y * px.w + x) * 4
    out.push(px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255)
  }
  const headTris: number[] = []
  for (let t = 0; t < tris; t++) {
    const a = vert(t, 0), b = vert(t, 1), c = vert(t, 2)
    if (!isHead[a] || !isHead[b] || !isHead[c]) continue
    headTris.push(t)
    for (let i = 0; i <= SUB; i++) {
      for (let j = 0; j <= SUB - i; j++) {
        const wa = i / SUB, wb = j / SUB, wc = 1 - wa - wb
        for (let k = 0; k < 3; k++) samples.push(wa * wp[a * 3 + k] + wb * wp[b * 3 + k] + wc * wp[c * 3 + k])
        for (let k = 0; k < 3; k++) samples.push(wa * wn[a * 3 + k] + wb * wn[b * 3 + k] + wc * wn[c * 3 + k])
        color(wa * uv.getX(a) + wb * uv.getX(b) + wc * uv.getX(c), wa * uv.getY(a) + wb * uv.getY(b) + wc * uv.getY(c), samples)
      }
    }
  }
  if (samples.length % STRIDE) return null
  const found = findEyes(samples)
  if (!found) return null
  const geo = lidGeometry(mesh, found.eyes, headTris, vert, wp, wn, ks)
  if (!geo) return null
  const m = new MeshStandardMaterial({
    color: new Color().setRGB(found.skin[0], found.skin[1], found.skin[2], SRGBColorSpace),
    map: tex,
    transparent: true,
    depthWrite: false,
    roughness: 0.75,
    metalness: 0,
    envMapIntensity: ENV_INTENSITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4
  })
  const lids = new SkinnedMesh(geo, m)
  lids.name = LIDS_NAME
  lids.visible = false
  lids.frustumCulled = false
  lids.castShadow = false
  lids.raycast = () => {}
  lids.position.copy(mesh.position)
  lids.quaternion.copy(mesh.quaternion)
  lids.scale.copy(mesh.scale)
  mesh.parent!.add(lids)
  lids.bind(mesh.skeleton, mesh.bindMatrix)
  return lids
}

/** Os triângulos do rosto em volta de cada olho, copiados um pouco para fora, com UV plano sobre o olho. */
function lidGeometry(mesh: SkinnedMesh, eyes: readonly Eye[], headTris: number[], vert: (t: number, c: number) => number, wp: Float32Array, wn: Float32Array, ks: Float32Array): BufferGeometry | null {
  const g = mesh.geometry
  const pos = g.attributes.position
  const normal = g.attributes.normal
  const si = g.attributes.skinIndex
  const sw = g.attributes.skinWeight
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [], W: number[] = []
  for (const t of headTris) {
    const vs = [vert(t, 0), vert(t, 1), vert(t, 2)]
    const cx = (wp[vs[0] * 3] + wp[vs[1] * 3] + wp[vs[2] * 3]) / 3
    const cy = (wp[vs[0] * 3 + 1] + wp[vs[1] * 3 + 1] + wp[vs[2] * 3 + 1]) / 3
    const cz = (wp[vs[0] * 3 + 2] + wp[vs[1] * 3 + 2] + wp[vs[2] * 3 + 2]) / 3
    const fz = (wn[vs[0] * 3 + 2] + wn[vs[1] * 3 + 2] + wn[vs[2] * 3 + 2]) / 3
    const e = eyes.find((e) => ((cx - e.x) / (e.rx * COVER_X * 1.15)) ** 2 + ((cy - e.y) / (e.ry * COVER_Y * 1.15)) ** 2 < 1 && Math.abs(cz - e.z) < 2 * e.rx)
    if (!e || -fz < 0.2) continue
    const rx = e.rx * COVER_X
    const ry = e.ry * COVER_Y
    for (const v of vs) {
      p.fromBufferAttribute(pos, v)
      nrm.fromBufferAttribute(normal, v).normalize()
      const lift = LIFT / Math.max(1e-6, ks[v])
      P.push(p.x + nrm.x * lift, p.y + nrm.y * lift, p.z + nrm.z * lift)
      N.push(nrm.x, nrm.y, nrm.z)
      U.push(0.5 + (wp[v * 3] - e.x) / (2 * rx), 0.5 + (wp[v * 3 + 1] - e.y) / (2 * ry))
      for (let k = 0; k < 4; k++) {
        I.push(si.getComponent(v, k))
        W.push(sw.getComponent(v, k))
      }
    }
  }
  if (!P.length) return null
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(P, 3))
  geo.setAttribute('normal', new Float32BufferAttribute(N, 3))
  geo.setAttribute('uv', new Float32BufferAttribute(U, 2))
  geo.setAttribute('skinIndex', new Uint16BufferAttribute(I, 4))
  geo.setAttribute('skinWeight', new Float32BufferAttribute(W, 4))
  return geo
}
