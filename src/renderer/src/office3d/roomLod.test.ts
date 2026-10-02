import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstancedMesh, Matrix4, Mesh, Vector3, type Material, type Object3D } from 'three'
import { buildRoom } from './decor'
import { roomFurniture } from './furniture'
import { createKit, type Kit } from './kit'
import { layoutOffice } from './layout'
import { setRoomLevel } from './roomLod'

let kit: Kit

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  kit = createKit(1)
})

afterEach(() => {
  kit.dispose()
  vi.restoreAllMocks()
})

const room = () => layoutOffice({ rooms: [{ id: 'r0', projectKey: 'r0', name: 'Sala', icon: null, principals: 0 }], characters: [] }).rooms[0]

function meshes(o: Object3D): Mesh[] {
  const out: Mesh[] = []
  o.traverse((x) => {
    if (x instanceof Mesh) out.push(x)
  })
  return out
}

/** Materiais das malhas sob as raízes marcadas. */
const materialsUnder = (roots: readonly Object3D[]): Set<Material> => new Set(roots.flatMap((r) => meshes(r).map((m) => m.material as Material)))

describe('LOD da sala (decor.ts + roomLod.ts)', () => {
  it('detalhes (livros, post-its, xícaras, folhas…) e decoração pequena (luminárias, vasos, rodapés, teclados…) marcados; paredes e mesas não', () => {
    const v = buildRoom(kit, room(), () => {})
    const detail = materialsUnder(v.lod.detail)
    const small = materialsUnder(v.lod.small)
    const m = kit.mat
    for (const mat of [m.book, m.note, m.mug, m.leaf, m.leafDark, m.soil, m.glass, m.redLed, m.greenLed, m.bulb]) expect(detail.has(mat)).toBe(true)
    for (const mat of [m.pot, m.shade, m.metal, m.baseboard, m.keyboard, m.chair, m.coffee]) expect(small.has(mat)).toBe(true)
    for (const mat of [m.wall, m.deskTop, m.deskLeg, m.chairSeat, m.floor, m.rug, m.pufe, m.signFrame, m.door]) {
      expect(detail.has(mat), 'grande não é detalhe').toBe(false)
      expect(small.has(mat), 'grande não é pequeno').toBe(false)
    }
    v.dispose()
  })

  it('MÉDIO esconde os detalhes e tira a sombra dos pequenos; LONGE esconde os pequenos; PERTO restaura tudo', () => {
    const v = buildRoom(kit, room(), () => {})
    const { detail, small, smallCasters } = v.lod
    const walls = meshes(v.group).filter((x) => x.material === kit.mat.wall)
    expect(smallCasters.length).toBeGreaterThan(0)
    expect(setRoomLevel(v.lod, 1)).toBe(true)
    expect(setRoomLevel(v.lod, 1)).toBe(false)
    expect(detail.every((o) => !o.visible)).toBe(true)
    expect(small.every((o) => o.visible)).toBe(true)
    expect(smallCasters.every((c) => !c.castShadow)).toBe(true)
    expect(walls.every((w) => w.castShadow && w.visible)).toBe(true)
    setRoomLevel(v.lod, 2)
    expect(small.every((o) => !o.visible)).toBe(true)
    setRoomLevel(v.lod, 0)
    expect([...detail, ...small].every((o) => o.visible)).toBe(true)
    expect(smallCasters.every((c) => c.castShadow)).toBe(true)
    v.dispose()
  })

  it('InstancedMesh por sala com bounding sphere sobre TODAS as instâncias (culling do three e da sala)', () => {
    const v = buildRoom(kit, room(), () => {})
    const ims = meshes(v.group).filter((x): x is InstancedMesh => x instanceof InstancedMesh)
    expect(ims.length).toBeGreaterThan(8)
    const mat = new Matrix4()
    const p = new Vector3()
    for (const im of ims) {
      expect(im.boundingSphere).not.toBeNull()
      const s = im.boundingSphere!
      expect(v.lod.box.containsPoint(s.center)).toBe(true)
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, mat)
        expect(s.distanceToPoint(p.setFromMatrixPosition(mat))).toBeLessThanOrEqual(1e-6)
      }
    }
    v.dispose()
  })

  it('a caixa da sala cobre a sala, a placa, quem espera do lado de fora da porta e a cabeça de quem está em pé', () => {
    const r = room()
    const v = buildRoom(kit, r, () => {})
    const f = roomFurniture(r)
    const box = v.lod.box
    expect(box.containsPoint(new Vector3(f.doorOut.x, 1.7, f.doorOut.z))).toBe(true)
    expect(box.containsPoint(new Vector3(r.x + r.width / 2, 1.6, r.z + 0.2))).toBe(true)
    expect(box.containsPoint(new Vector3(r.x + r.width - 0.1, 0, r.z + r.depth - 0.1))).toBe(true)
    expect(box.max.y).toBeGreaterThanOrEqual(2.2)
    v.dispose()
  })
})
