import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel, OfficeModel, OfficeRoomModel } from '../office/adapter/model'
import { BESIDE_STEP, EMPTY_LAYOUT, layoutOffice, OFFICE_ID, SEAT_FRONT, type Office3DLayout } from './layout'
import { CENTRAL_SPOT, LOUNGE_SEATS, MEMORY_SPOT_X, PO_SPOTS, STATIONS } from './officePlan'

function room(id: string, principals = 0): OfficeRoomModel {
  return { id, projectKey: id, name: id, icon: null, principals }
}

function principal(conv: string, roomId = 'r1', active = false): OfficeCharacterModel {
  return {
    key: `conv:${conv}`,
    convId: conv,
    roomId,
    role: 'principal',
    placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${conv}`,
    active,
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

const desk = (l: Office3DLayout, key: string): number | null => l.characters.find((c) => c.key === key)?.deskIndex ?? null
const islandOf = (i: number | null): number | null => (i === null ? null : STATIONS[i].island)
const front = (i: number | null): boolean => i !== null && STATIONS[i].front

/** n principais do projeto p (convs p0, p1…). */
const crew = (p: string, n: number, active = false): OfficeCharacterModel[] => Array.from({ length: n }, (_, i) => principal(`${p}${i}`, p, active))

describe('layoutOffice — um escritório para todos os projetos', () => {
  it('escritório vazio: sempre 16 estações fixas (8 de frente, 8 de fundo), 4 ilhas livres e nenhum personagem', () => {
    const l = layoutOffice({ rooms: [], characters: [] })
    expect(l.rooms).toHaveLength(1)
    const [o] = l.rooms
    expect(o.id).toBe(OFFICE_ID)
    expect(o.desks).toHaveLength(16)
    expect(o.desks.filter((d) => d.front)).toHaveLength(8)
    expect(o.desks.filter((d) => d.dir === -1)).toHaveLength(8)
    expect(o.desks.every((d) => d.ownerKey === null && d.projectId === null)).toBe(true)
    expect(o.islands.every((i) => i.projectId === null)).toBe(true)
    expect(l.characters).toHaveLength(0)
    expect(EMPTY_LAYOUT.rooms[0].desks).toHaveLength(16)
  })

  it('senta na mesa: quem fica na frente olha para o monitor de costas para a câmera; no fundo, espelhado', () => {
    const l = layoutOffice({ rooms: [room('r1', 3)], characters: crew('r1', 3) })
    const [a, b, c] = l.characters
    for (const ch of [a, b, c]) {
      const d = STATIONS[ch.deskIndex!]
      expect(ch.roomId).toBe(OFFICE_ID)
      expect(ch.projectId).toBe('r1')
      expect(ch.x).toBe(d.x)
      expect(ch.z).toBeCloseTo(d.z + d.dir * SEAT_FRONT)
      expect(ch.yaw).toBeCloseTo(d.dir === 1 ? 0 : Math.PI)
      expect(ch.screenDesk).toEqual({ roomId: OFFICE_ID, index: ch.deskIndex })
    }
  })

  it('projeto A com 3 agentes: 2 na frente e 1 no fundo da ilha dele (a 1ª na ordem: frente-esquerda)', () => {
    const l = layoutOffice({ rooms: [room('A', 3)], characters: crew('A', 3) })
    const ds = l.characters.map((c) => c.deskIndex)
    expect(ds.map(islandOf)).toEqual([0, 0, 0])
    expect(ds.map(front)).toEqual([true, true, false])
    expect(l.rooms[0].islands[0].projectId).toBe('A')
    expect(l.islandOf).toEqual({ A: [0] })
    expect(l.projects).toEqual([{ id: 'A', name: 'A', icon: null, islands: [0], agents: 3 }])
  })

  it('projetos novos pegam a próxima ilha livre na ordem frente-esquerda, frente-direita, trás-esquerda, trás-direita', () => {
    const m: OfficeModel = { rooms: ['A', 'B', 'C', 'D'].map((p) => room(p, 1)), characters: ['A', 'B', 'C', 'D'].flatMap((p) => crew(p, 1)) }
    const l = layoutOffice(m)
    expect(l.rooms[0].islands.map((i) => i.projectId)).toEqual(['A', 'B', 'C', 'D'])
    expect(l.characters.map((c) => islandOf(c.deskIndex))).toEqual([0, 1, 2, 3])
  })

  it('a ilha do projeto primeiro: com a frente cheia, o 3º vai para o fundo da própria ilha e não para a frente de outra', () => {
    const m: OfficeModel = { rooms: [room('A', 3), room('B', 1)], characters: [...crew('A', 3), ...crew('B', 1)] }
    const l = layoutOffice(m)
    expect(islandOf(desk(l, 'conv:A2'))).toBe(0)
    expect(front(desk(l, 'conv:A2'))).toBe(false)
    expect(islandOf(desk(l, 'conv:B0'))).toBe(1)
  })

  it('ilha cheia: o projeto ganha a frente de uma ilha sem reserva (que passa a ser dele)', () => {
    const l = layoutOffice({ rooms: [room('A', 6)], characters: crew('A', 6) })
    expect(l.characters.slice(4).map((c) => islandOf(c.deskIndex))).toEqual([1, 1])
    expect(l.characters.slice(4).every((c) => front(c.deskIndex))).toBe(true)
    expect(l.projects[0].islands).toEqual([0, 1])
  })

  it('5º projeto: senta nas mesas livres das outras ilhas (frente antes de fundo), com a plaquinha dele na mesa', () => {
    const rooms = ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 1))
    const chars = [...crew('A', 1), ...crew('B', 1), ...crew('C', 1), ...crew('D', 1), ...crew('E', 3)]
    const l = layoutOffice({ rooms, characters: chars })
    const e = ['conv:E0', 'conv:E1', 'conv:E2'].map((k) => desk(l, k))
    expect(e.every((d) => d !== null && front(d))).toBe(true)
    expect(e.map((d) => l.rooms[0].desks[d!].projectId)).toEqual(['E', 'E', 'E'])
    expect(l.projects.find((p) => p.id === 'E')!.islands).toEqual([])
    // As ilhas continuam dos donos.
    expect(l.rooms[0].islands.map((i) => i.projectId)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('o 17º sentado vai para o lounge (3 lugares, os do sofá); com o lounge cheio, fica de pé ao lado da ilha do principal', () => {
    const chars = [...crew('A', 4), ...crew('B', 4), ...crew('C', 4), ...crew('D', 4), ...crew('E', 5)]
    const exec: OfficeCharacterModel = { ...principal('A0', 'A'), key: 'role:A:executor', role: 'executor', placement: { kind: 'seat', seatKind: 'especialista', slot: 'executor' } }
    const l = layoutOffice({ rooms: ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 4)), characters: [...chars, exec] })
    expect(l.rooms[0].desks.every((d) => d.ownerKey !== null)).toBe(true)
    const lounge = l.characters.filter((c) => c.spot === 'lounge')
    expect(lounge.map((c) => c.lounge)).toEqual([0, 1, 2])
    lounge.forEach((c, i) => expect([c.x, c.z]).toEqual([LOUNGE_SEATS[i].x, LOUNGE_SEATS[i].z]))
    // O executor da conversa A0 (lounge cheio): de pé ao lado da ilha do principal dele (a 0).
    const ex = l.characters.find((c) => c.key === 'role:A:executor')!
    expect(ex.spot).toBe('stand')
    expect(Math.abs(ex.x - -4.25)).toBeCloseTo(2.15)
  })

  it('ninguém é empurrado do lounge: quem já estava sentado nele fica, mesmo que alguém antes na ordem do modelo chegue depois', () => {
    const rooms = ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 4))
    const crews = [...crew('A', 4), ...crew('B', 4), ...crew('C', 4), ...crew('D', 4)]
    const one = layoutOffice({ rooms, characters: [...crews, ...crew('E', 4)] })
    const seated = (l: Office3DLayout): string[] => l.characters.filter((c) => c.spot === 'lounge').map((c) => c.key)
    expect(seated(one)).toEqual(['conv:E0', 'conv:E1', 'conv:E2'])
    // O executor da conversa A0 chega (vem antes dos de E no modelo): o lounge está cheio, ele fica de pé.
    const exec: OfficeCharacterModel = { ...principal('A0', 'A'), key: 'role:A:executor', role: 'executor', placement: { kind: 'seat', seatKind: 'especialista', slot: 'executor' } }
    const two = layoutOffice({ rooms, characters: [...crews, exec, ...crew('E', 4)] }, one)
    expect(seated(two)).toEqual(['conv:E0', 'conv:E1', 'conv:E2'])
    expect(two.characters.filter((c) => c.spot === 'lounge').map((c) => c.lounge)).toEqual(one.characters.filter((c) => c.spot === 'lounge').map((c) => c.lounge))
    expect(two.characters.find((c) => c.key === 'role:A:executor')!.spot).toBe('stand')
    // Um de E sai: o lugar vago vai para quem estava de pé.
    const three = layoutOffice({ rooms, characters: [...crews, exec, ...crew('E', 3)] }, two)
    expect(three.characters.find((c) => c.key === 'role:A:executor')!.lounge).toBe(two.characters.find((c) => c.key === 'conv:E3')!.lounge)
  })

  it('ninguém é empurrado: quem já tinha mesa fica com ela mesmo que um projeto "dono" chegue depois', () => {
    const one = layoutOffice({ rooms: [room('A', 1), room('E', 1)], characters: [...crew('E', 1)] })
    expect(islandOf(desk(one, 'conv:E0'))).toBe(0)
    const two = layoutOffice({ rooms: [room('A', 1), room('E', 1)], characters: [...crew('A', 1), ...crew('E', 1)] }, one)
    expect(desk(two, 'conv:E0')).toBe(desk(one, 'conv:E0'))
    expect(islandOf(desk(two, 'conv:A0'))).toBe(1)
  })

  it('fundo → frente assim que a frente da ilha vaga (mesmo no meio de um turno): a tela fica virada para a câmera', () => {
    const m3 = (active: boolean[]): OfficeModel => ({ rooms: [room('A', 3)], characters: crew('A', 3).map((c, i) => ({ ...c, active: active[i] })) })
    const one = layoutOffice(m3([false, false, true]))
    expect(front(desk(one, 'conv:A2'))).toBe(false)
    // Com a frente cheia, continua no fundo.
    expect(desk(layoutOffice(m3([false, false, true]), one), 'conv:A2')).toBe(desk(one, 'conv:A2'))
    // A0 sai do escritório: a frente dele vaga e A2 (trabalhando) muda para ela, na mesma ilha.
    const two = layoutOffice({ rooms: [room('A', 2)], characters: m3([false, false, true]).characters.slice(1) }, one)
    expect(front(desk(two, 'conv:A2'))).toBe(true)
    expect(islandOf(desk(two, 'conv:A2'))).toBe(0)
    expect(desk(two, 'conv:A1')).toBe(desk(one, 'conv:A1'))
  })

  it('a reserva acaba com o último agente do projeto: a ilha fica livre e a placa apaga', () => {
    const one = layoutOffice({ rooms: [room('A', 1), room('B', 1)], characters: [...crew('A', 1), ...crew('B', 1)] })
    expect(one.rooms[0].islands.map((i) => i.projectId)).toEqual(['A', 'B', null, null])
    const two = layoutOffice({ rooms: [room('B', 1)], characters: crew('B', 1) }, one)
    expect(two.rooms[0].islands.map((i) => i.projectId)).toEqual([null, 'B', null, null])
    expect(two.islandOf).toEqual({ B: [1] })
    const three = layoutOffice({ rooms: [room('B', 1), room('C', 1)], characters: [...crew('B', 1), ...crew('C', 1)] }, two)
    expect(three.rooms[0].islands.map((i) => i.projectId)).toEqual(['C', 'B', null, null])
  })

  it('mesa estável entre feeds e reserva estável enquanto o projeto existe', () => {
    const m: OfficeModel = { rooms: [room('A', 2), room('B', 2)], characters: [...crew('A', 2), ...crew('B', 2)] }
    const one = layoutOffice(m)
    const two = layoutOffice({ rooms: [room('B', 2), room('A', 2)], characters: [...crew('B', 2), ...crew('A', 2)] }, one)
    for (const c of one.characters) expect(desk(two, c.key)).toBe(c.deskIndex)
    expect(two.islandOf).toEqual(one.islandOf)
  })

  it('é determinístico', () => {
    const m: OfficeModel = { rooms: [room('r1', 2), room('r2', 1)], characters: [principal('a'), principal('b'), principal('c', 'r2')] }
    expect(layoutOffice(m)).toEqual(layoutOffice(m))
  })

  it('subagente fica ao lado do pai, alternando os lados, com o monitor e o projeto do pai', () => {
    const l = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('a'), sub('t1', 'conv:a'), sub('t2', 'conv:a')] })
    const [p, s1, s2] = l.characters
    expect(s1.x).toBeCloseTo(p.x + BESIDE_STEP)
    expect(s2.x).toBeCloseTo(p.x - BESIDE_STEP)
    expect(s1.deskIndex).toBeNull()
    expect(s1.screenDesk).toEqual(p.screenDesk)
    expect(s1.projectId).toBe('r1')
  })

  it('subagente sem pai no modelo não aparece', () => {
    const l = layoutOffice({ rooms: [room('r1')], characters: [sub('t1', 'conv:sumiu')] })
    expect(l.characters).toHaveLength(0)
  })

  it('lugares fixos: PO junto do kanban, memória na estante de Memórias, Central no console (sem mesa)', () => {
    const po: OfficeCharacterModel = { ...principal('a'), key: 'po:r1', role: 'po', placement: { kind: 'destination', papel: 'kanban' } }
    const mem: OfficeCharacterModel = { ...principal('a'), key: 'role:r1:memoria', role: 'memoria', placement: { kind: 'destination', papel: 'arquivo-memorias' } }
    const central: OfficeCharacterModel = { ...principal('central'), roomId: null, placement: { kind: 'destination', papel: 'central' } }
    const l = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('a'), po, mem, central] })
    const at = (k: string): { x: number; z: number; deskIndex: number | null; spot: string } => l.characters.find((c) => c.key === k)!
    expect([at('po:r1').x, at('po:r1').z, at('po:r1').spot]).toEqual([PO_SPOTS[0].x, PO_SPOTS[0].z, 'po'])
    expect([at('role:r1:memoria').x, at('role:r1:memoria').spot]).toEqual([MEMORY_SPOT_X, 'memory'])
    expect([at('conv:central').x, at('conv:central').z, at('conv:central').deskIndex]).toEqual([CENTRAL_SPOT.x, CENTRAL_SPOT.z, null])
    expect(l.characters.find((c) => c.key === 'conv:central')!.projectId).toBeNull()
    expect(l.rooms[0].desks.filter((d) => d.ownerKey !== null)).toHaveLength(1)
  })

  it('mesa liberada volta a ser usada', () => {
    const one = layoutOffice({ rooms: [room('r1', 2)], characters: [principal('a'), principal('b')] })
    const two = layoutOffice({ rooms: [room('r1', 1)], characters: [principal('b')] }, one)
    const three = layoutOffice({ rooms: [room('r1', 2)], characters: [principal('b'), principal('c')] }, two)
    expect(desk(three, 'conv:b')).toBe(desk(one, 'conv:b'))
    expect(desk(three, 'conv:c')).toBe(desk(one, 'conv:a'))
  })
})
