/**
 * As placas do projeto no escritório (three):
 * - a placa no chão diante de cada ilha: a laje clara é estática (vazia sem
 *   reserva); a face com o nome e o ícone do projeto que reservou a ilha aparece
 *   na reserva e some (textura liberada) quando o último agente dele sai;
 * - a plaquinha de cada mesa ocupada: um bloquinho em pé no canto de fora da
 *   frente da mesa, com o ícone do projeto do dono (fundo neutro, sign.ts) (textura por projeto,
 *   compartilhada pelas mesas dele e liberada quando ele não ocupa mais mesa). As
 *   de um projeto numa ilha são UMA malha (refeita só quando a ocupação muda).
 *
 * Texturas em sign.ts. As plaquinhas de cada ilha ficam num grupo 'small' (somem
 * no LONGE); a face da placa do chão vale em todos os níveis.
 */
import { Group, Mesh, MeshLambertMaterial, Object3D, type BufferGeometry } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { box } from './decorUtil'
import type { Kit } from './kit'
import type { DeskLayout, ProjectLayout, RoomLayout } from './layout'
import { DESK_D, DESK_HEIGHT, deskPoint, ISLAND_PLAQUE_Z, ISLANDS, zoneAt, type ZoneId } from './officePlan'
import { tagLod } from './roomLod'
import { createSignTexture, SIGN_H, SIGN_W, type SignTexture } from './sign'

/** A placa do chão (face 4:1 sobre a laje) e a plaquinha da mesa (lado, espessura). */
const FLOOR_W = 2.3
const FLOOR_D = FLOOR_W / (SIGN_W / SIGN_H)
const SLAB_H = 0.008
const DESK_SIZE = 0.12
const DESK_T = 0.018
/** Onde fica a plaquinha: no canto de fora, perto da borda da frente da mesa (longe dos braços e dos enfeites). */
export const DESK_PLAQUE_X = 0.6
export const DESK_PLAQUE_Z = DESK_D / 2 - 0.18

const dummy = new Object3D()

export interface Plaques {
  /** Placa do chão pela reserva de cada ilha; plaquinha pelo projeto do dono de cada mesa. */
  sync(r: RoomLayout, projects: readonly ProjectLayout[]): void
  dispose(): void
}

interface Painted {
  key: string
  sign: SignTexture
  mat: MeshLambertMaterial
}

function paint(kit: Kit, key: string, name: string, icon: string | null, accentId: string, style: 'floor' | 'desk', onDirty: () => void): Painted {
  const sign = createSignTexture(name, icon, accentId, kit.anisotropy, onDirty, style)
  return { key, sign, mat: new MeshLambertMaterial({ map: sign.texture }) }
}

function release(p: Painted): void {
  p.sign.dispose()
  p.mat.dispose()
}

/** Monta as lajes (estáticas, em `statics` da zona), as faces e as plaquinhas (no grupo da zona). */
export function buildPlaques(kit: Kit, zp: (id: ZoneId) => { group: Group; statics: Group }, onDirty: () => void): Plaques {
  const faces = ISLANDS.map((isl) => {
    // A placa das ilhas de trás cai no piso da zona da frente: entra no culling dela.
    const z = isl.z + ISLAND_PLAQUE_Z
    const { group, statics } = zp(zoneAt(isl.x, z))
    box(kit, statics, kit.mat.plaque, FLOOR_W + 0.12, SLAB_H, FLOOR_D + 0.1, isl.x, 0.006 + SLAB_H / 2, z)
    const face = new Mesh(kit.geo.plane, kit.mat.plaque)
    face.rotation.x = -Math.PI / 2
    face.scale.set(FLOOR_W, FLOOR_D, 1)
    face.position.set(isl.x, 0.006 + SLAB_H + 0.002, z)
    face.receiveShadow = true
    face.visible = false
    face.name = 'plaque-floor'
    face.userData.island = isl.index
    group.add(face)
    return face
  })
  // Plaquinhas: por ilha, UMA malha por projeto com as dele fundidas (1 chamada por projeto à vista, sem sombra).
  const isles = ISLANDS.map((isl) => {
    const group = tagLod(new Group(), 'small')
    group.name = 'plaques-desk'
    zp(isl.zone).group.add(group)
    return { group, sig: '', meshes: [] as Mesh[] }
  })
  const blockGeo = (d: DeskLayout): BufferGeometry => {
    const p = deskPoint(d, d.out * DESK_PLAQUE_X, DESK_PLAQUE_Z)
    dummy.position.set(p.x, DESK_HEIGHT + 0.025 + DESK_SIZE / 2, p.z)
    dummy.rotation.set(0, d.yaw, 0)
    dummy.scale.set(DESK_SIZE, DESK_SIZE, DESK_T)
    dummy.updateMatrix()
    return kit.geo.box.clone().applyMatrix4(dummy.matrix)
  }
  const clear = (isle: (typeof isles)[number]): void => {
    for (const m of isle.meshes) {
      m.removeFromParent()
      m.geometry.dispose()
    }
    isle.meshes = []
  }

  const floor: Array<Painted | null> = ISLANDS.map(() => null)
  const byProject = new Map<string, Painted>()

  return {
    sync(r, projects) {
      for (const isl of r.islands) {
        const face = faces[isl.index]
        const cur = floor[isl.index]
        const key = isl.projectId ? `${isl.projectId}|${isl.name ?? ''}|${isl.icon ?? ''}` : ''
        if ((cur?.key ?? '') === key) continue
        if (cur) release(cur)
        floor[isl.index] = isl.projectId ? paint(kit, key, isl.name ?? isl.projectId, isl.icon, isl.projectId, 'floor', onDirty) : null
        face.material = floor[isl.index]?.mat ?? kit.mat.plaque
        face.visible = !!floor[isl.index]
      }
      const info = new Map(projects.map((p) => [p.id, p]))
      const used = new Set<string>()
      const painted = (id: string): Painted => {
        const p = info.get(id)
        const key = `${id}|${p?.name ?? id}|${p?.icon ?? ''}`
        let cur = byProject.get(id)
        if (cur && cur.key !== key) {
          release(cur)
          cur = undefined
        }
        if (!cur) byProject.set(id, (cur = paint(kit, key, p?.name ?? id, p?.icon ?? null, id, 'desk', onDirty)))
        used.add(id)
        return cur
      }
      isles.forEach((isle, i) => {
        const mine = r.desks.filter((d) => d.island === i && d.projectId)
        const ids = [...new Set(mine.map((d) => d.projectId!))]
        const mats = ids.map(painted)
        const sig = `${mine.map((d) => `${d.index}:${d.projectId}`).join(',')}|${mats.map((m) => m.key).join(',')}`
        if (sig === isle.sig) return
        isle.sig = sig
        clear(isle)
        ids.forEach((id, k) => {
          const own = mine.filter((d) => d.projectId === id)
          const parts = own.map(blockGeo)
          const mesh = new Mesh(mergeGeometries(parts, false)!, mats[k].mat)
          for (const g of parts) g.dispose()
          mesh.name = `plaques-desk:${id}`
          mesh.userData.desks = own.map((d) => d.index)
          isle.group.add(mesh)
          isle.meshes.push(mesh)
        })
      })
      for (const [id, p] of byProject) {
        if (used.has(id)) continue
        release(p)
        byProject.delete(id)
      }
    },
    dispose() {
      for (const isle of isles) clear(isle)
      for (const p of floor) if (p) release(p)
      for (const p of byProject.values()) release(p)
      byProject.clear()
    }
  }
}
