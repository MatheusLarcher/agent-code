import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Box3, InstancedMesh, Matrix4, Mesh, Vector3, type Material, type Object3D } from 'three'
import { buildRoom, type RoomView } from './decor'
import { roomFurniture } from './furniture'
import { createKit, type Kit } from './kit'
import { layoutOffice } from './layout'
import { ZONE_IDS } from './officePlan'
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
const allDetail = (v: RoomView): Object3D[] => v.zones.flatMap((z) => [...z.lod.detail])
const allSmall = (v: RoomView): Object3D[] => v.zones.flatMap((z) => [...z.lod.small])

describe('LOD por zona do escritório (decor.ts + roomLod.ts)', () => {
  it('as zonas: casca, 4 ilhas, praça, lounge e sala de reunião, cada uma com grupo e caixa próprios', () => {
    const v = buildRoom(kit, room(), () => {})
    expect(v.zones.map((z) => z.id).sort()).toEqual([...ZONE_IDS].sort())
    for (const z of v.zones) {
      expect(z.group.parent).toBe(v.group)
      expect(z.lod.box.isEmpty()).toBe(false)
    }
    v.dispose()
  })

  it('detalhes (xícaras, LEDs, lâmpadas, vidro, fichários…) e decoração pequena (vasos, plantas, rodapés, teclados, pés de cadeira, trilhas…) marcados; paredes e mesas não', () => {
    const v = buildRoom(kit, room(), () => {})
    const detail = materialsUnder(allDetail(v))
    const small = materialsUnder(allSmall(v))
    const m = kit.mat
    for (const mat of [m.mug, m.redLed, m.greenLed, m.bulb, m.pane, m.binder]) expect(detail.has(mat), 'detalhe').toBe(true)
    // Nenhum post-it sorteado: o quadro é o kanban real (board/), fora da decoração.
    expect(detail.has(m.note)).toBe(false)
    for (const mat of [m.pot, m.leaf, m.metal, m.baseboard, m.keyboard, m.chair, m.coffee, m.trail]) expect(small.has(mat), 'pequeno').toBe(true)
    for (const mat of [m.wall, m.deskTop, m.deskLeg, m.chairSeat, m.floor, m.door, m.sofa, m.felt]) {
      expect(detail.has(mat), 'grande não é detalhe').toBe(false)
      expect(small.has(mat), 'grande não é pequeno').toBe(false)
    }
    v.dispose()
  })

  it('MÉDIO esconde os detalhes e tira a sombra dos pequenos; LONGE esconde os pequenos; PERTO restaura tudo (zona a zona)', () => {
    const v = buildRoom(kit, room(), () => {})
    const walls = meshes(v.group).filter((x) => x.material === kit.mat.wall)
    for (const z of v.zones) {
      const { detail, small, smallCasters } = z.lod
      expect(setRoomLevel(z.lod, 1)).toBe(true)
      expect(setRoomLevel(z.lod, 1)).toBe(false)
      expect(detail.every((o) => !o.visible)).toBe(true)
      expect(small.every((o) => o.visible)).toBe(true)
      expect(smallCasters.every((c) => !c.castShadow)).toBe(true)
      setRoomLevel(z.lod, 2)
      expect(small.every((o) => !o.visible)).toBe(true)
      setRoomLevel(z.lod, 0)
      expect([...detail, ...small].every((o) => o.visible)).toBe(true)
      expect(smallCasters.every((c) => c.castShadow)).toBe(true)
    }
    expect(v.zones.some((z) => z.lod.smallCasters.length > 0)).toBe(true)
    expect(walls.every((w) => w.castShadow && w.visible)).toBe(true)
    v.dispose()
  })

  it('mobília fundida POR ZONA: poucas malhas por zona e nenhuma malha passa da caixa da zona dela', () => {
    const v = buildRoom(kit, room(), () => {})
    const box = new Box3()
    for (const z of v.zones) {
      const ms = meshes(z.group)
      expect(ms.length, z.id).toBeLessThan(60)
      if (z.id === 'shell') continue
      for (const m of ms) {
        if (m instanceof InstancedMesh || !m.geometry.boundingBox) continue
        box.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld)
        expect(z.lod.box.containsBox(box), `${z.id}: ${(m.material as Material).name || m.name}`).toBe(true)
      }
    }
    v.dispose()
  })

  it('InstancedMesh por zona com bounding sphere sobre TODAS as instâncias (as cadeiras recuadas inclusive)', () => {
    const v = buildRoom(kit, room(), () => {})
    const mat = new Matrix4()
    const p = new Vector3()
    let count = 0
    for (const z of v.zones) {
      const ims = meshes(z.group).filter((x): x is InstancedMesh => x instanceof InstancedMesh)
      for (const im of ims) {
        count++
        expect(im.boundingSphere).not.toBeNull()
        const s = im.boundingSphere!
        expect(z.lod.box.containsPoint(s.center)).toBe(true)
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, mat)
          expect(s.distanceToPoint(p.setFromMatrixPosition(mat))).toBeLessThanOrEqual(1e-6)
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(12)
    v.dispose()
  })

  it('a caixa da zona da porta cobre quem espera do lado de fora; a da casca cobre o escritório e a cabeça de quem está em pé', () => {
    const r = room()
    const v = buildRoom(kit, r, () => {})
    const f = roomFurniture(r)
    expect(v.doorZone.lod.box.containsPoint(new Vector3(f.doorOut.x, 1.7, f.doorOut.z))).toBe(true)
    const shell = v.zone('shell').lod.box
    expect(shell.containsPoint(new Vector3(r.x + 0.1, 0, r.z + 0.1))).toBe(true)
    expect(shell.containsPoint(new Vector3(r.x + r.width - 0.1, 2.2, r.z + r.depth - 0.1))).toBe(true)
    expect(shell.max.y).toBeGreaterThanOrEqual(2.8)
    v.dispose()
  })
})
