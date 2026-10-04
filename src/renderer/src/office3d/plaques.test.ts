import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mesh, type MeshLambertMaterial } from 'three'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { buildRoom } from './decor'
import { createKit, type Kit } from './kit'
import { layoutOffice, type Office3DLayout } from './layout'

let kit: Kit

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  kit = createKit(1)
})

afterEach(() => {
  kit.dispose()
  vi.restoreAllMocks()
})

function agent(conv: string, roomId: string): OfficeCharacterModel {
  return {
    key: `conv:${conv}`,
    convId: conv,
    roomId,
    role: 'principal',
    placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${conv}`,
    active: false,
    activity: null,
    bubble: null,
    label: ''
  }
}

const office = (projects: Record<string, number>, prev?: Office3DLayout): Office3DLayout =>
  layoutOffice(
    {
      rooms: Object.entries(projects).map(([id, n]) => ({ id, projectKey: id, name: `Projeto ${id}`, icon: id === 'a' ? '🚀' : null, principals: n })),
      characters: Object.entries(projects).flatMap(([id, n]) => Array.from({ length: n }, (_, i) => agent(`${id}${i}`, id)))
    },
    prev
  )

function named(root: Mesh['parent'], name: string): Mesh[] {
  const out: Mesh[] = []
  root?.traverse((o) => {
    if (o instanceof Mesh && o.name === name) out.push(o)
  })
  // A placa das ilhas de trás mora na zona da frente: ordena pela ilha.
  return out.sort((a, b) => a.userData.island - b.userData.island)
}

describe('placas do projeto (plaques.ts)', () => {
  it('placa no chão só nas ilhas reservadas, plaquinha só nas mesas ocupadas, com a textura do projeto (compartilhada entre as mesas dele)', () => {
    const l = office({ a: 2, b: 1 })
    const [r] = l.rooms
    const v = buildRoom(kit, r, () => {})
    v.plaques.sync(r, l.projects)
    const faces = named(v.group, 'plaque-floor')
    expect(faces).toHaveLength(4)
    const reserved = r.islands.filter((i) => i.projectId).map((i) => i.index)
    expect(reserved).toHaveLength(2)
    faces.forEach((f, i) => expect(f.visible).toBe(reserved.includes(i)))
    // Por ilha, uma malha por projeto com as plaquinhas dele (24 vértices por plaquinha), sem sombra.
    const blocks: Mesh[] = []
    v.group.traverse((o) => {
      if (o instanceof Mesh && o.name.startsWith('plaques-desk:')) blocks.push(o)
    })
    const occupied = r.desks.filter((d) => d.projectId)
    expect(blocks.flatMap((b) => b.userData.desks as number[]).sort((x, y) => x - y)).toEqual(occupied.map((d) => d.index))
    for (const b of blocks) {
      const project = b.name.slice('plaques-desk:'.length)
      expect((b.userData.desks as number[]).every((i) => r.desks[i].projectId === project)).toBe(true)
      expect(b.geometry.attributes.position.count).toBe(24 * b.userData.desks.length)
      expect(b.castShadow).toBe(false)
      expect((b.material as MeshLambertMaterial).map).not.toBeNull()
    }
    const matOf = (project: string): Set<unknown> => new Set(blocks.filter((b) => b.name.endsWith(`:${project}`)).map((b) => b.material))
    expect(matOf('a').size).toBe(1)
    expect([...matOf('a')][0]).not.toBe([...matOf('b')][0])
    v.dispose()
  })

  it('quando o último agente do projeto sai, a placa do chão apaga e a textura dele é liberada', () => {
    const before = office({ a: 1, b: 1 })
    const [r0] = before.rooms
    const v = buildRoom(kit, r0, () => {})
    v.plaques.sync(r0, before.projects)
    const islandA = r0.islands.find((i) => i.projectId === 'a')!.index
    const face = named(v.group, 'plaque-floor')[islandA]
    const tex = (face.material as MeshLambertMaterial).map!
    const freed = vi.fn()
    tex.addEventListener('dispose', freed)
    const after = office({ b: 1 }, before)
    expect(after.rooms[0].islands[islandA].projectId).toBeNull()
    v.plaques.sync(after.rooms[0], after.projects)
    expect(face.visible).toBe(false)
    expect(freed).toHaveBeenCalledTimes(1)
    v.dispose()
  })
})
