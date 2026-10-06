import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel, OfficeModel, OfficeRoomModel } from '../office/adapter/model'
import { BESIDE_STEP, EMPTY_LAYOUT, layoutOffice, OFFICE_ID, SEAT_FRONT, type Office3DLayout } from './layout'
import { CENTRAL_SPOT, deskPoint, DOOR, ISLANDS, islandSideSpots, LOUNGE_SEATS, MEMORY_SPOT_X, OFFICE, PO_SPOTS, STATIONS } from './officePlan'

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
/** A posição no U (0..5) da mesa; null sem mesa. */
const kOf = (i: number | null): number | null => (i === null ? null : STATIONS[i].k)

/** n principais do projeto p (convs p0, p1…). */
const crew = (p: string, n: number, active = false): OfficeCharacterModel[] => Array.from({ length: n }, (_, i) => principal(`${p}${i}`, p, active))

describe('layoutOffice — um escritório para todos os projetos', () => {
  it('escritório vazio: sempre 24 estações fixas (4 ilhas em U de 6, toda tela para a câmera), 4 ilhas livres e nenhum personagem', () => {
    const l = layoutOffice({ rooms: [], characters: [] })
    expect(l.rooms).toHaveLength(1)
    const [o] = l.rooms
    expect(o.id).toBe(OFFICE_ID)
    expect(o.desks).toHaveLength(24)
    // O fundo do U reto; os 4 braços de cada ilha inclinados para dentro.
    expect(o.desks.filter((d) => d.yaw === 0)).toHaveLength(8)
    expect(o.desks.filter((d) => Math.abs(d.yaw) > 0.27 && Math.abs(d.yaw) < 0.35)).toHaveLength(16)
    expect(o.desks.every((d) => d.ownerKey === null && d.projectId === null)).toBe(true)
    expect(o.islands.every((i) => i.projectId === null)).toBe(true)
    expect(l.characters).toHaveLength(0)
    expect(EMPTY_LAYOUT.rooms[0].desks).toHaveLength(24)
  })

  it('senta na mesa: na cadeira girada com ela, olhando para o monitor (o yaw da mesa), inclusive nos braços do U', () => {
    const l = layoutOffice({ rooms: [room('r1', 6)], characters: crew('r1', 6) })
    expect(l.characters.map((c) => kOf(c.deskIndex))).toEqual([0, 1, 2, 3, 4, 5])
    for (const ch of l.characters) {
      const d = STATIONS[ch.deskIndex!]
      const seat = deskPoint(d, 0, SEAT_FRONT)
      expect(ch.roomId).toBe(OFFICE_ID)
      expect(ch.projectId).toBe('r1')
      expect(ch.x).toBeCloseTo(seat.x)
      expect(ch.z).toBeCloseTo(seat.z)
      expect(ch.yaw).toBeCloseTo(d.yaw)
      expect(Math.hypot(ch.x - d.x, ch.z - d.z)).toBeCloseTo(SEAT_FRONT)
      expect(ch.screenDesk).toEqual({ roomId: OFFICE_ID, index: ch.deskIndex })
    }
  })

  it('projeto A com 3 agentes: o fundo do U e o 1º braço da ilha dele (a 1ª na ordem: frente-esquerda)', () => {
    const l = layoutOffice({ rooms: [room('A', 3)], characters: crew('A', 3) })
    const ds = l.characters.map((c) => c.deskIndex)
    expect(ds.map(islandOf)).toEqual([0, 0, 0])
    expect(ds.map(kOf)).toEqual([0, 1, 2])
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

  it('a ilha do projeto primeiro: o 6º ainda fica na própria ilha (braço da frente) e não vai para outra', () => {
    const m: OfficeModel = { rooms: [room('A', 6), room('B', 1)], characters: [...crew('A', 6), ...crew('B', 1)] }
    const l = layoutOffice(m)
    expect(islandOf(desk(l, 'conv:A5'))).toBe(0)
    expect(kOf(desk(l, 'conv:A5'))).toBe(5)
    expect(islandOf(desk(l, 'conv:B0'))).toBe(1)
  })

  it('ilha cheia: o projeto NÃO ganha uma 2ª ilha — os que sobram vão para o lounge e as outras ilhas ficam livres', () => {
    const l = layoutOffice({ rooms: [room('A', 8)], characters: crew('A', 8) })
    expect(l.characters.slice(6).map((c) => c.deskIndex)).toEqual([null, null])
    expect(l.characters.slice(6).map((c) => c.spot)).toEqual(['lounge', 'lounge'])
    expect(l.projects[0].islands).toEqual([0])
    expect(l.rooms[0].islands.map((i) => i.projectId)).toEqual(['A', null, null, null])
  })

  it('5º projeto (a demo tem 5): sem ilha livre, não senta na ilha de outro — vai para o lounge; cada ilha só com um projeto', () => {
    const rooms = ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 1))
    const chars = [...crew('A', 1), ...crew('B', 1), ...crew('C', 1), ...crew('D', 1), ...crew('E', 3)]
    const l = layoutOffice({ rooms, characters: chars })
    const e = l.characters.filter((c) => c.projectId === 'E')
    expect(e.map((c) => c.deskIndex)).toEqual([null, null, null])
    expect(e.map((c) => c.spot)).toEqual(['lounge', 'lounge', 'lounge'])
    expect(l.projects.find((p) => p.id === 'E')!.islands).toEqual([])
    expect(l.rooms[0].islands.map((i) => i.projectId)).toEqual(['A', 'B', 'C', 'D'])
    for (const d of l.rooms[0].desks) if (d.projectId) expect(d.projectId).toBe(l.rooms[0].islands[d.island].projectId)
  })

  it('nenhum projeto em duas ilhas, mesmo vindo de um layout antigo que o espalhava', () => {
    const one = layoutOffice({ rooms: [room('A', 2)], characters: crew('A', 2) })
    const old: Office3DLayout = { ...one, islandOf: { A: [0, 1] }, deskOf: { ...one.deskOf, 'conv:A1': STATIONS.find((s) => s.island === 1)!.index } }
    const two = layoutOffice({ rooms: [room('A', 2)], characters: crew('A', 2) }, old)
    expect(two.islandOf).toEqual({ A: [0] })
    expect(two.characters.map((c) => islandOf(c.deskIndex))).toEqual([0, 0])
  })

  it('o 25º sentado vai para o lounge (3 lugares, os do sofá); com o lounge cheio, fica de pé dentro do U da ilha do principal', () => {
    const chars = [...crew('A', 6), ...crew('B', 6), ...crew('C', 6), ...crew('D', 6), ...crew('E', 5)]
    const exec: OfficeCharacterModel = { ...principal('A0', 'A'), key: 'role:A:executor', role: 'executor', placement: { kind: 'seat', seatKind: 'especialista', slot: 'executor' } }
    const l = layoutOffice({ rooms: ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 6)), characters: [...chars, exec] })
    expect(l.rooms[0].desks.every((d) => d.ownerKey !== null)).toBe(true)
    const lounge = l.characters.filter((c) => c.spot === 'lounge')
    expect(lounge.map((c) => c.lounge)).toEqual([0, 1, 2])
    lounge.forEach((c, i) => expect([c.x, c.z]).toEqual([LOUNGE_SEATS[i].x, LOUNGE_SEATS[i].z]))
    // O executor da conversa A0 (lounge cheio): de pé dentro do U da ilha do principal dele (a 0).
    const ex = l.characters.find((c) => c.key === 'role:A:executor')!
    expect(ex.spot).toBe('stand')
    expect([ex.x, ex.z]).toEqual([islandSideSpots(0)[0].x, islandSideSpots(0)[0].z])
    expect(Math.abs(ex.x - ISLANDS[0].x)).toBeLessThan(1)
  })

  it('ninguém é empurrado do lounge: quem já estava sentado nele fica, mesmo que alguém antes na ordem do modelo chegue depois', () => {
    const rooms = ['A', 'B', 'C', 'D', 'E'].map((p) => room(p, 6))
    const crews = [...crew('A', 6), ...crew('B', 6), ...crew('C', 6), ...crew('D', 6)]
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

  it('sem "fundo → frente": toda tela olha para a câmera, então quem tem mesa fica nela quando outra vaga (mesmo trabalhando)', () => {
    const m3 = (active: boolean[]): OfficeModel => ({ rooms: [room('A', 3)], characters: crew('A', 3).map((c, i) => ({ ...c, active: active[i] })) })
    const one = layoutOffice(m3([false, false, true]))
    // A0 sai do escritório: a mesa dele (o fundo do U) vaga, e A2 (trabalhando) continua no braço.
    const two = layoutOffice({ rooms: [room('A', 2)], characters: m3([false, false, true]).characters.slice(1) }, one)
    expect(desk(two, 'conv:A2')).toBe(desk(one, 'conv:A2'))
    expect(desk(two, 'conv:A1')).toBe(desk(one, 'conv:A1'))
    // Quem chega depois pega a mesa vaga (a 1ª na ordem do U).
    const three = layoutOffice({ rooms: [room('A', 3)], characters: [...m3([false, false, true]).characters.slice(1), principal('A9', 'A')] }, two)
    expect(desk(three, 'conv:A9')).toBe(desk(one, 'conv:A0'))
  })

  it('fora de cena (o Manager de um plano já enviado): do lado de fora da porta, sem mesa', () => {
    const gone: OfficeCharacterModel = { ...principal('m', 'A'), offstage: true }
    const l = layoutOffice({ rooms: [room('A', 2)], characters: [gone, principal('a', 'A')] })
    const m = l.characters.find((c) => c.key === 'conv:m')!
    expect(m.spot).toBe('offstage')
    expect([m.x, m.z]).toEqual([OFFICE.x1 + 1, DOOR.z])
    expect(m.deskIndex).toBeNull()
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
