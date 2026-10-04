/**
 * Peças do desenho do escritório (three): caixa, cilindro, disco, planta e
 * InstancedMesh a partir de "lugares", e a FUSÃO da mobília estática de uma
 * zona por material (`mergeStatic`).
 *
 * Fusão: tudo o que a zona desenha como Mesh estática vai para um grupo
 * `statics`; no fim, as malhas com o mesmo material, a mesma sombra e a mesma
 * marca de LOD ('detail' / 'small', herdada do ancestral marcado) viram UMA
 * malha (BufferGeometryUtils.mergeGeometries) no grupo da zona. Assim a zona
 * desenha poucas chamadas e o culling/LOD por zona continua valendo (nunca se
 * funde o escritório inteiro). O que muda depois (telas, cadeiras, porta,
 * luminárias, céu) fica fora de `statics`.
 */
import { Color, Group, InstancedMesh, Matrix4, Mesh, Object3D, type BufferGeometry, type Material } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Kit } from './kit'
import { tagLod, type LodTag } from './roomLod'

export type Place = { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry?: number; rx?: number; rz?: number; color?: Color }

const dummy = new Object3D()

export function box(kit: Kit, parent: Object3D, mat: Material, w: number, h: number, d: number, x: number, y: number, z: number, cast = false): Mesh {
  const m = new Mesh(kit.geo.box, mat)
  m.scale.set(w, h, d)
  m.position.set(x, y, z)
  m.castShadow = cast
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Cilindro de diâmetro `d` e altura `h` com a base em `y0`. */
export function cyl(kit: Kit, parent: Object3D, mat: Material, d: number, h: number, x: number, y0: number, z: number, cast = false): Mesh {
  const m = new Mesh(kit.geo.cyl, mat)
  m.scale.set(d, h, d)
  m.position.set(x, y0 + h / 2, z)
  m.castShadow = cast
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Disco no chão (tapete): raios rx × rz, em `y`. */
export function disc(kit: Kit, parent: Object3D, mat: Material, rx: number, rz: number, x: number, y: number, z: number): Mesh {
  const m = new Mesh(kit.geo.disc, mat)
  m.rotation.x = -Math.PI / 2
  m.scale.set(rx, rz, 1)
  m.position.set(x, y, z)
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Plano deitado no chão (faixa, placa): w × d, em `y`, girado `ry`. */
export function flat(kit: Kit, parent: Object3D, mat: Material, w: number, d: number, x: number, y: number, z: number, ry = 0): Mesh {
  const m = new Mesh(kit.geo.plane, mat)
  // YXZ: deita o plano (X) e depois gira em torno da vertical (Y).
  m.rotation.order = 'YXZ'
  m.rotation.set(-Math.PI / 2, ry, 0)
  m.scale.set(w, d, 1)
  m.position.set(x, y, z)
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Planta de vaso: vaso, terra e folhas (folhas são detalhe; a planta some no LONGE). */
export function plant(kit: Kit, parent: Object3D, x: number, y: number, z: number, scale: number): Group {
  const p = tagLod(new Group(), 'small')
  p.position.set(x, y, z)
  p.scale.setScalar(scale)
  const pot = new Mesh(kit.geo.cyl, kit.mat.pot)
  pot.scale.set(0.34, 0.36, 0.3)
  pot.position.y = 0.18
  pot.castShadow = true
  pot.receiveShadow = true
  const soil = tagLod(new Mesh(kit.geo.cyl, kit.mat.soil), 'detail')
  soil.scale.set(0.3, 0.02, 0.3)
  soil.position.y = 0.36
  p.add(pot, soil)
  for (const [sx, sy, x2, y2, z2, dark] of [
    [0.5, 0.56, 0, 0.66, 0, false],
    [0.36, 0.42, 0.14, 0.92, 0.05, true],
    [0.32, 0.36, -0.13, 0.86, -0.08, true],
    [0.3, 0.3, 0.02, 1.05, 0.12, false]
  ] as const) {
    const leaf = new Mesh(kit.geo.leaf, dark ? kit.mat.leafDark : kit.mat.leaf)
    leaf.scale.set(sx, sy, sx)
    leaf.position.set(x2, y2, z2)
    leaf.castShadow = true
    p.add(leaf)
  }
  parent.add(p)
  return p
}

/** InstancedMesh com uma instância por lugar; a esfera de culling cobre todas. */
export function instanced(parent: Object3D, geo: BufferGeometry, mat: Material, places: readonly Place[], cast = true): InstancedMesh {
  const im = new InstancedMesh(geo, mat, Math.max(1, places.length))
  im.count = places.length
  places.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0)
    dummy.scale.set(p.sx, p.sy, p.sz)
    dummy.updateMatrix()
    im.setMatrixAt(i, dummy.matrix)
    if (p.color) im.setColorAt(i, p.color)
  })
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  im.computeBoundingSphere()
  im.castShadow = cast
  im.receiveShadow = true
  parent.add(im)
  return im
}

/** A marca de LOD efetiva de `o` dentro de `root`: 'detail' se alguém na cadeia é detalhe; senão 'small'; senão nenhuma. */
function effectiveTag(o: Object3D, root: Object3D): LodTag | null {
  let tag: LodTag | null = null
  for (let p: Object3D | null = o; p && p !== root; p = p.parent) {
    const t = p.userData.lod as LodTag | undefined
    if (t === 'detail') return 'detail'
    if (t === 'small') tag = 'small'
  }
  return tag
}

/**
 * Funde as Mesh de `statics` (filho de `zone`) por material, sombra e marca de
 * LOD; as fundidas entram em `zone` e `statics` sai. Devolve as geometrias
 * criadas (quem chama libera no dispose).
 */
export function mergeStatic(zone: Group, statics: Group): BufferGeometry[] {
  zone.updateMatrixWorld(true)
  const inv = new Matrix4().copy(zone.matrixWorld).invert()
  const groups = new Map<string, { mat: Material; cast: boolean; receive: boolean; tag: LodTag | null; geos: BufferGeometry[] }>()
  const local = new Matrix4()
  statics.traverse((o) => {
    if (!(o instanceof Mesh) || o instanceof InstancedMesh || Array.isArray(o.material)) return
    const tag = effectiveTag(o, statics)
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${tag ?? ''}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { mat: o.material, cast: o.castShadow, receive: o.receiveShadow, tag, geos: [] }))
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name)
    geo.applyMatrix4(local.multiplyMatrices(inv, o.matrixWorld))
    g.geos.push(geo)
  })
  const out: BufferGeometry[] = []
  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geos, false)
    for (const geo of g.geos) geo.dispose()
    if (!merged) continue
    merged.computeBoundingSphere()
    merged.computeBoundingBox()
    const m = new Mesh(merged, g.mat)
    m.castShadow = g.cast
    m.receiveShadow = g.receive
    if (g.tag) tagLod(m, g.tag)
    zone.add(m)
    out.push(merged)
  }
  statics.removeFromParent()
  return out
}
