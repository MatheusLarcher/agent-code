import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel, OfficeModel, OfficeRoomModel } from '../office/adapter/model'
import { BESIDE_STEP, DESK_COLS, gridCell, layoutOffice, MIN_DESKS, ROOM_GAP, ROOM_WIDTH } from './layout'

function room(id: string, principals = 0): OfficeRoomModel {
  return { id, projectKey: id, name: id, icon: null, principals }
}

function principal(conv: string, roomId = 'r1'): OfficeCharacterModel {
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

function sub(track: string, parent: string, roomId = 'r1'): OfficeCharacterModel {
  return {
    ...principal('x', roomId),
    key: `track:${track}`,
    role: 'subagente',
    trackId: track,
    placement: { kind: 'beside', parentKey: parent },
    seed: `track:${track}`
  }
}

describe('layoutOffice', () => {
  it('sala vazia tem o mínimo de mesas e nenhum personagem', () => {
    const l = layoutOffice({ rooms: [room('r1')], characters: [] })
    expect(l.rooms).toHaveLength(1)
    expect(l.rooms[0].desks).toHaveLength(MIN_DESKS)
    expect(l.rooms[0].desks.every((d) => d.ownerKey === null)).toBe(true)
    expect(l.characters).toHaveLength(0)
  })

  it('um agente senta na primeira mesa, na frente do monitor', () => {
    const l = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('a')] })
    const [c] = l.characters
    const desk = l.rooms[0].desks[0]
    expect(c.deskIndex).toBe(0)
    expect(desk.ownerKey).toBe('conv:a')
    expect(c.x).toBe(desk.x)
    expect(c.z).toBeGreaterThan(desk.z)
  })

  it('vários agentes: mesas = max(4, sentados) e posições distintas', () => {
    const chars = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => principal(id))
    const l = layoutOffice({ rooms: [room('r1', 6)], characters: chars })
    expect(l.rooms[0].desks).toHaveLength(6)
    const spots = new Set(l.characters.map((c) => `${c.x},${c.z}`))
    expect(spots.size).toBe(6)
    // Quinta mesa abre a segunda fileira.
    expect(l.characters[DESK_COLS].z).toBeGreaterThan(l.characters[0].z)
  })

  it('é determinístico', () => {
    const m: OfficeModel = { rooms: [room('r1', 2), room('r2', 1)], characters: [principal('a'), principal('b'), principal('c', 'r2')] }
    expect(layoutOffice(m)).toEqual(layoutOffice(m))
  })

  it('subagente fica ao lado do pai, alternando os lados', () => {
    const l = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('a'), sub('t1', 'conv:a'), sub('t2', 'conv:a')] })
    const [p, s1, s2] = l.characters
    expect(s1.x).toBeCloseTo(p.x + BESIDE_STEP)
    expect(s2.x).toBeCloseTo(p.x - BESIDE_STEP)
    expect(s1.deskIndex).toBeNull()
    expect(s1.screenDesk).toEqual(p.screenDesk)
  })

  it('subagente sem pai no modelo não aparece', () => {
    const l = layoutOffice({ rooms: [room('r1')], characters: [sub('t1', 'conv:sumiu')] })
    expect(l.characters).toHaveLength(0)
  })

  it('quem entra não move quem já estava (nem a sala)', () => {
    const first = layoutOffice({ rooms: [room('r2', 1)], characters: [principal('a', 'r2')] })
    const a0 = first.characters[0]
    // b entra ANTES de a na ordem do modelo, e uma sala nova aparece antes.
    const second = layoutOffice(
      { rooms: [room('r1', 1), room('r2', 2)], characters: [principal('z', 'r1'), principal('b', 'r2'), principal('a', 'r2')] },
      first
    )
    const a1 = second.characters.find((c) => c.key === 'conv:a')!
    expect([a1.x, a1.z, a1.deskIndex]).toEqual([a0.x, a0.z, a0.deskIndex])
    const b = second.characters.find((c) => c.key === 'conv:b')!
    expect(b.deskIndex).toBe(1)
    expect(second.rooms.find((r) => r.id === 'r2')!.x).toBe(first.rooms[0].x)
  })

  it('5 salas ficam em grade de ceil(sqrt(5)) = 3 colunas × 2 linhas, sem sobrepor', () => {
    const rooms = ['a', 'b', 'c', 'd', 'e'].map((id) => room(id))
    const l = layoutOffice({ rooms, characters: [] })
    const xs = new Set(l.rooms.map((r) => r.x))
    const zs = new Set(l.rooms.map((r) => r.z))
    expect(xs.size).toBe(3)
    expect(zs.size).toBe(2)
    expect(l.rooms.map((r) => [r.x / (ROOM_WIDTH + ROOM_GAP), r.z === 0 ? 0 : 1])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0]
    ])
    for (const r of l.rooms)
      for (const o of l.rooms) {
        if (r === o) continue
        const apart = r.x + r.width <= o.x || o.x + o.width <= r.x || r.z + r.depth <= o.z || o.z + o.depth <= r.z
        expect(apart).toBe(true)
      }
    expect(layoutOffice({ rooms, characters: [] })).toEqual(l)
  })

  it('gridCell: n salas usam ceil(sqrt(n)) colunas', () => {
    for (let n = 1; n <= 30; n++) {
      const cols = new Set(Array.from({ length: n }, (_, s) => gridCell(s).col)).size
      expect(cols).toBe(Math.ceil(Math.sqrt(n)))
    }
  })

  it('sala nova na grade não move as que já estavam', () => {
    const four = layoutOffice({ rooms: ['a', 'b', 'c', 'd'].map((id) => room(id)), characters: [] })
    const five = layoutOffice({ rooms: ['a', 'b', 'c', 'd', 'e'].map((id) => room(id)), characters: [] }, four)
    for (const r of four.rooms) {
      const n = five.rooms.find((x) => x.id === r.id)!
      expect([n.x, n.z]).toEqual([r.x, r.z])
    }
  })

  it('linha seguinte começa depois da sala mais funda da linha anterior', () => {
    const chars = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => principal(id, 'b'))
    const l = layoutOffice({ rooms: [room('a'), room('b', 5), room('c')], characters: chars })
    const b = l.rooms.find((r) => r.id === 'b')!
    const c = l.rooms.find((r) => r.id === 'c')!
    expect(c.z).toBe(b.depth + ROOM_GAP)
  })

  it('mesa liberada volta a ser usada', () => {
    const one = layoutOffice({ rooms: [room('r1', 2)], characters: [principal('a'), principal('b')] })
    const two = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('b')] }, one)
    const three = layoutOffice({ rooms: [room('r1', 2)], characters: [principal('b'), principal('c')] }, two)
    expect(three.characters.find((c) => c.key === 'conv:b')!.deskIndex).toBe(1)
    expect(three.characters.find((c) => c.key === 'conv:c')!.deskIndex).toBe(0)
  })
})
